# claude-voice-hooks

Speak Claude Code's responses aloud using local TTS (Kokoro) on Apple Silicon.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
chmod 600 .env
```

## Quick Test

```bash
# Start the server
source .venv/bin/activate
python -m claude_voice.server

# In another terminal, test it:
curl -X POST http://127.0.0.1:5111/speak -H 'Content-Type: application/json' -d '{"text":"Hello from Claude voice hooks!"}'
```

## Install as Service

```bash
./scripts/install.sh    # Starts on login, restarts on crash
./scripts/uninstall.sh  # Remove service
```

## Claude Code Hook

Add to your `.claude/hooks.json`:
```json
{
  "hooks": {
    "notification": [
      {
        "type": "command",
        "command": "/path/to/claude-voice-hooks/hooks/notify.sh"
      }
    ]
  }
}
```

## Endpoints

- `POST /speak` - Speak text (with optional mood)
- `POST /alert` - Play random cached alert
- `POST /status` - Broadcast state (thinking/idle)
- `POST /stop` - Stop current playback
- `POST /voice` - Switch TTS voice
- `POST /mute` - Toggle mute
- `WS /ws/status` - Real-time state + amplitude
- `WS /ws/audio` - PCM audio streaming
- `GET /health` - Server status
