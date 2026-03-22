import asyncio
import base64
import logging
import os
import queue
import threading
import time
import wave

import numpy as np

from claude_voice.tts_engine import TTSEngine, SAMPLE_RATE
from claude_voice.audio_player import AudioPlayer

logger = logging.getLogger(__name__)
perf_logger = logging.getLogger("claude_voice.perf")

DEBUG_DUMP = os.getenv("TTS_DEBUG_DUMP", "").lower() in ("1", "true", "yes")
DUMP_DIR = os.path.expanduser("~/Desktop/tts_debug")


_main_loop = None


def set_main_loop(loop):
    """Store reference to the main asyncio event loop for cross-thread broadcasts."""
    global _main_loop
    _main_loop = loop


def _fire_async(coro):
    """Run an async coroutine from sync code, safely across threads."""
    try:
        loop = asyncio.get_running_loop()
        asyncio.ensure_future(coro, loop=loop)
    except RuntimeError:
        # No running loop in this thread — schedule on the main event loop
        if _main_loop and _main_loop.is_running():
            asyncio.run_coroutine_threadsafe(coro, _main_loop)
        else:
            # Fallback: temp loop (only during tests or startup)
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(coro)
            finally:
                loop.close()


class SpeakPipeline:
    def __init__(self, tts_engine: TTSEngine, audio_player: AudioPlayer, broadcaster=None):
        self.tts = tts_engine
        self.player = audio_player
        self.broadcaster = broadcaster
        self.audio_broadcaster = None
        self._speaking_count = 0
        self._speaking_lock = threading.Lock()
        self._muted = False

    def _broadcast(self, data: dict):
        if self.broadcaster:
            _fire_async(self.broadcaster.broadcast(data))

    def _broadcast_audio(self, data: dict):
        if self.audio_broadcaster:
            _fire_async(self.audio_broadcaster.broadcast(data))

    def _broadcast_pcm(self, audio: np.ndarray, sr: int):
        """Encode float32 PCM as base64 and broadcast to avatar."""
        self._broadcast_audio({
            "pcm": base64.b64encode(audio.astype(np.float32).tobytes()).decode(),
            "sr": sr,
            "fmt": "f32"
        })

    def _start_speaking(self):
        """Increment speaking counter and always broadcast speaking state.

        Always broadcasts speaking=True (idempotent for avatar) so that
        overlapping audio (cue + speak) never causes a missed notification.
        """
        with self._speaking_lock:
            self._speaking_count += 1
            self._broadcast({"speaking": True})

    def _stop_speaking(self):
        """Decrement speaking counter and broadcast only when nothing is playing."""
        with self._speaking_lock:
            self._speaking_count = max(0, self._speaking_count - 1)
            if self._speaking_count == 0:
                self._broadcast({"speaking": False})

    @property
    def is_speaking(self) -> bool:
        return self._speaking_count > 0

    def speak(self, text: str):
        """Generate and broadcast audio for text (full batch mode)."""
        e2e_start = time.perf_counter()
        audio, sr = self.tts.generate(text)
        if len(audio) > 0:
            if DEBUG_DUMP:
                self._dump_wav(audio, sr, text)

            duration = len(audio) / sr
            self._start_speaking()
            self._broadcast({"text": text, "duration": round(duration, 2)})

            # Broadcast PCM to avatar for playback (respects mute)
            if not self._muted:
                self._broadcast_pcm(audio, sr)

            # Interruptible wait so /stop can cancel
            self.player.interruptible_sleep(duration)
            self._stop_speaking()

            e2e_elapsed = time.perf_counter() - e2e_start
            perf_logger.info(
                "Pipeline full e2e: %.0fms total, text: \"%s\"",
                e2e_elapsed * 1000, text[:80]
            )

    def speak_chunked(self, text: str, leadin_audio: np.ndarray | None = None):
        """Generate and broadcast audio chunk by chunk."""
        e2e_start = time.perf_counter()
        first_chunk_time = None
        chunk_queue: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=2)

        def generator():
            try:
                for chunk, _sr in self.tts.generate_stream(text):
                    chunk_queue.put(chunk)
            except Exception:
                logger.exception("Chunked generation failed")
            finally:
                chunk_queue.put(None)

        gen_thread = threading.Thread(target=generator, daemon=True)
        gen_thread.start()

        self._start_speaking()
        self._broadcast({"text": text, "duration": 0})
        total_samples = 0
        broadcast_start = time.perf_counter()

        try:
            # Broadcast lead-in immediately
            if leadin_audio is not None and len(leadin_audio) > 0 and not self._muted:
                perf_logger.info("Pipeline lead-in: %d samples (%.0fms)",
                                 len(leadin_audio), len(leadin_audio) / SAMPLE_RATE * 1000)
                self._broadcast_pcm(leadin_audio, SAMPLE_RATE)
                total_samples += len(leadin_audio)

            while True:
                try:
                    chunk = chunk_queue.get(timeout=30)
                except queue.Empty:
                    logger.warning("TTS chunk generation timed out (30s)")
                    break
                if chunk is None:
                    break
                if len(chunk) == 0:
                    continue

                if not first_chunk_time:
                    first_chunk_time = time.perf_counter() - e2e_start
                    perf_logger.info(
                        "Pipeline chunked first audio: %.0fms, text: \"%s\"",
                        first_chunk_time * 1000, text[:80]
                    )

                if DEBUG_DUMP:
                    self._dump_wav(chunk, SAMPLE_RATE, text)

                if not self._muted:
                    self._broadcast_audio({
                        "pcm": base64.b64encode(chunk.astype(np.float32).tobytes()).decode(),
                        "sr": SAMPLE_RATE,
                        "fmt": "f32"
                    })
                total_samples += len(chunk)

            # Wait for avatar to finish playing all broadcast audio
            total_duration = total_samples / SAMPLE_RATE
            elapsed = time.perf_counter() - broadcast_start
            remaining = total_duration - elapsed
            if remaining > 0:
                self.player.interruptible_sleep(remaining)
        finally:
            self._stop_speaking()
            e2e_elapsed = time.perf_counter() - e2e_start
            perf_logger.info(
                "Pipeline chunked e2e: %.0fms total, first_audio: %s, text: \"%s\"",
                e2e_elapsed * 1000,
                "%.0fms" % (first_chunk_time * 1000) if first_chunk_time else "N/A",
                text[:80]
            )

    def _dump_wav(self, audio: np.ndarray, sr: int, text: str):
        """Save audio to WAV file for debugging."""
        os.makedirs(DUMP_DIR, exist_ok=True)
        ts = time.strftime("%H%M%S")
        path = os.path.join(DUMP_DIR, f"tts_{ts}.wav")
        samples = (audio * 32767).astype(np.int16)
        with wave.open(path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(samples.tobytes())
        logger.info("Debug dump: %s (%d samples, %.1fs) text: %s", path, len(audio), len(audio)/sr, text[:60])
