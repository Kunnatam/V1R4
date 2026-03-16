import asyncio
import numpy as np
from unittest.mock import MagicMock
from claude_voice.pipeline import SpeakPipeline


def test_speak_generates_and_plays():
    mock_engine = MagicMock()
    mock_engine.generate.return_value = (np.zeros(24000, dtype=np.float32), 24000)
    mock_player = MagicMock()

    pipeline = SpeakPipeline(tts_engine=mock_engine, audio_player=mock_player)
    pipeline.speak("Hello world")

    mock_engine.generate.assert_called_once_with("Hello world")
    mock_player.play.assert_called_once()


def test_speak_skips_empty_audio():
    mock_engine = MagicMock()
    mock_engine.generate.return_value = (np.array([], dtype=np.float32), 24000)
    mock_player = MagicMock()

    pipeline = SpeakPipeline(tts_engine=mock_engine, audio_player=mock_player)
    pipeline.speak("Hello world")

    mock_player.play.assert_not_called()


def test_speak_broadcasts_speaking_state():
    mock_engine = MagicMock()
    mock_engine.generate.return_value = (np.zeros(24000, dtype=np.float32), 24000)
    mock_player = MagicMock()
    mock_broadcaster = MagicMock()

    broadcast_calls = []
    async def fake_broadcast(data):
        broadcast_calls.append(data)
    mock_broadcaster.broadcast = fake_broadcast

    pipeline = SpeakPipeline(
        tts_engine=mock_engine,
        audio_player=mock_player,
        broadcaster=mock_broadcaster,
    )
    pipeline.speak("Hello world")

    assert any(c.get("speaking") is True for c in broadcast_calls)
    assert any(c.get("speaking") is False for c in broadcast_calls)


def test_speak_passes_amplitude_callback_to_player():
    mock_engine = MagicMock()
    mock_engine.generate.return_value = (np.zeros(24000, dtype=np.float32), 24000)
    mock_player = MagicMock()
    mock_broadcaster = MagicMock()
    async def fake_broadcast(data):
        pass
    mock_broadcaster.broadcast = fake_broadcast

    pipeline = SpeakPipeline(
        tts_engine=mock_engine,
        audio_player=mock_player,
        broadcaster=mock_broadcaster,
    )
    pipeline.speak("Hello world")

    call_kwargs = mock_player.play.call_args
    assert call_kwargs is not None
    # Check on_amplitude was passed
    assert "on_amplitude" in (call_kwargs.kwargs or {}) or len(call_kwargs.args) > 2


def test_speak_chunked_plays_leadin_before_content():
    mock_engine = MagicMock()
    mock_engine.generate_stream.return_value = iter([
        (np.zeros(12000, dtype=np.float32), 24000),
    ])

    # Track writes to the continuous stream
    writes = []
    mock_write = MagicMock(side_effect=lambda audio, on_amplitude=None: writes.append(audio.copy()))
    mock_player = MagicMock()
    mock_player.stream.return_value.__enter__ = MagicMock(return_value=mock_write)
    mock_player.stream.return_value.__exit__ = MagicMock(return_value=False)

    mock_broadcaster = MagicMock()
    async def fake_broadcast(data):
        pass
    mock_broadcaster.broadcast = fake_broadcast

    leadin_audio = np.ones(2400, dtype=np.float32) * 0.5

    pipeline = SpeakPipeline(
        tts_engine=mock_engine,
        audio_player=mock_player,
        broadcaster=mock_broadcaster,
    )
    pipeline.speak_chunked("Hello world", leadin_audio=leadin_audio)

    # Stream should have at least 2 writes: lead-in + content chunk
    assert len(writes) >= 2
    # First write should be the lead-in audio
    np.testing.assert_array_equal(writes[0], leadin_audio)


def test_speak_chunked_works_without_leadin():
    mock_engine = MagicMock()
    mock_engine.generate_stream.return_value = iter([
        (np.zeros(12000, dtype=np.float32), 24000),
    ])

    writes = []
    mock_write = MagicMock(side_effect=lambda audio, on_amplitude=None: writes.append(audio.copy()))
    mock_player = MagicMock()
    mock_player.stream.return_value.__enter__ = MagicMock(return_value=mock_write)
    mock_player.stream.return_value.__exit__ = MagicMock(return_value=False)

    pipeline = SpeakPipeline(tts_engine=mock_engine, audio_player=mock_player)
    pipeline.speak_chunked("Hello world")

    # Should have at least 1 write for the content chunk
    assert len(writes) >= 1
