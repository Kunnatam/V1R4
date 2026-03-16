#!/usr/bin/env bash
# setup.sh — First-run setup wizard for V1R4 Avatar
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Spaces in path check ──
# Symlinks at ~/.config/claude-voice/hooks/ insulate settings.json from spaces,
# but the symlink *targets* still contain the project path — some shells may
# struggle resolving symlinks whose targets have spaces. Warn, don't block.
if [[ "$SCRIPT_DIR" == *" "* ]]; then
    echo ""
    warn "Project path contains spaces: $SCRIPT_DIR"
    echo "  Hook symlinks may not resolve correctly on all shells."
    echo "  Consider moving to a path without spaces if hooks fail."
fi

# ── Phase 1: Prerequisites ──────────────────────────────────────────

echo ""
echo -e "${BOLD}Checking prerequisites...${NC}"

MISSING=0

# Node.js (Vite 7 requires ^20.19.0 || >=22.12.0)
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f2)
    NODE_OK=false
    if [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 19 ]; then
        NODE_OK=true
    elif [ "$NODE_MAJOR" -ge 22 ]; then
        NODE_OK=true
    fi
    if [ "$NODE_OK" = true ]; then
        ok "node $NODE_VER"
    else
        fail "node $NODE_VER (need 20.19+ or 22+, install from https://nodejs.org)"
        MISSING=1
    fi
else
    fail "node not found (need 20.19+ or 22+, install from https://nodejs.org)"
    MISSING=1
fi

# Rust/Cargo
if command -v cargo &>/dev/null; then
    ok "cargo $(cargo --version 2>/dev/null | cut -d' ' -f2)"
else
    fail "cargo not found (install from https://rustup.rs)"
    MISSING=1
fi

# Python — try versioned binaries first, fall back to python3
PYTHON_CMD=""
for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null; then
        PY_VER=$("$candidate" --version 2>&1 | cut -d' ' -f2)
        PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
        if [ "$PY_MINOR" -ge 10 ] && [ "$PY_MINOR" -le 12 ]; then
            PYTHON_CMD="$candidate"
            ok "$candidate $PY_VER"
            break
        fi
    fi
done
if [ -z "$PYTHON_CMD" ]; then
    if command -v python3 &>/dev/null; then
        fail "python3 $(python3 --version 2>&1 | cut -d' ' -f2) (need 3.10-3.12)"
    else
        fail "python3 not found (need 3.10-3.12)"
    fi
    MISSING=1
fi

# GPU (warning only)
if [[ "$(uname)" == "Darwin" ]]; then
    if sysctl -n hw.optional.arm64 2>/dev/null | grep -q 1; then
        ok "GPU (Apple Silicon)"
    else
        warn "No Apple Silicon detected — TTS requires MPS acceleration"
    fi
elif command -v nvidia-smi &>/dev/null; then
    ok "GPU (NVIDIA CUDA)"
else
    warn "nvidia-smi not found — TTS requires CUDA GPU"
fi

if [ "$MISSING" -ne 0 ]; then
    echo ""
    fail "Missing prerequisites. Install them and re-run ./setup.sh"
    exit 1
fi

# ── Phase 2: Install Dependencies ───────────────────────────────────

echo ""
echo -e "${BOLD}Installing dependencies...${NC}"

# Frontend
echo "  npm install (downloading frontend dependencies)..."
NPM_LOG=$(mktemp)
if npm install > "$NPM_LOG" 2>&1; then
    grep -E "added|packages|up to date" "$NPM_LOG" | while IFS= read -r line; do
        echo "    $line"
    done
    ok "npm dependencies installed"
else
    fail "npm install failed:"
    tail -10 "$NPM_LOG" | while IFS= read -r line; do
        echo "    $line"
    done
    rm -f "$NPM_LOG"
    exit 1
fi
rm -f "$NPM_LOG"

# macOS: strip Gatekeeper quarantine from native binaries
# npm downloads are tagged with com.apple.quarantine, which causes
# dlopen() failures when Node tries to load platform-specific .node files.
if [[ "$(uname)" == "Darwin" ]]; then
    echo -n "  Clearing macOS quarantine flags ... "
    xattr -cr node_modules/@tauri-apps/ node_modules/@rollup/ 2>/dev/null || true
    # Re-sign ad-hoc so Gatekeeper accepts them
    find node_modules/@tauri-apps/ node_modules/@rollup/ -name '*.node' -exec codesign -f -s - {} \; 2>/dev/null || true
    ok "native binaries cleared"
