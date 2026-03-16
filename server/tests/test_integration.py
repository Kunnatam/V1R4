"""
Integration test - requires:
- Kokoro model + espeak-ng installed
- Audio device available

Run with: pytest tests/test_integration.py -v -s
Skip in CI with: pytest -m "not integration"
"""
import pytest
import numpy as np

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def tts_engine():
    from claude_voice.tts_engine import TTSEngine
    return TTSEngine(voice="bf_isabella")


def test_tts_generates_audio(tts_engine):
    audio, sr = tts_engine.generate("Testing one two three.")
    assert isinstance(audio, np.ndarray)
    assert len(audio) > 1000
    assert sr == 24000


def test_tts_generates_and_plays(tts_engine):
    from claude_voice.audio_player import AudioPlayer
    audio, sr = tts_engine.generate("Hello from V1R4.")
    player = AudioPlayer()
    player.play(audio, sr)


def test_full_pipeline(tts_engine):
    from claude_voice.audio_player import AudioPlayer
    from claude_voice.pipeline import SpeakPipeline

    player = AudioPlayer()
    pipeline = SpeakPipeline(tts_engine=tts_engine, audio_player=player)
    pipeline.speak("Three files changed. Tests pass. Almost elegant.")
