# Decouple Audio Playback — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move audio playback from the Python TTS server (sounddevice) to the avatar frontend (Web Audio API), making the server a pure TTS streaming API.

**Architecture:** Server generates PCM via Kokoro, broadcasts chunks over `/ws/audio` WebSocket. Avatar receives chunks, plays through Web Audio API, and analyzes amplitude locally for lipsync. Server no longer plays audio or broadcasts amplitude.

**Tech Stack:** Python (FastAPI), TypeScript (Web Audio API), WebSocket (existing)

**Spec:** `docs/superpowers/specs/2026-03-20-decouple-audio-playback-design.md`

---

## Task 1: Enable frontend audio playback

**Files:**
- Modify: `src/audio-player.ts`

The key change: connect `analyser` to `destination` so audio plays through speakers.

- [ ] **Step 1: Connect analyser to destination**

In `src/audio-player.ts`, modify `initAudioPlayer()`:

```typescript
export function initAudioPlayer(): void {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = TIME_DOMAIN_SIZE;
  // Connect analyser to speakers — frontend now handles playback
  analyser.connect(audioCtx.destination);
  nextPlayTime = 0;
}
```

Change the comment at the top of the file from:
```
// Web Audio API amplitude analysis (muted — backend handles playback)
// Routes PCM through AnalyserNode without outputting to speakers,
// so we get synced amplitude for lipsync without double audio.
```
to:
```
// Web Audio API playback + amplitude analysis
// Receives PCM chunks from TTS server via WebSocket,
// plays through speakers and analyzes amplitude for lipsync.
```

Also remove the comment on line 18: `// NOT connected to destination — analysis only, no audio output`

- [ ] **Step 2: Guard resetAudioPlayback + add force reset**

In `src/audio-player.ts`, modify `resetAudioPlayback()` and add `forceResetAudioPlayback()`:

```typescript
export function resetAudioPlayback(): void {
  // Only reset if all queued audio has finished playing
  if (audioCtx && nextPlayTime > 0 && audioCtx.currentTime < nextPlayTime) {
    return; // audio still playing — let it drain
  }
  nextPlayTime = 0;
  firstChunkReceived = false;
  speakStartTime = 0;
}

export function forceResetAudioPlayback(): void {
  // Force stop — used by /stop endpoint
  nextPlayTime = 0;
  firstChunkReceived = false;
  speakStartTime = 0;
}
```

In `main.ts`, import `forceResetAudioPlayback` and use it in the stop signal handler (wherever `/stop` broadcasts `speaking=false` with force intent). Use `resetAudioPlayback()` for normal speaking-stop (let audio drain), `forceResetAudioPlayback()` for explicit stop.

- [ ] **Step 3: Verify audio plays from avatar**

Run: `npm run tauri dev` and `cd server && source .venv/bin/activate && python -m claude_voice.server`

Test: `curl -X POST http://127.0.0.1:5111/speak -H "Content-Type: application/json" -d '{"text":"Hello, testing frontend playback."}'`

Expected: Audio plays from the avatar window. You'll hear double audio at this point (server + avatar) — that's expected and will be fixed in Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/audio-player.ts
git commit -m "feat: enable frontend audio playback via Web Audio API"
```

---

## Task 2: Remove server-side speaker playback + update pipeline (atomic)

**Files:**
- Modify: `server/src/claude_voice/audio_player.py`
- Modify: `server/src/claude_voice/pipeline.py`

Strip all `sounddevice` playback and update pipeline in one commit so there's no broken intermediate state.

- [ ] **Step 1: Rewrite audio_player.py**

Replace the entire file with:

```python
import logging
import threading

import numpy as np

logger = logging.getLogger(__name__)


class AudioPlayer:
    def __init__(self):
        self._lock = threading.Lock()
        self.volume = 1.0  # 0.0 = muted, 1.0 = full volume
        self._stop_event = threading.Event()

    def stop(self):
        """Signal any sleeping speak/cue to stop early."""
        self._stop_event.set()

    def interruptible_sleep(self, duration: float):
        """Sleep for duration but return early if stop() is called."""
        self._stop_event.clear()
        self._stop_event.wait(timeout=duration)

    @property
    def is_active(self) -> bool:
        """No local playback — always False."""
        return False
```

- [ ] **Step 2: Rewrite pipeline.py speak() — use interruptible sleep, add mute guard**

In `pipeline.py`, replace the `speak()` method:

```python
def speak(self, text: str):
    """Generate and broadcast audio for text (full batch mode)."""
    e2e_start = time.perf_counter()
    audio, sr = self.tts.generate(text)
    if len(audio) > 0:
        if DEBUG_DUMP:
            self._dump_wav(audio, sr, text)

        duration = len(audio) / sr
        self._start_speaking()
        self._broadcast({"text": text, "duration": round(duration, 2)})

        # Broadcast PCM to avatar for playback (respects mute)
        if not self._muted:
            pcm_int16 = (audio * 32767).astype(np.int16)
            self._broadcast_audio({
                "pcm": base64.b64encode(pcm_int16.tobytes()).decode(),
                "sr": sr
            })

        # Interruptible wait so /stop can cancel
        self.player.interruptible_sleep(duration)
        self._stop_speaking()

        e2e_elapsed = time.perf_counter() - e2e_start
        perf_logger.info(
            "Pipeline full e2e: %.0fms total, text: \"%s\"",
            e2e_elapsed * 1000, text[:80]
        )
