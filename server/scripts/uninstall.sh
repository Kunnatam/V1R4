#!/usr/bin/env bash
# scripts/uninstall.sh - Remove the TTS server launchd service
set -euo pipefail

PLIST_DST="$HOME/Library/LaunchAgents/com.claude-voice.tts.plist"

if [ -f "$PLIST_DST" ]; then
    launchctl unload "$PLIST_DST"
    rm "$PLIST_DST"
    echo "Service stopped and removed."
else
    echo "Service not installed."
fi
