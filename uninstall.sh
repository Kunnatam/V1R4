#!/usr/bin/env bash
# uninstall.sh — Remove V1R4 Avatar from your system
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}\u2713${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}\u2717${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo -e "${BOLD}V1R4 Avatar — Uninstall${NC}"
echo ""
echo "  This will remove V1R4 hooks, config, and cached data from your system."
echo "  The project folder itself will NOT be deleted."
echo ""
read -rp "  Continue? (y/n) > " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo ""
    echo "  Aborted."
    exit 0
fi

# Track what we did for the summary
REMOVED=()
SKIPPED=()

# ── Phase 1: Stop Processes ──────────────────────────────────────────

echo ""
echo -e "${BOLD}Stopping processes...${NC}"

if [ -f "$SCRIPT_DIR/server/scripts/stop.sh" ]; then
    bash "$SCRIPT_DIR/server/scripts/stop.sh" 2>/dev/null || true
    ok "stop.sh executed"
else
    warn "stop.sh not found — skipping"
fi

# Fallback: kill any lingering server processes
if pkill -f "claude_voice.server" 2>/dev/null; then
    ok "Killed lingering claude_voice.server process(es)"
    REMOVED+=("Running processes")
else
    ok "No lingering TTS server processes"
fi

# ── Phase 2: Remove Hooks from settings.json ─────────────────────────

echo ""
echo -e "${BOLD}Removing hooks from ~/.claude/settings.json...${NC}"

SETTINGS_FILE="$HOME/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
    # Find a Python interpreter
    PYTHON_CMD=""
    for candidate in python3.12 python3.11 python3.10 python3; do
        if command -v "$candidate" &>/dev/null; then
            PYTHON_CMD="$candidate"
            break
        fi
    done

    if [ -z "$PYTHON_CMD" ]; then
        warn "Python not found — cannot auto-remove hooks"
        warn "Manually edit ~/.claude/settings.json and remove entries containing 'v1r4'"
        SKIPPED+=("Hook removal (no Python)")
    else
        # Detect V1R4 hooks
        V1R4_HOOKS=$("$PYTHON_CMD" - "$SETTINGS_FILE" "detect" << 'PYEOF'
import json, sys, os, tempfile

settings_path = sys.argv[1]
mode = sys.argv[2]  # "detect" or "remove"

try:
    with open(settings_path) as f:
        settings = json.load(f)
except (json.JSONDecodeError, IOError) as e:
    print(f"ERROR: Cannot parse {settings_path}: {e}", file=sys.stderr)
    sys.exit(1)

hooks = settings.get("hooks", {})

def is_v1r4(entry):
    for h in entry.get("hooks", []):
        cmd = h.get("command", "").strip().strip('"')
        low = cmd.lower()
        # Match V1R4 hooks by path patterns (current and legacy installs)
        if "v1r4" in low or "claude-voice" in low or "claude_voice" in low:
            return True
    return False

if mode == "detect":
    found = []
    for event_name, entries in hooks.items():
        for entry in entries:
            if is_v1r4(entry):
                cmd = next(h["command"] for h in entry.get("hooks", []) if is_v1r4({"hooks": [h]}))
                found.append(f"  {event_name}: {cmd}")
    print("\n".join(found) if found else "")

elif mode == "remove":
    cleaned = {}
    for event_name, entries in hooks.items():
        kept = [e for e in entries if not is_v1r4(e)]
        if kept:
            cleaned[event_name] = kept
    if cleaned:
        settings["hooks"] = cleaned
    else:
        settings.pop("hooks", None)
    # Atomic write: temp file then replace
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(settings_path), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, settings_path)
PYEOF
        ) || true

        if [ -n "$V1R4_HOOKS" ]; then
            echo ""
            echo -e "  ${YELLOW}Found V1R4 hooks:${NC}"
            echo "$V1R4_HOOKS"
            echo ""
            read -rp "  Remove these hooks? (y/n) > " REMOVE_HOOKS
            if [[ "$REMOVE_HOOKS" == "y" || "$REMOVE_HOOKS" == "Y" ]]; then
                # Back up before modifying
                cp "$SETTINGS_FILE" "${SETTINGS_FILE}.bak"
                ok "Backed up to settings.json.bak"

                if ! "$PYTHON_CMD" - "$SETTINGS_FILE" "remove" << 'PYEOF'; then
import json, sys, os, tempfile

settings_path = sys.argv[1]
mode = sys.argv[2]

try:
    with open(settings_path) as f:
        settings = json.load(f)
except (json.JSONDecodeError, IOError) as e:
    print(f"ERROR: Cannot parse {settings_path}: {e}", file=sys.stderr)
    sys.exit(1)

hooks = settings.get("hooks", {})

def is_v1r4(entry):
    for h in entry.get("hooks", []):
        cmd = h.get("command", "").strip().strip('"')
        low = cmd.lower()
        # Match V1R4 hooks by path patterns (current and legacy installs)
        if "v1r4" in low or "claude-voice" in low or "claude_voice" in low:
            return True
    return False