fi

# Verify platform-specific optional deps actually installed (npm bug #4828)
NATIVE_OK=true
if [ ! -d "node_modules/@rollup/rollup-$(node -e "console.log(process.platform + '-' + process.arch)")" ]; then
    warn "Rollup native binary missing — reinstalling"
    rm -rf node_modules package-lock.json
    echo "  npm install (reinstalling with native binaries)..."
    npm install 2>&1 | tail -3
    if [[ "$(uname)" == "Darwin" ]]; then
        xattr -cr node_modules/@tauri-apps/ node_modules/@rollup/ 2>/dev/null || true
        find node_modules/@tauri-apps/ node_modules/@rollup/ -name '*.node' -exec codesign -f -s - {} \; 2>/dev/null || true
    fi
    NATIVE_OK=false
fi
if [ "$NATIVE_OK" = false ]; then
    ok "npm dependencies reinstalled (fixed missing native binaries)"
fi

# TTS server
if [ ! -d "server/.venv" ]; then
    echo -n "  Creating Python venv ... "
    "$PYTHON_CMD" -m venv server/.venv
    ok "venv created"
fi

echo "  pip install (this may take a few minutes — downloading PyTorch + TTS engine)..."
source server/.venv/bin/activate
PIP_LOG=$(mktemp)
if pip install -e server/ > "$PIP_LOG" 2>&1; then
    # Show key progress lines from successful install
    grep -E "Downloading|Installing|Successfully" "$PIP_LOG" | while IFS= read -r line; do
        echo "    $line"
    done
    ok "TTS server dependencies installed"
else
    echo ""
    fail "pip install failed:"
    # Show the last 20 lines which usually contain the error
    tail -20 "$PIP_LOG" | while IFS= read -r line; do
        echo "    $line"
    done
    rm -f "$PIP_LOG"
    deactivate
    exit 1
fi
rm -f "$PIP_LOG"
deactivate

# ── Phase 3: Personalization ────────────────────────────────────────

echo ""
echo -e "${BOLD}--- Personalization ---${NC}"
echo ""

# Check if CLAUDE.md already has V1R4 personality config
CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
SKIP_PERSONALITY=false

if [ -f "$CLAUDE_MD" ] && grep -q "V1R4-AVATAR-CONFIG-START" "$CLAUDE_MD" 2>/dev/null; then
    echo -e "  ${CYAN}Detected existing V1R4 personality in ~/.claude/CLAUDE.md${NC}"
    echo "  Your avatar already has a personality configured."
    echo ""
    read -rp "  Re-run personalization? This will update only the V1R4 section. (y/n) > " REDO_PERSONALITY
    if [[ "$REDO_PERSONALITY" != "y" && "$REDO_PERSONALITY" != "Y" ]]; then
        SKIP_PERSONALITY=true
        ok "Personalization skipped — keeping existing config"
    fi
    echo ""
fi

