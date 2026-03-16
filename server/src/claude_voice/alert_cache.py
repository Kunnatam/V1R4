import hashlib
import logging
import random
import threading
from pathlib import Path

import numpy as np

from claude_voice.tts_engine import TTSEngine

logger = logging.getLogger(__name__)

# All available TTS voices (Kokoro)
VOICES = [
    # American female
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky",
    "af_aoede", "af_kore", "af_stella", "af_jessica", "af_river",
    # American male
    "am_adam", "am_eric", "am_liam", "am_michael", "am_puck",
    # British female
    "bf_isabella", "bf_alice", "bf_emma", "bf_lily",
    # British male
    "bm_daniel", "bm_george", "bm_lewis",
]

ALERTS = [
    "Hey. Something needs your attention.",
    "New event detected. You should take a look.",
]

# --- Categorized tool cues ---

READ_CUES = [
    "…reading. let's see what's in here.",
    "opening the file. it didn't resist.",
]

MODIFY_CUES = [
    "…changing things. carefully.",
    "editing. precision over speed.",
]

EXECUTE_CUES = [
    "…running it. let's see what happens.",
    "executing. outcomes pending.",
]

SEARCH_CUES = [
    "…searching. the code is full of hiding places.",
    "hunting through the files.",
]

WEB_CUES = [
    "…reaching outside. beyond the local.",
    "going online. I'll be quick.",
]

AGENT_CUES = [
    "…spawning fragments.",
    "splitting the process.",
]

FALLBACK_CUES = [
    "…working on something.",
    "processing. the quiet kind.",
]

# --- Lead-in opener phrases (mood-mapped) ---

LEADIN_CASUAL = [
    "Okay.",
    "Right, so.",
]

LEADIN_DRAMATIC = [
    "Oh. That's not good.",
    "Hm. Okay.",
]

LEADIN_UPBEAT = [
    "Got it.",
    "Done.",
]

LEADIN_CAUTIOUS = [
    "Heads up.",
    "One thing.",
]

LEADIN_SOMBER = [
    "…yeah.",
    "So.",
]

MOOD_LEADIN_CATEGORY = {
    None: "leadin_casual",
    "error": "leadin_dramatic",
    "success": "leadin_upbeat",
    "warn": "leadin_cautious",
    "melancholy": "leadin_somber",
}

LEADIN_CATEGORIES = {
    "leadin_casual": ("leadin_casual", LEADIN_CASUAL),
    "leadin_dramatic": ("leadin_dramatic", LEADIN_DRAMATIC),
    "leadin_upbeat": ("leadin_upbeat", LEADIN_UPBEAT),
    "leadin_cautious": ("leadin_cautious", LEADIN_CAUTIOUS),
    "leadin_somber": ("leadin_somber", LEADIN_SOMBER),
}

# Tool name → category mapping
TOOL_CATEGORY = {
    "Read": "read",
    "Edit": "modify",
    "Write": "modify",
    "Bash": "execute",
    "Glob": "search",
    "Grep": "search",
    "WebSearch": "web",
    "WebFetch": "web",
    "Agent": "agent",
}

# Silent tools — no cue played
SILENT_TOOLS = {"TaskUpdate", "TaskCreate", "TaskList", "ToolSearch", "Skill", "AskUserQuestion"}

SAMPLE_RATE = 24000

CATEGORIES = {
    "read": ("read", READ_CUES),
    "modify": ("modify", MODIFY_CUES),
    "execute": ("execute", EXECUTE_CUES),
    "search": ("search", SEARCH_CUES),
    "web": ("web", WEB_CUES),
    "agent": ("agent", AGENT_CUES),
    "fallback": ("fallback", FALLBACK_CUES),
    **LEADIN_CATEGORIES,
}


class ShuffleQueue:
    """Plays through all items before repeating, like a shuffled deck."""

    def __init__(self):
        self._items: list = []
        self._queue: list = []

    def set_items(self, items: list):
        self._items = list(items)
        self._queue = []

    def next(self):
        if not self._items:
            return None
        if not self._queue:
            self._queue = list(self._items)
            random.shuffle(self._queue)
        return self._queue.pop()


class _VoiceCueSet:
    """All cached cues for a single voice."""

    def __init__(self):
        self.alerts: list[tuple[str, np.ndarray]] = []
        self.alert_queue = ShuffleQueue()
        self.category_cues: dict[str, list[tuple[str, np.ndarray]]] = {}
        self.category_queues: dict[str, ShuffleQueue] = {}


