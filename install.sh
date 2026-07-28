#!/usr/bin/env bash
# AEGIS for Claude Code — one-line installer
#
#   curl -fsSL https://raw.githubusercontent.com/aegisinfo/aegiscode-plugin/main/install.sh | bash
#
# To skip the interactive key prompt (e.g. in a non-interactive shell), export
# your real key first, then pipe — don't inline a placeholder:
#
#   export AEGIS_API_KEY="aegis_..."   # your real key from https://aegiscloud.org
#   curl -fsSL https://raw.githubusercontent.com/aegisinfo/aegiscode-plugin/main/install.sh | bash

set -eu

REPO="aegisinfo/aegiscode-plugin"
PLUGIN="aegiscode@aegiscode"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
error() { printf '\033[1;31mERROR\033[0m %s\n' "$1" >&2; }

# --- 1. Requirements ---------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  error "Node.js 18+ is required (the AEGIS MCP server needs it)."
  error "Install it from https://nodejs.org and re-run this script."
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js 18+ required, found $(node -v). Please upgrade and re-run."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  error "Claude Code CLI not found. Install it first: https://claude.com/claude-code"
  exit 1
fi

# --- 2. API key ---------------------------------------------------------------

AEGIS_API_KEY="${AEGIS_API_KEY:-}"

if [ -z "$AEGIS_API_KEY" ] && [ -r /dev/tty ]; then
  printf 'AEGIS API key (get one free at https://aegiscloud.org, looks like aegis_...): ' > /dev/tty
  read -r AEGIS_API_KEY < /dev/tty || true
fi

case "$AEGIS_API_KEY" in
  *your_key*|*YOUR_KEY*|*xxxxx*|*placeholder*|*changeme*)
    error "That looks like a placeholder (\"$AEGIS_API_KEY\"), not a real key — refusing to save it."
    error "Get your real key at https://aegiscloud.org, then re-run."
    exit 1
    ;;
esac

if [ -z "$AEGIS_API_KEY" ]; then
  warn "No AEGIS_API_KEY set — skipping key setup."
  warn "Add it later: echo 'export AEGIS_API_KEY=\"aegis_...\"' >> ~/.bashrc"
else
  case "$AEGIS_API_KEY" in
    aegis_*) ;;
    *) warn "That doesn't look like an AEGIS key (should start with 'aegis_') — saving it anyway." ;;
  esac

  wrote_any=0
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    if grep -q '^export AEGIS_API_KEY=' "$rc" 2>/dev/null; then
      grep -v '^export AEGIS_API_KEY=' "$rc" > "$rc.aegis-tmp" && mv "$rc.aegis-tmp" "$rc"
    fi
    printf 'export AEGIS_API_KEY="%s"\n' "$AEGIS_API_KEY" >> "$rc"
    info "Wrote AEGIS_API_KEY to $rc"
    wrote_any=1
  done
  if [ "$wrote_any" -eq 0 ]; then
    printf 'export AEGIS_API_KEY="%s"\n' "$AEGIS_API_KEY" >> "$HOME/.bashrc"
    info "Wrote AEGIS_API_KEY to $HOME/.bashrc (created)"
  fi
  export AEGIS_API_KEY
fi

# --- 3. Marketplace + plugin ---------------------------------------------------

info "Adding AEGIS marketplace..."
claude plugin marketplace add "$REPO"

info "Installing AEGIS plugin..."
claude plugin install "$PLUGIN"

echo
info "Done. Restart Claude Code (or open a new terminal), then run:"
echo "    /aegis-status"
if [ -z "$AEGIS_API_KEY" ]; then
  warn "You still need to set AEGIS_API_KEY before that will work."
fi
