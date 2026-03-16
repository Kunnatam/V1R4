#!/usr/bin/env bash
# scripts/install.sh - Install the TTS server as a launchd service
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
VENV_PATH="$PROJECT_PATH/.venv"
PLIST_SRC="$PROJECT_PATH/service/com.claude-voice.tts.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.claude-voice.tts.plist"

if [ ! -d "$VENV_PATH" ]; then
    echo "Error: .venv not found. Run 'pip install -e .' first."
    exit 1
fi

# Generate plist with actual paths
sed -e "s|__VENV_PATH__|$VENV_PATH|g" \
    -e "s|__PROJECT_PATH__|$PROJECT_PATH|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl load "$PLIST_DST"
echo "Service installed and started."
echo "Check status: launchctl list | grep claude-voice"
echo "Logs: tail -f ~/Library/Logs/claude-voice-tts.log"
