#!/usr/bin/env bash
# scripts/stop.sh - Stop the TTS server and avatar
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_PATH="$PROJECT_PATH/server"
SERVER_PIDFILE="$SERVER_PATH/.server.pid"
AVATAR_PIDFILE="$PROJECT_PATH/.avatar.pid"

stop_process() {
    local name="$1" pidfile="$2"
    if [ -f "$pidfile" ]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            echo "$name stopped (PID $pid)"
        else
            echo "$name not running (stale PID $pid)"
        fi
        rm -f "$pidfile"
    else
        echo "$name not running (no PID file)"
    fi
}

stop_process "TTS server" "$SERVER_PIDFILE"
stop_process "Avatar" "$AVATAR_PIDFILE"
