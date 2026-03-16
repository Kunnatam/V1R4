import time
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import numpy as np

from fastapi import FastAPI
from fastapi.testclient import TestClient


@asynccontextmanager
async def _noop_lifespan(app: FastAPI):
    yield


def _make_client():
    """Create test client with mocked pipeline."""
    from claude_voice.server import create_app, StatusBroadcaster
    app = create_app(custom_lifespan=_noop_lifespan)
    mock_pipeline = MagicMock()
    mock_alert_cache = MagicMock()
    mock_alert_cache.random_subagent_cue.return_value = None
    mock_alert_cache.random_tool_cue.return_value = None
    mock_alert_cache.random_cue.return_value = None
    app.state.pipeline = mock_pipeline
    app.state.alert_cache = mock_alert_cache
    app.state.start_time = time.time()
    app.state.broadcaster = StatusBroadcaster()
    app.state.voice_cue_mode = "30s"
    app.state.last_cue_time = 0.0
    app.state.cue_fired_this_cycle = False
    app.state.playback_mode = "full"
    app.state.muted = False
    return TestClient(app), mock_pipeline


def test_health_endpoint():
    client, _ = _make_client()
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_speak_endpoint():
    client, mock_pipeline = _make_client()
    response = client.post("/speak", json={"text": "Hello world"})
    assert response.status_code == 200
    mock_pipeline.speak.assert_called_once_with("Hello world")


def test_speak_rejects_empty_text():
    client, _ = _make_client()
    response = client.post("/speak", json={"text": ""})
    assert response.status_code == 422


def test_speak_summary_removed():
    client, _ = _make_client()
    response = client.post("/speak-summary", json={"text": "test"})
    assert response.status_code in (404, 405)


def test_websocket_status_connects():
    client, _ = _make_client()
    with client.websocket_connect("/ws/status") as ws:
        pass  # connection itself is the test


def test_status_thinking():
    client, _ = _make_client()
    response = client.post("/status", json={"state": "thinking"})
    assert response.status_code == 200
    assert response.json()["state"] == "thinking"


def test_status_idle():
    client, _ = _make_client()
    response = client.post("/status", json={"state": "idle"})
    assert response.status_code == 200
    assert response.json()["state"] == "idle"


def test_status_with_event():
    client, _ = _make_client()
    response = client.post("/status", json={"state": "thinking", "event": "tool_use"})
    assert response.status_code == 200


def test_status_invalid_state():
    client, _ = _make_client()
    response = client.post("/status", json={"state": "invalid"})
    assert response.status_code == 422


def test_speak_with_mood():
    client, mock_pipeline = _make_client()
    response = client.post("/speak", json={"text": "tests failed", "mood": "error"})
    assert response.status_code == 200
    assert response.json()["mood"] == "error"


def test_speak_without_mood():
    client, mock_pipeline = _make_client()
    response = client.post("/speak", json={"text": "hello"})
    assert response.status_code == 200
    assert response.json().get("mood") is None


def test_status_broadcasts_tool_mood():
    client, _ = _make_client()
    with client.websocket_connect("/ws/status") as ws:
        client.post("/status", json={"state": "thinking", "event": "tool_use", "tool_name": "Grep"})
        data = ws.receive_json()
        assert data["state"] == "thinking"
        data2 = ws.receive_json()
        assert data2["tool_mood"] == "search"


def test_speak_chunked_passes_leadin_audio():
    client, mock_pipeline = _make_client()
    # Switch to chunked mode
    client.app.state.playback_mode = "chunked"

    # Mock alert_cache to return a lead-in
    leadin_audio = np.zeros(2400, dtype=np.float32)
    client.app.state.alert_cache.random_leadin.return_value = ("Okay.", leadin_audio)

    response = client.post("/speak", json={"text": "Hello world", "mood": "error"})
    assert response.status_code == 200

    # Verify speak_chunked was called with leadin_audio
    mock_pipeline.speak_chunked.assert_called_once()
    call_kwargs = mock_pipeline.speak_chunked.call_args
    assert call_kwargs[1].get("leadin_audio") is not None


def test_speak_chunked_no_leadin_when_none_cached():
    client, mock_pipeline = _make_client()
    client.app.state.playback_mode = "chunked"

    client.app.state.alert_cache.random_leadin.return_value = None

    response = client.post("/speak", json={"text": "Hello world"})
    assert response.status_code == 200

    mock_pipeline.speak_chunked.assert_called_once()
    call_kwargs = mock_pipeline.speak_chunked.call_args
    assert call_kwargs[1].get("leadin_audio") is None
