import numpy as np
from unittest.mock import patch, MagicMock
from claude_voice.audio_player import AudioPlayer


def test_play_calls_sounddevice():
    player = AudioPlayer()
    audio = np.zeros(24000, dtype=np.float32)  # 1 second of silence
    with patch("claude_voice.audio_player.sd") as mock_sd:
        player.play(audio, sample_rate=24000)
        mock_sd.play.assert_called_once()
        mock_sd.wait.assert_called_once()


def test_play_queued_plays_multiple_chunks():
    player = AudioPlayer()
    chunks = [np.zeros(12000, dtype=np.float32) for _ in range(3)]
    with patch("claude_voice.audio_player.sd") as mock_sd:
        player.play_queued(chunks, sample_rate=24000)
        assert mock_sd.play.call_count == 3


def test_play_with_amplitude_callback():
    amplitudes = []

    def on_amplitude(level):
        amplitudes.append(level)

    audio = np.random.randn(24000).astype(np.float32) * 0.5
    player = AudioPlayer()

    with patch("claude_voice.audio_player.sd") as mock_sd:
        mock_sd.play = MagicMock()
        mock_sd.wait = MagicMock()
        player.play(audio, 24000, on_amplitude=on_amplitude)

    assert len(amplitudes) > 0
    assert all(0.0 <= a <= 1.0 for a in amplitudes)
