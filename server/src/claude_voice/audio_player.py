import logging
import threading

logger = logging.getLogger(__name__)


class AudioPlayer:
    def __init__(self):
        self.volume = 1.0  # 0.0 = muted, 1.0 = full volume
        self._stop_event = threading.Event()

    def stop(self):
        """Signal any sleeping speak/cue to stop early."""
        self._stop_event.set()

    def interruptible_sleep(self, duration: float):
        """Sleep for duration but return early if stop() is called."""
        if self._stop_event.is_set():
            return  # already stopped — don't sleep
        self._stop_event.wait(timeout=duration)
        self._stop_event.clear()

    @property
    def is_active(self) -> bool:
        """No local playback — always False."""
        return False