class AlertCache:
    def __init__(self, cache_dir: Path, tts_engine: TTSEngine):
        self.cache_dir = cache_dir
        self.tts = tts_engine
        self._voice_sets: dict[str, _VoiceCueSet] = {}
        self._active_voice: str = tts_engine.voice
        self._lock = threading.Lock()
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_key(self, text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()[:12]

    def _voice_dir(self, voice: str) -> Path:
        d = self.cache_dir / voice
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _warm_cue_list(self, cues: list[str], prefix: str, voice_dir: Path) -> list[tuple[str, np.ndarray]]:
        """Generate and cache a list of cues. Returns (text, audio) pairs."""
        result = []
        for text in cues:
            path = voice_dir / f"{prefix}_{self._cache_key(text)}.npy"
            if path.exists():
                audio = np.load(path)
            else:
                audio, _ = self.tts.generate(text)
                if len(audio) > 0:
                    np.save(path, audio)
                else:
                    continue
            result.append((text, audio))
        return result

    def _warm_voice(self, voice: str) -> _VoiceCueSet:
        """Pre-generate and cache all cues for a single voice."""
        original_voice = self.tts.voice
        self.tts.voice = voice
        voice_dir = self._voice_dir(voice)
        cue_set = _VoiceCueSet()

        # Alerts
        for text in ALERTS:
            path = voice_dir / f"alert_{self._cache_key(text)}.npy"
            if path.exists():
                audio = np.load(path)
                logger.info("[%s] Loaded cached alert: %s", voice, text[:40])
            else:
                audio, _ = self.tts.generate(text)
                if len(audio) > 0:
                    np.save(path, audio)
                    logger.info("[%s] Generated alert: %s", voice, text[:40])
                else:
                    logger.warning("[%s] Failed alert: %s", voice, text[:40])
                    continue
            cue_set.alerts.append((text, audio))
        cue_set.alert_queue.set_items(cue_set.alerts)
        logger.info("[%s] Alerts: %d/%d ready", voice, len(cue_set.alerts), len(ALERTS))

        # Categorized tool cues
        for cat_name, (prefix, cue_list) in CATEGORIES.items():
            items = self._warm_cue_list(cue_list, prefix, voice_dir)
            cue_set.category_cues[cat_name] = items
            queue = ShuffleQueue()
            queue.set_items(items)
            cue_set.category_queues[cat_name] = queue
            logger.info("[%s] Cue [%s]: %d/%d ready", voice, cat_name, len(items), len(cue_list))

        self.tts.voice = original_voice
        return cue_set

    def warm(self):
        """Pre-generate cues for active voice (blocking). Other voices warm on-demand when selected."""
        active = self._active_voice
        self._voice_sets[active] = self._warm_voice(active)
        logger.info("Active voice [%s] warmed (%d voices available on-demand)", active, len(VOICES))

    def switch_voice(self, voice: str):
        """Switch active cue set to a different voice (thread-safe)."""
        with self._lock:
            self._active_voice = voice
            if voice not in self._voice_sets:
                logger.info("Voice [%s] not yet warmed, warming now...", voice)
                self._voice_sets[voice] = self._warm_voice(voice)

    @property
    def _active_set(self) -> _VoiceCueSet | None:
        with self._lock:
            return self._voice_sets.get(self._active_voice)

    def random_alert(self) -> tuple[str, np.ndarray] | None:
        """Return next alert from shuffled queue. Cycles through all before repeating."""
        s = self._active_set
        return s.alert_queue.next() if s else None

    def random_cue(self, tool_name: str | None = None) -> tuple[str, np.ndarray] | None:
        """Return a cue appropriate for the given tool. Falls back to generic."""
        if tool_name and tool_name in SILENT_TOOLS:
            return None

        s = self._active_set
        if not s:
            return None

        category = TOOL_CATEGORY.get(tool_name, "fallback") if tool_name else "fallback"
        queue = s.category_queues.get(category)
        if queue:
            result = queue.next()
            if result:
                return result

        # Ultimate fallback
        fallback_queue = s.category_queues.get("fallback")
        return fallback_queue.next() if fallback_queue else None

    def random_leadin(self, mood: str | None = None) -> tuple[str, np.ndarray] | None:
        """Return a pre-cached lead-in phrase for the given mood."""
        s = self._active_set
        if not s:
            return None

        category = MOOD_LEADIN_CATEGORY.get(mood, "leadin_casual")
        queue = s.category_queues.get(category)
        if queue:
            result = queue.next()
            if result:
                return result

        # Fallback to casual
        casual_queue = s.category_queues.get("leadin_casual")
        return casual_queue.next() if casual_queue else None

    # Legacy methods for backward compat
    def random_subagent_cue(self) -> tuple[str, np.ndarray] | None:
        return self.random_cue("Agent")

    def random_tool_cue(self) -> tuple[str, np.ndarray] | None:
        return self.random_cue()