cleaned = {}
for event_name, entries in hooks.items():
    kept = [e for e in entries if not is_v1r4(e)]
    if kept:
        cleaned[event_name] = kept
if cleaned:
    settings["hooks"] = cleaned
else:
    settings.pop("hooks", None)

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(settings_path), suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.replace(tmp, settings_path)
PYEOF
                    fail "Failed to remove hooks — restored from backup"
                    cp "${SETTINGS_FILE}.bak" "$SETTINGS_FILE"
                    SKIPPED+=("Hook removal (error)")
                else
                    ok "V1R4 hooks removed from ~/.claude/settings.json"
                    REMOVED+=("Claude Code hooks")
                fi
            else
                warn "Hooks kept — skipping"
                SKIPPED+=("Hook removal (user declined)")
            fi
        else
            ok "No V1R4 hooks found in settings.json"
            SKIPPED+=("Hook removal (none found)")
        fi
    fi
else
    ok "~/.claude/settings.json not found — nothing to remove"
    SKIPPED+=("Hook removal (no settings.json)")
fi

# ── Phase 3: Clean CLAUDE.md ─────────────────────────────────────────

echo ""
echo -e "${BOLD}Cleaning ~/.claude/CLAUDE.md...${NC}"

CLAUDE_MD="$HOME/.claude/CLAUDE.md"
V1R4_START="<!-- V1R4-AVATAR-CONFIG-START -->"
V1R4_END="<!-- V1R4-AVATAR-CONFIG-END -->"

if [ -f "$CLAUDE_MD" ]; then
    if grep -q "$V1R4_START" "$CLAUDE_MD" 2>/dev/null; then
        # Extract the V1R4 section to show the user
        echo ""
        echo -e "  ${YELLOW}Found V1R4 configuration block:${NC}"
        sed -n "/$V1R4_START/,/$V1R4_END/p" "$CLAUDE_MD" | head -5
        echo "  ... (truncated)"
        echo ""
        read -rp "  Remove V1R4 section from CLAUDE.md? (y/n) > " REMOVE_MD
        if [[ "$REMOVE_MD" == "y" || "$REMOVE_MD" == "Y" ]]; then
            # Verify end marker exists
            if ! grep -q "$V1R4_END" "$CLAUDE_MD" 2>/dev/null; then
                warn "End marker missing — skipping to avoid data loss"
                SKIPPED+=("CLAUDE.md cleanup (missing end marker)")
            else
            # Back up before modifying
            cp "$CLAUDE_MD" "${CLAUDE_MD}.bak"
            # Remove the V1R4 section (markers inclusive)
            awk -v start="$V1R4_START" -v end="$V1R4_END" '
                $0 == start { skip=1; next }
                $0 == end   { skip=0; next }
                !skip { print }
            ' "$CLAUDE_MD" > "${CLAUDE_MD}.tmp"

            # Check if the file is now empty (only whitespace)
            if [ -z "$(tr -d '[:space:]' < "${CLAUDE_MD}.tmp")" ]; then
                echo ""
                echo -e "  ${YELLOW}CLAUDE.md is now empty after removing V1R4 section.${NC}"
                read -rp "  Delete the file entirely? (y/n) > " DELETE_MD
                if [[ "$DELETE_MD" == "y" || "$DELETE_MD" == "Y" ]]; then
                    rm -f "$CLAUDE_MD" "${CLAUDE_MD}.tmp" "${CLAUDE_MD}.bak"
                    ok "~/.claude/CLAUDE.md deleted (was empty)"
                    REMOVED+=("CLAUDE.md (deleted)")
                else
                    mv "${CLAUDE_MD}.tmp" "$CLAUDE_MD"
                    ok "V1R4 section removed (empty file kept)"
                    REMOVED+=("CLAUDE.md V1R4 section")
                fi
            else
                mv "${CLAUDE_MD}.tmp" "$CLAUDE_MD"
                ok "V1R4 section removed — other content preserved"
                REMOVED+=("CLAUDE.md V1R4 section")
            fi
            fi
        else
            warn "CLAUDE.md kept — skipping"
            SKIPPED+=("CLAUDE.md cleanup (user declined)")
        fi
    else
        ok "No V1R4 section found in CLAUDE.md"
        SKIPPED+=("CLAUDE.md cleanup (none found)")
    fi
else
    ok "~/.claude/CLAUDE.md not found — nothing to remove"
    SKIPPED+=("CLAUDE.md cleanup (no file)")
fi

# ── Phase 4: Remove Config and Cache Files ───────────────────────────

echo ""
echo -e "${BOLD}Removing config and cache files...${NC}"

# ~/.config/claude-voice
if [ -d "$HOME/.config/claude-voice" ]; then
    rm -rf "$HOME/.config/claude-voice"
    ok "~/.config/claude-voice removed"
    REMOVED+=("~/.config/claude-voice")
else
    ok "~/.config/claude-voice — not found"
fi

