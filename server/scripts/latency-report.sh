#!/usr/bin/env bash
# latency-report.sh — Show the last TTS latency breakdown
# Reads from hook log + TTS server log to reconstruct the full pipeline timing

set -euo pipefail

if [ -d "$HOME/Library/Logs" ]; then
    HOOK_LOG="$HOME/Library/Logs/claude-voice-hook.log"
    TTS_LOG="$HOME/Library/Logs/claude-voice-tts.log"
else
    HOOK_LOG="${XDG_STATE_HOME:-$HOME/.local/state}/claude-voice-hook.log"
    TTS_LOG="${XDG_STATE_HOME:-$HOME/.local/state}/claude-voice-tts.log"
fi

LINES=${1:-20}

echo "═══════════════════════════════════════════════"
echo "  V1R4 Latency Report — last $LINES PERF entries"
echo "═══════════════════════════════════════════════"
echo ""

echo "── Hook Log (notify.sh) ──────────────────────"
if [ -f "$HOOK_LOG" ]; then
    grep "\[PERF\]" "$HOOK_LOG" | tail -n "$LINES" || echo "  (no PERF entries)"
else
    echo "  (log not found: $HOOK_LOG)"
fi

echo ""
echo "── TTS Server (pipeline + engine) ────────────"
if [ -f "$TTS_LOG" ]; then
    grep "\[PERF\]" "$TTS_LOG" | tail -n "$LINES" || echo "  (no PERF entries)"
else
    echo "  (log not found: $TTS_LOG)"
fi

echo ""
echo "── Frontend (check browser DevTools console) ─"
echo "  Look for: [PERF] First audio chunk received: Xms"
echo ""
echo "── Pipeline summary ──────────────────────────"
echo "  T0  You hit Enter"
echo "  T1  Claude generates response    (Anthropic API — not measurable)"
echo "  T2  Hook fires                   (hook log: hook entry)"
echo "  T3  Hook POSTs to server         (hook log: hook→server POST)"
echo "  T4  Server receives /speak       (TTS log: Server received /speak)"
echo "  T5  First audio chunk            (TTS log: Pipeline chunked first audio)"
echo "  T6  Frontend receives chunk      (DevTools: First audio chunk received)"
echo "  T7  Pipeline complete            (TTS log: Pipeline chunked e2e)"
echo ""
echo "═══════════════════════════════════════════════"