```

Also add `self._muted = False` to `SpeakPipeline.__init__()`.

- [ ] **Step 3: Rewrite pipeline.py speak_chunked() — add mute guard**

Replace the `speak_chunked()` method:

```python
def speak_chunked(self, text: str, leadin_audio: np.ndarray | None = None):
    """Generate and broadcast audio chunk by chunk."""
    e2e_start = time.perf_counter()
    first_chunk_time = None
    chunk_queue: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=2)

    def generator():
        try:
            for chunk, _sr in self.tts.generate_stream(text):
                chunk_queue.put(chunk)
        except Exception:
            logger.exception("Chunked generation failed")
        finally:
            chunk_queue.put(None)

    gen_thread = threading.Thread(target=generator, daemon=True)
    gen_thread.start()

    self._start_speaking()
    self._broadcast({"text": text, "duration": 0})

    try:
        # Broadcast lead-in immediately
        if leadin_audio is not None and len(leadin_audio) > 0 and not self._muted:
            perf_logger.info("Pipeline lead-in: %d samples (%.0fms)",
                             len(leadin_audio), len(leadin_audio) / SAMPLE_RATE * 1000)
            pcm_int16 = (leadin_audio * 32767).astype(np.int16)
            self._broadcast_audio({
                "pcm": base64.b64encode(pcm_int16.tobytes()).decode(),
                "sr": SAMPLE_RATE
            })

        while True:
            try:
                chunk = chunk_queue.get(timeout=30)
            except queue.Empty:
                logger.warning("TTS chunk generation timed out (30s)")
                break
            if chunk is None:
                break
            if len(chunk) == 0:
                continue

            if not first_chunk_time:
                first_chunk_time = time.perf_counter() - e2e_start
                perf_logger.info(
                    "Pipeline chunked first audio: %.0fms, text: \"%s\"",
                    first_chunk_time * 1000, text[:80]
                )

            if DEBUG_DUMP:
                self._dump_wav(chunk, SAMPLE_RATE, text)

            if not self._muted:
                pcm_int16 = (chunk * 32767).astype(np.int16)
                self._broadcast_audio({
                    "pcm": base64.b64encode(pcm_int16.tobytes()).decode(),
                    "sr": SAMPLE_RATE
                })
    finally:
        self._stop_speaking()
        e2e_elapsed = time.perf_counter() - e2e_start
        perf_logger.info(
            "Pipeline chunked e2e: %.0fms total, first_audio: %s, text: \"%s\"",
            e2e_elapsed * 1000,
            "%.0fms" % (first_chunk_time * 1000) if first_chunk_time else "N/A",
            text[:80]
        )
```

- [ ] **Step 4: Verify server starts and chunked speech works**

Test: `curl -X POST http://127.0.0.1:5111/speak -H "Content-Type: application/json" -d '{"text":"This is a longer test to verify chunked streaming still works correctly through the WebSocket pipeline."}'`

Expected: Audio plays from avatar only (no server speaker output). Lipsync works.

- [ ] **Step 5: Commit (audio_player + pipeline together)**

```bash
git add server/src/claude_voice/audio_player.py server/src/claude_voice/pipeline.py
git commit -m "refactor: strip sounddevice, pipeline broadcasts PCM only"
```

---

## Task 3: Update server.py — alerts, cues, mute, stop

**Files:**
- Modify: `server/src/claude_voice/server.py`

Replace `player.play()` calls in alert/cue handlers with WebSocket broadcasts. Update mute and stop endpoints.

- [ ] **Step 1: Update play_alert() closure**

In `server.py`, replace the `play_alert()` closure (around line 181-188):

```python
def play_alert():
    app.state.pipeline._start_speaking()
    try:
        if not app.state.muted:
            pcm_int16 = (audio * 32767).astype(np.int16)
            app.state.pipeline._broadcast_audio({
                "pcm": base64.b64encode(pcm_int16.tobytes()).decode(),
                "sr": SAMPLE_RATE
            })
        app.state.pipeline.player.interruptible_sleep(len(audio) / SAMPLE_RATE)
    finally:
        app.state.pipeline._stop_speaking()
```

Add `import base64` at the top of server.py (not currently imported).

- [ ] **Step 2: Update play_cue() closure**

In `server.py`, replace the `play_cue()` closure (around line 213-220) with the same pattern:

```python
def play_cue():
    app.state.pipeline._start_speaking()
    try:
        if not app.state.muted:
            pcm_int16 = (audio * 32767).astype(np.int16)
            app.state.pipeline._broadcast_audio({
                "pcm": base64.b64encode(pcm_int16.tobytes()).decode(),
                "sr": SAMPLE_RATE
            })
        app.state.pipeline.player.interruptible_sleep(len(audio) / SAMPLE_RATE)
    finally:
        app.state.pipeline._stop_speaking()
```

