import logging
import queue
import threading
import time
from contextlib import contextmanager

import numpy as np
import sounddevice as sd

logger = logging.getLogger(__name__)

AMPLITUDE_INTERVAL = 0.03  # 30ms between amplitude samples


class AudioPlayer:
    def __init__(self):
        self._lock = threading.Lock()
        self.volume = 1.0  # 0.0 = muted, 1.0 = full volume
        self._stream: sd.OutputStream | None = None

    def stop(self):
        """Stop any currently playing audio."""
        try:
            if self._stream and self._stream.active:
                self._stream.abort()
            sd.stop()
        except Exception:
            pass

    def play(self, audio: np.ndarray, sample_rate: int = 24000, on_amplitude=None):
        """Play audio array through speakers. Blocks until done."""
        with self._lock:
            if on_amplitude is not None and len(audio) > 0:
                self._play_with_amplitude(audio, sample_rate, on_amplitude)
            else:
                self._play_with_retry(audio, sample_rate)

    def _play_with_amplitude(self, audio: np.ndarray, sample_rate: int, on_amplitude):
        """Play audio while streaming amplitude levels via callback."""
        window_samples = int(sample_rate * AMPLITUDE_INTERVAL)
        peak = np.max(np.abs(audio)) or 1.0

        # Pre-compute all amplitude values before playback to avoid
        # CPU work during playback which causes buffer underruns
        levels = []
        for i in range(0, len(audio), window_samples):
            window = audio[i:i + window_samples]
            rms = float(np.sqrt(np.mean(window ** 2)))
            levels.append(min(rms / peak, 1.0))

        try:
            play_audio = audio * self.volume if self.volume < 1.0 else audio
            sd.play(play_audio, samplerate=sample_rate, blocksize=2048)
            start = time.time()
            total_duration = len(audio) / sample_rate

            for idx, level in enumerate(levels):
                if time.time() - start >= total_duration:
                    break
                on_amplitude(level)
                sleep_until = start + (idx + 1) * AMPLITUDE_INTERVAL
                remaining = sleep_until - time.time()
                if remaining > 0:
                    time.sleep(remaining)

            sd.wait()
        except Exception:
            logger.exception("Audio playback with amplitude failed")

    @contextmanager
    def stream(self, sample_rate: int = 24000):
        """Open a continuous output stream for gap-free chunk playback.

        Yields a write(audio, on_amplitude=None) function.
        The stream stays open — no gaps between writes.
        Amplitude is emitted by a persistent background thread, clock-synced
        to the stream's write position for accurate lipsync timing.
        """
        with self._lock:
            self._stream = sd.OutputStream(
                samplerate=sample_rate, channels=1,
                blocksize=2048, dtype='float32',
            )
            self._stream.start()

            # Fix 1: Clock-sync amplitude to stream write position
            amp_queue: queue.Queue[tuple[float, int] | None] = queue.Queue()
            amp_callback = [None]  # mutable ref for the callback
            samples_written = [0]
            stream_start = [time.monotonic()]
            output_latency = getattr(self._stream, 'latency', 0.085)  # fallback 85ms

            def amp_emitter():
                """Emit amplitude levels synced to actual audio playback clock."""
                while True:
                    try:
                        item = amp_queue.get(timeout=0.5)
                    except queue.Empty:
                        continue
                    if item is None:  # poison pill
                        break
                    level, sample_offset = item
                    # When should this sample actually be heard?
                    target_time = stream_start[0] + (sample_offset / sample_rate) + output_latency
                    now = time.monotonic()
                    if target_time > now:
                        time.sleep(target_time - now)
                    cb = amp_callback[0]
                    if cb:
                        cb(level)

            emitter = threading.Thread(target=amp_emitter, daemon=True)
            emitter.start()

            # Fix 2: Running peak across chunks for consistent amplitude normalization
            running_peak = [0.0]
            PEAK_DECAY = 0.95  # slow decay so peak stays stable across chunks

            try:
                def write(audio: np.ndarray, on_amplitude=None):
                    if on_amplitude:
                        amp_callback[0] = on_amplitude

                    play_audio = audio * self.volume if self.volume < 1.0 else audio
                    self._stream.write(play_audio.reshape(-1, 1))

                    if on_amplitude:
                        window_samples = int(sample_rate * AMPLITUDE_INTERVAL)
                        # Running peak: decay previous, update with current chunk
                        chunk_peak = float(np.max(np.abs(audio)))
                        running_peak[0] = max(running_peak[0] * PEAK_DECAY, chunk_peak) or 1.0
                        peak = running_peak[0]
                        base_offset = samples_written[0]
                        for i in range(0, len(audio), window_samples):
                            window = audio[i:i + window_samples]
                            rms = float(np.sqrt(np.mean(window ** 2)))
                            # Tag with sample offset for clock-synced emission
                            amp_queue.put((min(rms / peak, 1.0), base_offset + i))
                        samples_written[0] += len(audio)

                yield write
            finally:
                amp_queue.put(None)  # poison pill
                emitter.join(timeout=5)
                self._stream.stop()
                self._stream.close()
                self._stream = None

    def play_queued(self, chunks: list[np.ndarray], sample_rate: int = 24000):
        """Play a list of audio chunks sequentially."""
        with self._lock:
            for chunk in chunks:
                self._play_with_retry(chunk, sample_rate)

    def _play_with_retry(self, audio: np.ndarray, sample_rate: int):
        """Attempt playback; retry once on failure, then log and drop."""
        play_audio = audio * self.volume if self.volume < 1.0 else audio
        for attempt in range(2):
            try:
                sd.play(play_audio, samplerate=sample_rate, blocksize=2048)
                sd.wait()
                return
            except Exception:
                if attempt == 0:
                    logger.warning("Audio playback failed, retrying once")
                else:
                    logger.exception("Audio playback failed after retry, dropping chunk")
