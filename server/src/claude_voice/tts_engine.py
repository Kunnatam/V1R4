import logging
import re
import time

import numpy as np
from kokoro import KPipeline

logger = logging.getLogger(__name__)
perf_logger = logging.getLogger("claude_voice.perf")

FADE_MS = 10  # fade-in/fade-out duration in milliseconds
SAMPLE_RATE = 24000
CROSSFADE_MS = 20  # crossfade between chunks
_THAI_RE = re.compile(r'[\u0E00-\u0E7F]+')
_SENTENCE_RE = re.compile(r'(?<=[.!?])\s+')
MIN_CHUNK_CHARS = 100  # merge short sentences until chunk reaches this threshold


def _romanize_thai(text: str) -> str:
    """Replace Thai characters with romanized equivalents."""
    if not _THAI_RE.search(text):
        return text
    from pythainlp import romanize
    return _THAI_RE.sub(lambda m: romanize(m.group(0), engine="thai2rom"), text)


class TTSEngine:
    def __init__(self, voice: str = "bf_isabella", lang_code: str = "a", speed: float = 1.1):
        self.voice = voice
        self.speed = speed
        self.pipeline = KPipeline(lang_code=lang_code)

    def generate_stream(self, text: str):
        """Yield processed audio chunks as they're generated.

        Splits text into sentences first so KPipeline processes each
        independently — first sentence yields without waiting for full text.
        """
        try:
            text = _romanize_thai(text)
            sentences = _SENTENCE_RE.split(text)
            sentences = [s.strip() for s in sentences if s.strip()]
            # Merge short sentences into natural phrase groups
            merged = []
            buf = ""
            for i, s in enumerate(sentences):
                if buf:
                    candidate = buf + " " + s
                else:
                    candidate = s
                if len(candidate) >= MIN_CHUNK_CHARS or i == len(sentences) - 1:
                    merged.append(candidate)
                    buf = ""
                else:
                    buf = candidate
            if buf:
                if merged:
                    merged[-1] += " " + buf
                else:
                    merged.append(buf)
            total_start = time.perf_counter()
            chunk_idx = 0
            total_samples = 0
            for sent_idx, sentence in enumerate(merged):
                sent_start = time.perf_counter()
                for _graphemes, _phonemes, audio in self.pipeline(sentence, voice=self.voice, speed=self.speed):
                    chunk = np.asarray(audio, dtype=np.float32)
                    chunk = chunk - chunk.mean()
                    chunk = self._apply_fade(chunk)
                    peak = np.max(np.abs(chunk))
                    if peak > 1.0:
                        chunk = chunk / peak
                    total_samples += len(chunk)
                    chunk_dur = len(chunk) / SAMPLE_RATE
                    sent_elapsed = time.perf_counter() - sent_start
                    perf_logger.info(
                        "TTS chunk %d (sent %d): %.0fms gen, %.1fs audio (%.1fx RT)",
                        chunk_idx, sent_idx, sent_elapsed * 1000, chunk_dur,
                        chunk_dur / max(sent_elapsed, 0.001)
                    )
                    chunk_idx += 1
                    yield chunk, SAMPLE_RATE
            total_elapsed = time.perf_counter() - total_start
            total_audio = total_samples / SAMPLE_RATE
            perf_logger.info(
                "TTS stream done: %d chars, %d sents→%d merged, %d chunks, %.0fms gen, %.1fs audio (%.1fx RT)",
                len(text), len(sentences), len(merged), chunk_idx, total_elapsed * 1000, total_audio,
                total_audio / max(total_elapsed, 0.001)
            )
        except Exception:
            logger.exception("TTS streaming generation failed for text: %s", text[:100])

    def generate(self, text: str) -> tuple[np.ndarray, int]:
        """Generate audio from text. Returns (audio_array, sample_rate)."""
        try:
            text = _romanize_thai(text)
            gen_start = time.perf_counter()
            chunks = []
            for _graphemes, _phonemes, audio in self.pipeline(text, voice=self.voice, speed=self.speed):
                chunks.append(audio)
            if not chunks:
                return np.array([], dtype=np.float32), SAMPLE_RATE
            audio = self._crossfade_chunks(chunks)
            audio = self._apply_fade(audio)
            # Prevent clipping — normalize if peaks exceed [-1, 1]
            peak = np.max(np.abs(audio))
            if peak > 1.0:
                audio = audio / peak
            gen_elapsed = time.perf_counter() - gen_start
            audio_dur = len(audio) / SAMPLE_RATE
            perf_logger.info(
                "TTS full: %d chars, %d chunks, %.0fms gen, %.1fs audio (%.1fx RT)",
                len(text), len(chunks), gen_elapsed * 1000, audio_dur,
                audio_dur / max(gen_elapsed, 0.001)
            )
            return audio, SAMPLE_RATE
        except Exception:
            logger.exception("TTS generation failed for text: %s", text[:100])
            return np.array([], dtype=np.float32), SAMPLE_RATE

    def _crossfade_chunks(self, chunks: list[np.ndarray]) -> np.ndarray:
        """Crossfade between chunks to eliminate pops at boundaries."""
        # Convert to numpy and remove DC offset from each chunk
        chunks = [np.asarray(c, dtype=np.float32) for c in chunks]
        chunks = [c - c.mean() for c in chunks]
        if len(chunks) == 1:
            return chunks[0]
        xf_samples = int(SAMPLE_RATE * CROSSFADE_MS / 1000)
        result = chunks[0]
        for chunk in chunks[1:]:
            xf = min(xf_samples, len(result), len(chunk))
            if xf > 0:
                fade_out = np.linspace(1.0, 0.0, xf, dtype=np.float32)
                fade_in = np.linspace(0.0, 1.0, xf, dtype=np.float32)
                overlap = result[-xf:] * fade_out + chunk[:xf] * fade_in
                result = np.concatenate([result[:-xf], overlap, chunk[xf:]])
            else:
                result = np.concatenate([result, chunk])
        return result

    def _apply_fade(self, audio: np.ndarray) -> np.ndarray:
        """Apply fade-out only to prevent end-of-audio pops."""
        fade_samples = int(SAMPLE_RATE * FADE_MS / 1000)
        fade_samples = min(fade_samples, len(audio) // 2)
        if fade_samples > 0:
            audio = audio.copy()
            audio[-fade_samples:] *= np.linspace(1.0, 0.0, fade_samples, dtype=np.float32)
        return audio
