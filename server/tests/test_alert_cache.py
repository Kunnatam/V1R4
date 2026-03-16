from unittest.mock import MagicMock
import numpy as np

from claude_voice.alert_cache import (
    AlertCache, AGENT_CUES, FALLBACK_CUES, TOOL_CATEGORY, SILENT_TOOLS,
    LEADIN_CASUAL, LEADIN_DRAMATIC, LEADIN_UPBEAT, LEADIN_CAUTIOUS,
    LEADIN_SOMBER, MOOD_LEADIN_CATEGORY,
)


def _mock_tts():
    engine = MagicMock()
    engine.voice = "bf_isabella"
    engine.generate.return_value = (np.zeros(1000, dtype=np.float32), 24000)
    return engine


def test_agent_cues_exist():
    assert len(AGENT_CUES) >= 2


def test_fallback_cues_exist():
    assert len(FALLBACK_CUES) >= 2


def test_random_cue_agent(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    result = cache.random_cue("Agent")
    assert result is not None
    text, audio = result
    assert text in AGENT_CUES
    assert len(audio) > 0


def test_random_cue_fallback(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    result = cache.random_cue("UnknownTool")
    assert result is not None
    text, audio = result
    assert text in FALLBACK_CUES
    assert len(audio) > 0


def test_silent_tools_return_none(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    for tool in SILENT_TOOLS:
        assert cache.random_cue(tool) is None


def test_legacy_methods(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    result = cache.random_subagent_cue()
    assert result is not None
    result = cache.random_tool_cue()
    assert result is not None


def test_leadin_phrase_lists_exist():
    assert len(LEADIN_CASUAL) >= 2
    assert len(LEADIN_DRAMATIC) >= 2
    assert len(LEADIN_UPBEAT) >= 2
    assert len(LEADIN_CAUTIOUS) >= 2
    assert len(LEADIN_SOMBER) >= 2


def test_mood_leadin_mapping():
    assert MOOD_LEADIN_CATEGORY[None] == "leadin_casual"
    assert MOOD_LEADIN_CATEGORY["error"] == "leadin_dramatic"
    assert MOOD_LEADIN_CATEGORY["success"] == "leadin_upbeat"
    assert MOOD_LEADIN_CATEGORY["warn"] == "leadin_cautious"
    assert MOOD_LEADIN_CATEGORY["melancholy"] == "leadin_somber"


def test_random_leadin_default(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    result = cache.random_leadin(None)
    assert result is not None
    text, audio = result
    assert text in LEADIN_CASUAL
    assert len(audio) > 0


def test_random_leadin_error_mood(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    result = cache.random_leadin("error")
    assert result is not None
    text, audio = result
    assert text in LEADIN_DRAMATIC


def test_random_leadin_unknown_mood_falls_back_to_casual(tmp_path):
    cache = AlertCache(cache_dir=tmp_path, tts_engine=_mock_tts())
    cache.warm()
    result = cache.random_leadin("some_unknown_mood")
    assert result is not None
    text, audio = result
    assert text in LEADIN_CASUAL
