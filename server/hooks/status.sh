#!/usr/bin/env bash
# hooks/status.sh - Send overlay state updates on hook events
# Used by: UserPromptSubmit, PreToolUse, SubagentStart, Stop

set -euo pipefail

TTS_SERVER="http://127.0.0.1:5111"
if [ -d "$HOME/Library/Logs" ]; then
    LOGFILE="$HOME/Library/Logs/claude-voice-hook.log"
else
    LOGFILE="${XDG_STATE_HOME:-$HOME/.local/state}/claude-voice-hook.log"
fi

INPUT=$(cat)

HOOK_EVENT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hook_event_name',''))" 2>/dev/null || echo "")

echo "$(date): status.sh event=$HOOK_EVENT" >> "$LOGFILE"

case "$HOOK_EVENT" in
    UserPromptSubmit)
        # Auto-start TTS server if not running
        if ! curl -s --connect-timeout 1 --max-time 1 "$TTS_SERVER/health" > /dev/null 2>&1; then
            HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
            SERVER_DIR="$(cd "$HOOK_DIR/.." && pwd)"
            VENV_PYTHON="$SERVER_DIR/.venv/bin/python"
            SERVER_PIDFILE="$SERVER_DIR/.server.pid"
            if [ -x "$VENV_PYTHON" ]; then
                cd "$SERVER_DIR"
                "$VENV_PYTHON" -m claude_voice.server >> "$LOGFILE" 2>&1 &
                echo $! > "$SERVER_PIDFILE"
                echo "$(date): auto-started TTS server (PID $!)" >> "$LOGFILE"
            fi
        fi
        # Clear TTS played flag (new turn starting)
        V1R4_RUNTIME="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/v1r4-$(id -u)"
        rm -f "$V1R4_RUNTIME/tts_played"
        # Inject TTS verbosity mode into Claude's context
        TTS_MODE_FILE="$HOME/.config/claude-voice/tts_mode"
        if [ -f "$TTS_MODE_FILE" ]; then
            echo "tts_verbosity=$(cat "$TTS_MODE_FILE")"
        else
            echo "tts_verbosity=normal"
        fi
        curl -s -X POST "$TTS_SERVER/status" \
            -H "Content-Type: application/json" \
            -d '{"state": "thinking"}' \
            --connect-timeout 1 --max-time 2 \
            >> "$LOGFILE" 2>&1 &
        ;;
    PreToolUse)
        # Build JSON safely via Python to handle tool names with special characters
        TOOL_JSON=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tool = data.get('tool_name', '')
print(json.dumps({'state': 'thinking', 'event': 'tool_use', 'tool_name': tool}))
" 2>/dev/null || echo '{"state":"thinking","event":"tool_use"}')
        curl -s -X POST "$TTS_SERVER/status" \
            -H "Content-Type: application/json" \
            -d "$TOOL_JSON" \
            --connect-timeout 1 --max-time 2 \
            >> "$LOGFILE" 2>&1 &
        ;;
    SubagentStart)
        curl -s -X POST "$TTS_SERVER/status" \
            -H "Content-Type: application/json" \
            -d '{"state": "thinking", "event": "subagent_start"}' \
            --connect-timeout 1 --max-time 2 \
            >> "$LOGFILE" 2>&1 &
        ;;
    Stop)
        curl -s -X POST "$TTS_SERVER/status" \
            -H "Content-Type: application/json" \
            -d '{"state": "idle"}' \
            --connect-timeout 1 --max-time 2 \
            >> "$LOGFILE" 2>&1 &
        ;;
esac

exit 0