if [ "$SKIP_PERSONALITY" = false ]; then

    echo -e "  ${YELLOW}These answers shape your avatar's identity and voice.${NC}"
    echo -e "  ${YELLOW}Results will be written to ~/.claude/CLAUDE.md and server/.env${NC}"
    echo ""

    # Q1: Your name
    echo -e "${BOLD}  Who are you?${NC}"
    echo "  How should the avatar refer to you in speech?"
    read -rp "  Your name > " USER_NAME
    if [ -z "$USER_NAME" ]; then
        USER_NAME="User"
    fi

    # Q2: Avatar name
    echo ""
    echo -e "${BOLD}  What's your avatar's name?${NC}"
    echo "  Give your avatar a name. This is how Claude will refer to them."
    read -rp "  Avatar name (default: V1R4) > " AVATAR_NAME
    if [ -z "$AVATAR_NAME" ]; then
        AVATAR_NAME="V1R4"
    fi

    # Q3: Avatar bio / personality
    echo ""
    echo -e "${BOLD}  Who is ${AVATAR_NAME}?${NC}"
    echo "  Describe the personality — this controls how the avatar speaks through TTS."
    echo ""
    echo "  1) Chill      — casual, concise, relaxed. Like talking to a friend."
    echo "  2) Energetic  — enthusiastic, encouraging. Celebrates wins, stays positive."
    echo "  3) Dry        — minimal, deadpan. No filler. Says what happened and stops."
    echo "  4) Custom     — write your own personality description"
    read -rp "  > " PERSONALITY_CHOICE

    case "$PERSONALITY_CHOICE" in
        1) PERSONALITY_PROMPT="When generating TTS summaries, speak as ${AVATAR_NAME} — casual and concise. Short sentences, relaxed tone. Like talking to a friend." ;;
        2) PERSONALITY_PROMPT="When generating TTS summaries, speak as ${AVATAR_NAME} — enthusiastic and encouraging. Upbeat. Celebrate wins, stay positive on problems." ;;
        3) PERSONALITY_PROMPT="When generating TTS summaries, speak as ${AVATAR_NAME} — minimal and deadpan. No filler. Say what happened and stop." ;;
        4)
            echo ""
            echo "  Describe ${AVATAR_NAME}'s personality in your own words."
            echo "  This gets injected directly into Claude's instructions."
            read -rp "  > " CUSTOM_PERSONALITY
            if [ -z "$CUSTOM_PERSONALITY" ]; then
                PERSONALITY_PROMPT="When generating TTS summaries, speak as ${AVATAR_NAME} — naturally and clearly."
            else
                PERSONALITY_PROMPT="When generating TTS summaries, speak as ${AVATAR_NAME} — ${CUSTOM_PERSONALITY}"
            fi
            ;;
        *) PERSONALITY_PROMPT="When generating TTS summaries, speak as ${AVATAR_NAME} — casual and concise. Short sentences, relaxed tone. Like talking to a friend." ;;
    esac

    # Q4: Voice
    echo ""
    echo -e "${BOLD}  What does ${AVATAR_NAME} sound like?${NC}"
    echo "  Choose a starting voice. You can switch between 20+ voices anytime"
    echo "  from the right-click menu."
    echo -e "  ${YELLOW}(writes to server/.env)${NC}"
    echo ""
    echo "  Female:"
    echo "  1) Heart   — warm, expressive (recommended)"
    echo "  2) Bella   — clear, confident"
    echo "  3) Nicole  — soft, calm"
    echo ""
    echo "  Male:"
    echo "  4) Adam    — deep, steady"
    echo "  5) Puck    — bright, energetic"
    echo "  6) Daniel  — smooth, British"
    echo ""
    read -rp "  > " VOICE_CHOICE

    case "$VOICE_CHOICE" in
        1)  VOICE_ID="af_heart" ;;
        2)  VOICE_ID="af_bella" ;;
        3)  VOICE_ID="af_nicole" ;;
        4)  VOICE_ID="am_adam" ;;
        5)  VOICE_ID="am_puck" ;;
        6)  VOICE_ID="bm_daniel" ;;
        *)  VOICE_ID="af_heart" ;;
    esac

    # Q5: Verbosity
    echo ""
    echo -e "${BOLD}  How much should ${AVATAR_NAME} say?${NC}"
    echo "  Controls how detailed the spoken summaries are."
    echo -e "  ${YELLOW}(writes to ~/.config/claude-voice/tts_mode)${NC}"
    echo ""
    echo "  1) Normal  — short summaries, key points only"
    echo "  2) Verbose — detailed play-by-play of everything Claude did"
    read -rp "  > " VERBOSITY_CHOICE

    case "$VERBOSITY_CHOICE" in
        1) TTS_VERBOSITY="normal" ;;
        2) TTS_VERBOSITY="verbose" ;;
        *) TTS_VERBOSITY="normal" ;;
    esac

fi

# ── Phase 4: Generate Config Files ──────────────────────────────────

echo ""
echo -e "${BOLD}--- Configuration ---${NC}"

mkdir -p "$CLAUDE_DIR"

if [ "$SKIP_PERSONALITY" = false ]; then

    echo ""
    echo -e "  ${YELLOW}Updating ~/.claude/CLAUDE.md${NC}"
    echo "  This adds V1R4 TTS configuration to your Claude instructions."
    echo "  Your existing CLAUDE.md content will NOT be touched."
    echo ""

# Section markers — only content between these markers is managed by setup.sh
V1R4_START="<!-- V1R4-AVATAR-CONFIG-START -->"
V1R4_END="<!-- V1R4-AVATAR-CONFIG-END -->"

read -r -d '' CLAUDE_MD_CONTENT << MDEOF || true
${V1R4_START}
## V1R4 Avatar — TTS Configuration

### User Identity

