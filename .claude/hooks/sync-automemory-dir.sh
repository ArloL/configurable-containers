#!/usr/bin/env bash
# SessionStart hook: keep autoMemoryDirectory in .claude/settings.local.json
# pointed at this repo's .claude/memory, so it self-heals when the repo moves.
set -euo pipefail

dir="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[ -n "$dir" ] || exit 0

settings="$dir/.claude/settings.local.json"
[ -f "$settings" ] || exit 0

target="$dir/.claude/memory"

# No-op if already correct, so we don't rewrite the file every session.
current="$(jq -r '.autoMemoryDirectory // empty' "$settings")"
[ "$current" = "$target" ] && exit 0

tmp="$(mktemp)"
jq --arg d "$target" '.autoMemoryDirectory = $d' "$settings" > "$tmp"
mv "$tmp" "$settings"
