from unittest.mock import MagicMock, patch
import numpy as np
from claude_voice.tts_engine import TTSEngine


def test_engine_init_creates_pipeline():
    with patch("claude_voice.tts_engine.KPipeline") as mock_kp:
        engine = TTSEngine(voice="bf_isabella")
        mock_kp.assert_called_once_with(lang_code="a")


def test_engine_generate_returns_audio():
    with patch("claude_voice.tts_engine.KPipeline") as mock_kp:
        mock_pipeline = MagicMock()
        mock_kp.return_value = mock_pipeline
        fake_audio = np.zeros(24000, dtype=np.float32)
        mock_pipeline.return_value = iter([("hello", "hɛloʊ", fake_audio)])

        engine = TTSEngine(voice="bf_isabella")
        audio, sr = engine.generate("hello")

        assert isinstance(audio, np.ndarray)
        assert len(audio) == 24000
        assert sr == 24000
        mock_pipeline.assert_called_once_with("hello", voice="bf_isabella", speed=1.1)


def test_engine_concatenates_multiple_chunks():
    with patch("claude_voice.tts_engine.KPipeline") as mock_kp:
        mock_pipeline = MagicMock()
        mock_kp.return_value = mock_pipeline
        chunk1 = np.ones(1000, dtype=np.float32)
        chunk2 = np.ones(2000, dtype=np.float32) * 2
        mock_pipeline.return_value = iter([
            ("first", "fɜːst", chunk1),
            ("second", "sɛkənd", chunk2),
        ])

        engine = TTSEngine(voice="bf_isabella")
        audio, sr = engine.generate("first. second.")

        # 1000 + 2000 - 480 (crossfade: 24000 * 20ms / 1000) = 2520
        assert len(audio) == 2520
        assert sr == 24000


def test_engine_returns_empty_on_failure():
    with patch("claude_voice.tts_engine.KPipeline") as mock_kp:
        mock_pipeline = MagicMock()
        mock_kp.return_value = mock_pipeline
        mock_pipeline.side_effect = Exception("boom")

        engine = TTSEngine(voice="bf_isabella")
        audio, sr = engine.generate("hello")

        assert len(audio) == 0
        assert sr == 24000