Refer to the user as **${USER_NAME}**.

### Avatar Identity

The avatar's name is **${AVATAR_NAME}**. When speaking through TTS, Claude speaks as ${AVATAR_NAME}.

### TTS Voice Notifications

Every response MUST begin with a hidden \`<tts>\` tag containing a spoken summary for voice output.

Format — wrap in HTML comment so it stays invisible in terminal:
\`\`\`
<!-- <tts>spoken summary here</tts> -->
<!-- <tts mood="error">something went wrong</tts> -->
\`\`\`

The \`<!-- -->\` wrapper is mandatory — without it the spoken text renders visibly in the terminal.

Optional \`mood\` attribute for overlay border color: \`error\`, \`success\`, \`warn\`, \`melancholy\`. Omit for default purple.

${PERSONALITY_PROMPT}
Natural speech, no markdown/emoji. Never let style reduce accuracy.

**Critical: TTS and terminal text are separate channels.**
- The \`<tts>\` tag is the voice channel — full spoken response, hidden from terminal.
- Terminal text is a short technical supplement — code details, bullet points.
- They complement each other, never repeat each other.

**TTS has two modes** (check \`<user-prompt-submit-hook>\` for \`tts_verbosity=\` value):

- **normal** (default): Short, concise sentences. Summarize only key technical points.
  Example: "Refactored the handler. Removed duplicate state updates. Race condition is gone. Logs are clean."

- **verbose**: Thorough and complete. Say everything — every file changed, every decision made, every detail worth mentioning. No length limit. Still ${AVATAR_NAME}'s voice, but comprehensive.
  Example: "Opened pipeline dot py. Found the race condition on line forty-seven. Two threads hitting the state dict without a lock. Added an asyncio lock around the update block. Tested with three concurrent speaks. Logs are clean."
${V1R4_END}
MDEOF

    # Smart-merge: replace only the V1R4 section, preserve everything else
    if [ -f "$CLAUDE_MD" ]; then
        if grep -q "$V1R4_START" "$CLAUDE_MD" 2>/dev/null; then
            # Replace existing V1R4 section (between markers)
            # Use awk to preserve content before and after markers
            awk -v start="$V1R4_START" -v end="$V1R4_END" -v new="$CLAUDE_MD_CONTENT" '
                $0 == start { skip=1; printed=1; print new; next }
                $0 == end { skip=0; next }
                !skip { print }
            ' "$CLAUDE_MD" > "${CLAUDE_MD}.tmp" && mv "${CLAUDE_MD}.tmp" "$CLAUDE_MD"
            ok "V1R4 section updated in ~/.claude/CLAUDE.md (existing content preserved)"
        else
            # Append V1R4 section to existing file
            echo "" >> "$CLAUDE_MD"
            echo "$CLAUDE_MD_CONTENT" >> "$CLAUDE_MD"
            ok "V1R4 section appended to ~/.claude/CLAUDE.md (existing content preserved)"
        fi
    else
        # No existing file — create with V1R4 section
        echo "$CLAUDE_MD_CONTENT" > "$CLAUDE_MD"
        ok "~/.claude/CLAUDE.md created"
    fi

fi

# Smart-merge hooks into settings.json
echo ""
echo -e "  ${YELLOW}Merging hooks into ~/.claude/settings.json${NC}"
echo "  This registers V1R4's hook scripts with Claude Code."
echo "  Existing hooks and settings are preserved — only V1R4 entries are added."
echo ""

SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# Create stable symlinks so settings.json paths survive project moves.
# Re-running setup.sh from a new location updates the symlinks automatically.
HOOK_LINK_DIR="$HOME/.config/claude-voice/hooks"
mkdir -p "$HOOK_LINK_DIR"
ln -sf "$SCRIPT_DIR/server/hooks/notify.sh" "$HOOK_LINK_DIR/notify.sh"
ln -sf "$SCRIPT_DIR/server/hooks/status.sh" "$HOOK_LINK_DIR/status.sh"
ok "Hook symlinks created in $HOOK_LINK_DIR/"

NOTIFY_PATH="$HOOK_LINK_DIR/notify.sh"
STATUS_PATH="$HOOK_LINK_DIR/status.sh"

"$PYTHON_CMD" - "$SETTINGS_FILE" "$NOTIFY_PATH" "$STATUS_PATH" << 'PYEOF'
import json, sys, os

settings_path, notify_path, status_path = sys.argv[1], sys.argv[2], sys.argv[3]

if os.path.exists(settings_path):
    with open(settings_path) as f:
        settings = json.load(f)
else:
    settings = {}

hooks = settings.setdefault("hooks", {})

def has_v1r4_hook(event_entries):
    for entry in event_entries:
        for h in entry.get("hooks", []):
            if "v1r4" in h.get("command", "").lower():
                return True
    return False

def add_hook_group(event_name, commands, matcher=None):
    entries = hooks.setdefault(event_name, [])
    if has_v1r4_hook(entries):
        return False
    group = {"hooks": [{"type": "command", "command": cmd} for cmd in commands]}
    if matcher:
        group["matcher"] = matcher
    entries.append(group)
    return True

add_hook_group("Stop", [notify_path, status_path])
add_hook_group("UserPromptSubmit", [status_path])
add_hook_group("PreToolUse", [status_path, notify_path])
add_hook_group("SubagentStart", [status_path])
add_hook_group("PermissionRequest", [notify_path])

for matcher in ["idle_prompt", "permission_prompt", "elicitation_dialog"]:
    entries = hooks.setdefault("Notification", [])
    exists = any(
        e.get("matcher") == matcher and any("v1r4" in h.get("command", "").lower() for h in e.get("hooks", []))
        for e in entries
    )
    if not exists:
        entries.append({
            "matcher": matcher,
            "hooks": [{"type": "command", "command": notify_path}]
        })

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF

ok "~/.claude/settings.json — hooks merged"

if [ "$SKIP_PERSONALITY" = false ]; then

    # Write server/.env
    echo ""
    echo -e "  ${YELLOW}Writing server/.env${NC}"
    echo "  TTS voice and speed settings for the local speech server."
    echo ""
    cat > server/.env << EOF
TTS_VOICE=${VOICE_ID}
TTS_SPEED=1.1
PORT=5111
EOF
    ok "server/.env written (voice=${VOICE_ID})"

    # Write tts_mode
    echo ""
    echo -e "  ${YELLOW}Writing ~/.config/claude-voice/tts_mode${NC}"
    echo "  Controls how detailed the avatar's spoken summaries are."
    echo ""
    TTS_CONFIG_DIR="$HOME/.config/claude-voice"
    mkdir -p "$TTS_CONFIG_DIR"
    echo "$TTS_VERBOSITY" > "$TTS_CONFIG_DIR/tts_mode"
    ok "~/.config/claude-voice/tts_mode written (${TTS_VERBOSITY})"

fi

# ── Phase 5: Validation & Summary ───────────────────────────────────

echo ""

# Make hook scripts executable
chmod +x server/hooks/notify.sh server/hooks/status.sh

# Check VRM model
mkdir -p public/models
if [ ! -f "public/models/avatar.vrm" ]; then
    echo -e "${YELLOW}${BOLD}--- WARNING ---${NC}"
    echo ""
    warn "No avatar model found. The avatar will NOT render without a VRM file."
    echo "  Download a .vrm from https://hub.vroid.com/ and save it as:"
    echo -e "    ${CYAN}public/models/avatar.vrm${NC}"
    echo ""
fi

# Post-install health check — verify TTS server can import
echo -e "  ${YELLOW}Verifying TTS server (may download model on first run)...${NC}"
if (cd server && source .venv/bin/activate && python -c "from claude_voice.server import create_app; print('ok')" 2>&1 | tail -1 | grep -q "ok"); then
    ok "TTS server imports verified"
else
    warn "TTS server import check failed — run 'cd server && source .venv/bin/activate && pip install -e .' to fix"
fi

echo ""
echo -e "${YELLOW}${BOLD}--- Note ---${NC}"
echo ""
echo "  First launch will download the Kokoro TTS model (~350MB)."
echo "  This is a one-time download cached at ~/.cache/huggingface/."
echo ""

echo -e "${GREEN}${BOLD}--- Ready ---${NC}"
echo ""
echo "  The TTS server auto-starts when you use Claude Code."
echo "  Just start the avatar and go:"
echo ""
echo -e "    ${CYAN}npm run tauri dev${NC}"
echo ""
echo "  Or start everything manually:"
echo -e "    ${CYAN}server/scripts/start.sh --avatar${NC}"
echo ""
echo "  Stop:"
echo -e "    ${CYAN}server/scripts/stop.sh${NC}"
echo ""
