#!/usr/bin/env bash
# scripts/start.sh - Start the TTS server (and optionally the avatar)
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_PATH="$PROJECT_PATH/server"
VENV_PATH="$SERVER_PATH/.venv"
SERVER_PIDFILE="$SERVER_PATH/.server.pid"

if [ -d "$HOME/Library/Logs" ]; then
    LOGFILE="$HOME/Library/Logs/claude-voice-tts.log"
else
    LOGFILE="${XDG_STATE_HOME:-$HOME/.local/state}/claude-voice-tts.log"
fi
mkdir -p "$(dirname "$LOGFILE")"

# ── Pre-flight checks ──

if [ ! -d "$VENV_PATH" ]; then
    echo "Error: server/.venv not found."
    echo "  Run './setup.sh' or: cd server && python3 -m venv .venv && pip install -e ."
    exit 1
fi

if [[ "${1:-}" == "--avatar" ]]; then
    if ! command -v node &>/dev/null; then
        echo "Error: node not found. Install Node.js 20.19+ or 22.12+."
        exit 1
    fi
    if ! command -v cargo &>/dev/null; then
        echo "Error: cargo not found. Install Rust from https://rustup.rs"
        exit 1
    fi
fi

# ── Start TTS server ──

if [ -f "$SERVER_PIDFILE" ]; then
    if kill -0 "$(cat "$SERVER_PIDFILE")" 2>/dev/null; then
        echo -e "\033[0;32m✓\033[0m TTS server already running (PID $(cat "$SERVER_PIDFILE"))"
    else
        echo "Cleaning up stale PID file"
        rm -f "$SERVER_PIDFILE"
    fi
fi

if [ ! -f "$SERVER_PIDFILE" ]; then
    cd "$SERVER_PATH"
    "$VENV_PATH/bin/python" -m claude_voice.server >> "$LOGFILE" 2>&1 &
    echo $! > "$SERVER_PIDFILE"

    # Wait for server to be ready
    echo -n "Starting TTS server..."
    SERVER_READY=false
    for i in $(seq 1 30); do
        if curl -s http://127.0.0.1:5111/health > /dev/null 2>&1; then
            SERVER_READY=true
            break
        fi
        echo -n "."
        sleep 1
    done
    echo ""

    if [ "$SERVER_READY" = true ]; then
        echo -e "\033[0;32m✓\033[0m TTS server is running (PID $(cat "$SERVER_PIDFILE"))"
    else
        echo -e "\033[1;33m!\033[0m TTS server started (PID $(cat "$SERVER_PIDFILE")) but not responding yet"
        echo "  It may still be loading the Kokoro model (~30s on first launch)"
    fi
fi

# ── Optionally start avatar ──

if [[ "${1:-}" == "--avatar" ]]; then
    AVATAR_PIDFILE="$PROJECT_PATH/.avatar.pid"
    if [ -f "$AVATAR_PIDFILE" ] && kill -0 "$(cat "$AVATAR_PIDFILE")" 2>/dev/null; then
        echo -e "\033[0;32m✓\033[0m Avatar already running (PID $(cat "$AVATAR_PIDFILE"))"
    else
        cd "$PROJECT_PATH"
        npm run tauri dev >> "$LOGFILE" 2>&1 &
        AVATAR_PID=$!
        echo $AVATAR_PID > "$AVATAR_PIDFILE"
        # Wait briefly and verify the process didn't crash immediately
        sleep 3
        if kill -0 "$AVATAR_PID" 2>/dev/null; then
            echo -e "\033[0;32m✓\033[0m Avatar started (PID $AVATAR_PID)"
        else
            echo -e "\033[0;31m✗\033[0m Avatar process exited — check logs: tail -20 $LOGFILE"
        fi
    fi
fi

echo ""
echo "  Logs  tail -f $LOGFILE"
echo "  Stop  server/scripts/stop.sh"
echo ""