- [ ] **Step 3: Update /mute endpoint**

Replace the `/mute` handler — sets pipeline muted flag and stops current playback:

```python
@app.post("/mute")
def set_mute(req: MuteRequest):
    app.state.muted = req.muted
    app.state.pipeline._muted = req.muted
    if req.muted:
        app.state.pipeline.player.stop()
    return {"muted": req.muted}
```

- [ ] **Step 4: Update /stop endpoint**

The `/stop` handler calls `player.stop()` which is now a no-op. Keep it for API compatibility but the real work is resetting the speaking counter:

```python
@app.post("/stop")
def stop_speaking():
    app.state.pipeline.player.stop()
    with app.state.pipeline._speaking_lock:
        app.state.pipeline._speaking_count = 0
    app.state.pipeline._broadcast({"speaking": False})
    return {"status": "stopped"}
```

This is unchanged — `player.stop()` is a no-op now, and the speaking counter reset still works.

- [ ] **Step 5: Verify alerts and cues play through avatar**

Test alert: `curl -X POST http://127.0.0.1:5111/alert`

Expected: Short cue audio plays from avatar, not server.

- [ ] **Step 6: Commit**

```bash
git add server/src/claude_voice/server.py
git commit -m "refactor: alerts and cues broadcast via WebSocket, update mute/stop"
```

---

## Task 4: Remove server amplitude from frontend

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ws-client.ts`
- Modify: `src/state.ts`

- [ ] **Step 1: Remove amplitude from state.ts**

```typescript
export interface AvatarState {
  mode: Mode;
  speaking: boolean;
  mood: Mood;
  toolMood: ToolMood;
}

export function createState(): AvatarState {
  return {
    mode: 'idle',
    speaking: false,
    mood: null,
    toolMood: null,
  };
}
```

- [ ] **Step 2: Remove amplitude from ws-client.ts**

Remove the `amplitude` type from `StatusMessage` union:

```typescript
export type StatusMessage =
  | { type: 'state'; value: string }
  | { type: 'speaking'; value: boolean }
  | { type: 'mood'; value: string }
  | { type: 'tool_mood'; value: string }
  | { type: 'text'; value: string; duration: number };
```

Remove the amplitude parser line:
```typescript
if ('amplitude' in data) return { type: 'amplitude', value: data.amplitude as number };
```

Remove the amplitude case in the switch:
```typescript
case 'amplitude':
  state.amplitude = msg.value;
  break;
```

- [ ] **Step 3: Update main.ts amplitude source**

Find the amplitude section (around line 509-511) and simplify:

```typescript
// Replace:
const localAmp = getPlaybackAmplitude();
const ampSource = localAmp > 0.005 ? localAmp : state.amplitude;

// With:
const ampSource = getPlaybackAmplitude();
```

Remove `state.amplitude = 0;` from the speakingStopTimer handler (around line 100).

- [ ] **Step 4: Fix any TypeScript compilation errors**

Run: `npx tsc --noEmit`

Fix any references to `state.amplitude` that remain.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/ws-client.ts src/main.ts
git commit -m "refactor: remove server amplitude, use local playback amplitude only"
```

---

## Task 5: Remove sounddevice dependency

**Files:**
- Modify: `server/pyproject.toml`
- Modify: `server/src/claude_voice/audio_player.py` (verify no sounddevice import)

- [ ] **Step 1: Remove sounddevice from pyproject.toml**

In `server/pyproject.toml`, remove `"sounddevice>=0.4.6"` from the dependencies list.

- [ ] **Step 2: Verify server starts without sounddevice**

Run: `cd server && source .venv/bin/activate && pip uninstall sounddevice -y && python -m claude_voice.server`

Expected: Server starts successfully with no `sounddevice` import errors.

- [ ] **Step 3: Commit**

```bash
git add server/pyproject.toml
git commit -m "chore: remove sounddevice dependency"
```

---

## Task 6: End-to-end verification

- [ ] **Step 1: Full flow test**

1. Start TTS server: `cd server && source .venv/bin/activate && python -m claude_voice.server`
2. Start avatar: `npm run tauri dev`
3. Test speech: `curl -X POST http://127.0.0.1:5111/speak -H "Content-Type: application/json" -d '{"text":"End to end test. The audio should play from the avatar window, not the server."}'`
4. Test alert: `curl -X POST http://127.0.0.1:5111/alert`
5. Test mute: `curl -X POST http://127.0.0.1:5111/mute -H "Content-Type: application/json" -d '{"muted":true}'` then speak — verify no audio but animation continues
6. Test stop: send a long text, then `curl -X POST http://127.0.0.1:5111/stop` mid-speech

Expected: All audio from avatar. Lipsync works. Mute suppresses audio but not animation. Stop cuts speech.

- [ ] **Step 2: Test with Claude Code**

Open Claude Code in any project and send a prompt. Verify:
- Avatar speaks the response
- Lipsync syncs correctly
- No audio from the server process
- Tool cue sounds play from avatar

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: end-to-end verification fixes"
```
