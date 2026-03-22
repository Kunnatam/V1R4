# Decouple Audio Playback — Design Spec

## Problem

The TTS server currently handles both audio generation AND speaker playback via `sounddevice`. This couples playback to the server machine, prevents running the server remotely, and requires `portaudio` system libraries.

## Goal

Move audio playback from the server to the avatar (Web Audio API). The server becomes a pure TTS API: text in, PCM chunks out over WebSocket. The avatar plays all audio and handles amplitude analysis for lipsync.

## Architecture

```
Before:
  Server: Kokoro TTS → sounddevice (speakers) + /ws/audio (PCM for analysis)
  Avatar: /ws/audio → amplitude analysis only (no playback)

After:
  Server: Kokoro TTS → /ws/audio (PCM only)
  Avatar: /ws/audio → Web Audio API (speakers) + amplitude analysis
```

## Server Changes

### audio_player.py

- Remove `sounddevice` import and all speaker playback
- Remove the amplitude emitter thread and clock-sync logic (`amp_emitter`, `shared_lock`, `samples_written`, `running_peak`, etc.)
- Remove `play()`, `play_queued()`, `_play_with_retry()`, `_play_with_amplitude()` methods
- Remove `stream()` context manager — pipeline broadcasts PCM directly without going through the player
- Add `interruptible_sleep()` using `threading.Event` so `/stop` can interrupt sleeping speak/cue threads
- Keep volume as a multiplier on PCM data before broadcasting (for mute support)
- `numpy` stays — still needed for PCM format conversion (int16 ↔ float32)

### pipeline.py

- Remove amplitude broadcast via `/ws/status` (`{"amplitude": ...}`)
- `speak()` and `speak_chunked()` no longer call speaker playback — only generate PCM and broadcast via `/ws/audio`
- `_start_speaking()` / `_stop_speaking()` state management stays (avatar still needs speaking start/stop signals)

### server.py

- **Mute:** sets a flag that suppresses `/ws/audio` PCM broadcasts. All `/ws/status` signals (`speaking`, `state`, `mood`, `text`) continue as normal — animation works without audio.
- **Alert/cue playback** (`play_alert()`, `play_cue()` closures): replace `pipeline.player.play()` calls with PCM encoding (float32 → int16 base64) and broadcast via `audio_broadcaster`. Same path as regular TTS audio.
- Remove `sounddevice` from startup/shutdown lifecycle

### pyproject.toml

- Remove `sounddevice` from dependencies
- `numpy` stays (required for PCM conversion)

## Frontend Changes

### audio-player.ts

- Connect Web Audio chain: `AudioBufferSourceNode` → `analyser` → `destination` (speakers)
  - Currently: source → analyser (no speaker output)
  - After: source → analyser → destination
- Existing `nextPlayTime` scheduling already handles gapless playback. Only addition: late-chunk guard (`if (nextPlayTime < currentTime) nextPlayTime = currentTime`) — already present on line 52. No new jitter buffer code needed.
- `getPlaybackAmplitude()` stays unchanged — already reads from `analyser`

### main.ts

- Remove server amplitude fallback: `const ampSource = localAmp > 0.005 ? localAmp : state.amplitude`
  - Simplify to: `const ampSource = getPlaybackAmplitude()`
- Remove `state.amplitude` from `AvatarState` (no longer populated by server)
- Remove `state.amplitude = 0` from the `speakingStopTimer` handler
- **Speaking-stop vs audio drain:** `resetAudioPlayback()` must not zero `nextPlayTime` until all queued audio has finished. Guard with: only reset if `audioCtx.currentTime >= nextPlayTime` (queue is drained). Otherwise, let the remaining audio play out naturally — the `speaking=false` signal controls animation, not audio cutoff.

### ws-client.ts

- Remove amplitude handling from `/ws/status` message dispatch (the `amplitude` message type)
- `/ws/audio` connection stays as-is

### state.ts

- Remove `amplitude` field from `AvatarState` if it exists there

## Data Flow (After)

```
1. Hook sends text to POST /speak
2. Server generates PCM via Kokoro (chunked streaming)
3. Server broadcasts {"speaking": true} via /ws/status
4. Server broadcasts {"pcm": "<base64>", "sr": 24000} via /ws/audio per chunk
5. Avatar receives PCM chunk in audio-player.ts
6. Avatar decodes int16 → float32, creates AudioBuffer
7. Avatar schedules playback: source → analyser → destination (speakers)
8. Animation loop reads getPlaybackAmplitude() for lipsync
9. Server broadcasts {"speaking": false} via /ws/status when done
10. Avatar lets remaining queued audio play out, then resets
```

## What Stays the Same

- Kokoro TTS generation (tts_engine.py) — untouched
- /ws/audio WebSocket format: `{"pcm": "<base64 int16>", "sr": 24000}`
- /ws/status broadcasts: `speaking`, `state`, `mood`, `text`, `tool_mood`
- All avatar animation: lipsync, expressions, idle, body, wind
- Hook scripts (notify.sh, status.sh)
- Alert cache generation (alert_cache.py generates PCM, just doesn't play it)

## What Gets Removed

- `sounddevice` Python dependency + `portaudio` system requirement
- `audio_player.py`: `play()`, `play_queued()`, `_play_with_retry()`, `_play_with_amplitude()`, amplitude emitter thread, clock-sync logic
- `server.py`: `play_alert()` / `play_cue()` direct `player.play()` calls (replaced with WebSocket broadcast)
- Server-side `{"amplitude": ...}` broadcasts via `/ws/status`
- Frontend: `state.amplitude`, server amplitude fallback

## Risks

- **WebSocket jitter** — on localhost, latency is <1ms. Existing `nextPlayTime` scheduling handles gaps.
- **Web Audio API reliability** — less battle-tested than `sounddevice` for gapless streaming, but the scheduling pattern is proven.
- **AudioContext suspension** — browsers suspend AudioContext until user interaction. Already handled (audio-player.ts resumes on first chunk).
- **Speaking-stop race** — server may send `speaking=false` before all audio chunks have played. Mitigated by letting queued audio drain before resetting.

## Testing

- TTS speech plays through avatar speakers (not server)
- Lipsync still syncs correctly with speech
- Alert/cue sounds play through avatar
- Mute endpoint suppresses audio but animation continues
- No `sounddevice` or `portaudio` needed to run server
- Gapless playback on chunked streaming (no pops/gaps between chunks)
- `speaking=false` doesn't cut off audio mid-sentence
