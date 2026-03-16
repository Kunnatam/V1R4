#!/usr/bin/env bash
# scripts/recording-off.sh - Disable recording mode (restore normal audio)
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== V1R4 Recording Mode: OFF ==="

# Restore default output to MacBook Pro Speakers
SwitchAudioSource -s "MacBook Pro Speakers" -t output
echo "Default output: MacBook Pro Speakers"

# Ensure mic stays as input
SwitchAudioSource -s "MacBook Pro Microphone" -t input
echo "Default input: MacBook Pro Microphone"

# Restart TTS server to use speakers directly
echo "Restarting TTS server..."
"$PROJECT_PATH/scripts/stop.sh"
sleep 2
"$PROJECT_PATH/scripts/start.sh"

echo ""
echo "=== Normal audio restored ==="
echo "To re-enable: $PROJECT_PATH/scripts/recording-on.sh"
