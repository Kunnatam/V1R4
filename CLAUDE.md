# V1R4 Avatar — Project Guide

## Architecture

```
Claude Code ──hooks──→ notify.sh (extracts <tts> tag)
                       status.sh (thinking/idle/tool state)
                              │
                              ▼
                    TTS Server (FastAPI + Kokoro 82M)
                     port 5111, chunked streaming
                     │ WebSocket      │ WebSocket
                     │ /ws/status     │ /ws/audio
                     │ (JSON)         │ (base64 PCM)
                     ▼                ▼
                    Tauri 2 + Three.js + VRM Avatar
                    (transparent overlay, always-on-top)
```

## Key Files

### Frontend (TypeScript)

| File | Purpose |
|------|---------|
| `src/main.ts` | App entry, animation loop, camera controls, right-click drag pan, scroll zoom, IndexedDB avatar persistence |
| `src/scene.ts` | Three.js scene, 7-light rig, bloom, color grade + vignette + film grain shader |
| `src/avatar.ts` | VRM loading, rest pose, MToon material enhancement, expression API |
| `src/idle.ts` | Full idle system: blinks, breathing, saccades, mouse tracking, gaze breaks, micro-expressions |
| `src/body.ts` | Mode/mood posture system, secondary motion chain, keystroke reactions, speaking gestures |
| `src/expressions.ts` | 20+ FACS-based blend shape presets with staggered transitions and overshoot |
| `src/lipsync.ts` | Viseme cycling (aa/oh/ee/ih/ou) driven by amplitude with spring smoothing |
| `src/hands.ts` | Per-finger spring animation, thinking pose, amplitude-reactive gestures |
| `src/spring.ts` | Critically damped + underdamped springs, half-life parameterized |
| `src/wind.ts` | Procedural wind for VRM spring bone hair/accessory physics |
| `src/noise.ts` | 1D Perlin noise + FBM for procedural animation |
| `src/overlay-effects.ts` | 2D canvas: border glow, sine waveform, typewriter subtitles |
| `src/ws-client.ts` | WebSocket client for /ws/status and /ws/audio |
| `src/audio-player.ts` | Web Audio AnalyserNode for local amplitude (analysis only, no speaker output) |
| `src/background.ts` | Configurable backgrounds with localStorage persistence |
| `src-tauri/src/lib.rs` | Tauri setup, context menu, CoreGraphics cursor + keystroke tracking, window state |

### Server (Python)

| File | Purpose |
|------|---------|
| `server/src/claude_voice/server.py` | FastAPI: /speak, /stop, /alert, /status, /voice, /voice-cue-mode, /mute |
| `server/src/claude_voice/tts_engine.py` | Kokoro TTS wrapper, sentence splitting, chunk merging (MIN_CHUNK_CHARS=100), Thai romanization |
| `server/src/claude_voice/audio_player.py` | sounddevice playback, clock-synced amplitude emission, running peak normalization |
| `server/src/claude_voice/pipeline.py` | SpeakPipeline: ties TTS + player + WebSocket broadcast. Chunked and full modes |
| `server/src/claude_voice/alert_cache.py` | Pre-cached audio cues by tool category + lead-in phrases by mood |

### Hooks

| File | Purpose |
|------|---------|
| `server/hooks/notify.sh` | Extracts `<tts>` from Claude responses, POSTs to /speak. Supports immediate + on-complete timing |
| `server/hooks/status.sh` | Broadcasts thinking/idle/tool state. Injects tts_verbosity into UserPromptSubmit |

## WebSocket Protocol

### /ws/status (JSON)
- `{"state": "thinking" | "idle"}` — mode changes
- `{"speaking": true | false}` — speech start/stop
- `{"amplitude": 0.0-1.0}` — lipsync amplitude (30ms interval)
- `{"mood": "error" | "success" | "warn" | "melancholy"}` — expression + border color
- `{"tool_mood": "search" | "execute" | "agent"}` — brief tool-use flash
- `{"text": "...", "duration": 1.5}` — subtitle text with duration

### /ws/audio (JSON)
- `{"pcm": "<base64>", "sr": 24000}` — raw PCM Int16 chunks for frontend amplitude analysis

## Coding Conventions

- **Spring system**: All smooth animation uses `springDamped()` or `springUnderdamped()` from `spring.ts`. Half-life parameterized (seconds). Never use raw lerp for animation.
- **Bone rotations**: VRM's `rotateVRM0()` flips model 180° on Y — all X-axis bone rotations must be negated in body.ts.
- **Expression system**: Use FACS-based blend shape combinations in `MOOD_SHAPES`. VRM `happy` bundles AU6+AU12. Layer `relaxed`, `aa`, `surprised` for nuance.
- **Mode/mood pattern**: `mode` = behavioral state (idle/thinking/speaking). `mood` = emotional overlay (error/success/warn/melancholy). Both can be active simultaneously.
- **Amplitude source**: Frontend prefers local AnalyserNode over server WebSocket amplitude. Server amplitude is fallback.

## Known Gotchas

- **EffectComposer destroys alpha** — can't use bloom with transparent windows. If `ctx.transparent`, skip composer and use `renderer.render()` directly.
- **Spring bones are a Set** — use `.size` not `.length`.
- **MToon shader** prefers hemisphere/ambient light over directional for consistent toon shading.
- **NeutralToneMapping** at exposure 1.05 — preserves MToon colors. ACES shifts hues.
- **Window position** — save as logical pixels (divide by scale_factor) to avoid HiDPI drift.
- **sounddevice OutputStream.write()** is blocking — blocks until buffer has room. Factor this into timing calculations.
- **Chunked TTS amplitude** — clock-synced to `stream_start + (sample_offset / sr) + output_latency`. Don't use wall-clock timing.
- **Sentence merging** — short sentences (< 100 chars) are merged into phrase groups for natural speech flow. Split regex: `(?<=[.!?])\s+`.
- **VRM model required** — app expects `public/models/avatar.vrm` or user-loaded model via IndexedDB.

## Testing

```bash
# TTS server
cd server && source .venv/bin/activate && python -m claude_voice.server

# Avatar (separate terminal)
npm run tauri dev

# Health check
curl http://127.0.0.1:5111/health

# Test speech
curl -X POST http://127.0.0.1:5111/speak -H "Content-Type: application/json" -d '{"text":"Hello world."}'

# Latency report
server/scripts/latency-report.sh
```