# ~/.claude/alert_cache
if [ -d "$HOME/.claude/alert_cache" ]; then
    rm -rf "$HOME/.claude/alert_cache"
    ok "~/.claude/alert_cache removed"
    REMOVED+=("~/.claude/alert_cache")
else
    ok "~/.claude/alert_cache — not found"
fi

# Log files
if [[ "$(uname)" == "Darwin" ]]; then
    LOG_DIR="$HOME/Library/Logs"
else
    LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
fi

LOGS_REMOVED=0
for logfile in "$LOG_DIR"/claude-voice-*; do
    if [ -f "$logfile" ]; then
        rm -f "$logfile"
        LOGS_REMOVED=$((LOGS_REMOVED + 1))
    fi
done
if [ "$LOGS_REMOVED" -gt 0 ]; then
    ok "Removed $LOGS_REMOVED log file(s) from $LOG_DIR"
    REMOVED+=("Log files ($LOGS_REMOVED)")
else
    ok "No log files found in $LOG_DIR"
fi

# Runtime temp files
TMPDIR_V1R4="${TMPDIR:-/tmp}/v1r4-$(id -u)"
if [ -d "$TMPDIR_V1R4" ]; then
    rm -rf "$TMPDIR_V1R4"
    ok "Temp directory removed: $TMPDIR_V1R4"
    REMOVED+=("Temp directory")
else
    ok "No temp directory at $TMPDIR_V1R4"
fi

# ── Phase 5: Remove macOS launchd Service ────────────────────────────

echo ""
echo -e "${BOLD}Checking for launchd service...${NC}"

if [[ "$(uname)" == "Darwin" ]]; then
    PLIST_DST="$HOME/Library/LaunchAgents/com.claude-voice.tts.plist"
    if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        rm -f "$PLIST_DST"
        ok "launchd service removed"
        REMOVED+=("launchd service")
    else
        ok "No launchd service installed"
    fi
else
    ok "Not macOS — skipping launchd check"
fi

# ── Phase 6: Remove WebView Application Data ────────────────────────

echo ""
echo -e "${BOLD}Checking for WebView application data...${NC}"

WEBVIEW_DIRS=()
if [[ "$(uname)" == "Darwin" ]]; then
    [ -d "$HOME/Library/Application Support/com.v1r4.avatar" ] && \
        WEBVIEW_DIRS+=("$HOME/Library/Application Support/com.v1r4.avatar")
else
    [ -d "$HOME/.config/v1r4-avatar" ] && \
        WEBVIEW_DIRS+=("$HOME/.config/v1r4-avatar")
    [ -d "$HOME/.local/share/v1r4-avatar" ] && \
        WEBVIEW_DIRS+=("$HOME/.local/share/v1r4-avatar")
fi

if [ ${#WEBVIEW_DIRS[@]} -gt 0 ]; then
    echo ""
    echo -e "  ${YELLOW}Found WebView data (saved avatar, settings):${NC}"
    for dir in "${WEBVIEW_DIRS[@]}"; do
        echo "    $dir"
    done
    echo ""
    read -rp "  Remove WebView data? (y/n) > " REMOVE_WEBVIEW
    if [[ "$REMOVE_WEBVIEW" == "y" || "$REMOVE_WEBVIEW" == "Y" ]]; then
        for dir in "${WEBVIEW_DIRS[@]}"; do
            rm -rf "$dir"
            ok "Removed: $dir"
        done
        REMOVED+=("WebView application data")
    else
        warn "WebView data kept"
        SKIPPED+=("WebView data (user declined)")
    fi
else
    ok "No WebView application data found"
fi

# ── Phase 7: Summary ────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}--- Uninstall Complete ---${NC}"
echo ""

if [ ${#REMOVED[@]} -gt 0 ]; then
    echo -e "  ${BOLD}Removed:${NC}"
    for item in "${REMOVED[@]}"; do
        echo -e "    ${GREEN}\u2713${NC} $item"
    done
    echo ""
fi

if [ ${#SKIPPED[@]} -gt 0 ]; then
    echo -e "  ${BOLD}Skipped:${NC}"
    for item in "${SKIPPED[@]}"; do
        echo -e "    ${YELLOW}-${NC} $item"
    done
    echo ""
fi

echo -e "  ${BOLD}Still on disk (remove manually if desired):${NC}"
echo ""
echo -e "    ${CYAN}Project folder${NC}"
echo "      $SCRIPT_DIR"
echo ""
echo -e "    ${CYAN}Python venv${NC}  (~5-6GB)"
echo "      $SCRIPT_DIR/server/.venv"
echo "      rm -rf $SCRIPT_DIR/server/.venv"
echo ""
echo -e "    ${CYAN}Rust build cache${NC}  (~3GB)"
echo "      $SCRIPT_DIR/target"
echo "      rm -rf $SCRIPT_DIR/target"
echo ""
echo -e "    ${CYAN}Kokoro TTS model${NC}  (~350MB, shared by HuggingFace)"
echo "      ~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M"
echo "      rm -rf ~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M"
echo ""
