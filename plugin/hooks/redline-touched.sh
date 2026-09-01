#!/bin/sh
# Redline hook entry point for Claude Code.
#
# A shell wrapper rather than a direct `node` call: hooks are spawned with a minimal PATH,
# and a Node installed by nvm, Homebrew or Volta is frequently not on it. Without this, the
# hook silently records nothing — the worst outcome, since it is designed not to complain.
#
# Always exits 0. A hook that fails or stalls interferes with the turn it is attached to, and
# none of this is worth that.

payload=$({ command -p cat 2>/dev/null || cat; })
[ -n "$payload" ] || { printf '{}\n'; exit 0; }

# Two shapes of event:
#
#  - UserPromptSubmit runs inline and *answers*: it snapshots the tree before the agent edits
#    anything, and it is where pending review feedback is injected into the prompt. Its JSON
#    reply is the point, so it cannot be pre-empted with `{}`.
#  - Everything else records and gets out of the way: `{}` first, work detached, no time added
#    to the tool call.
sync_mode="${REDLINE_HOOK_SYNC-}"
case "$payload" in
  *'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*) sync_mode=1 ;;
esac
[ -n "$sync_mode" ] || printf '{}\n'

# Only the plugin's own copy. There used to be a fallback to `$HOME/.claude/redline-touched.mjs`,
# from a manual install route that no longer exists — nothing writes that path any more, so all
# the fallback could still find was somebody's unversioned orphan from an old install, and run it
# in preference to nothing.
script="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/hooks/redline-touched.mjs"
if [ ! -r "$script" ]; then
  [ -n "$sync_mode" ] && printf '{}\n'
  exit 0
fi

node=$(command -v node 2>/dev/null)
if [ -z "$node" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.nvm/versions/node"/*/bin/node
  do
    if [ -x "$candidate" ]; then
      node="$candidate"
      break
    fi
  done
fi
if [ -z "$node" ]; then
  [ -n "$REDLINE_HOOK_SYNC" ] && echo "redline-hook: no node on PATH or in the usual locations" >&2
  [ -n "$sync_mode" ] && printf '{}\n'
  exit 0
fi

if [ -n "$sync_mode" ]; then
  # stdout is the hook's reply and passes straight through.
  printf '%s' "$payload" | "$node" "$script"
  exit 0
fi
( printf '%s' "$payload" | "$node" "$script" >/dev/null 2>&1 & ) >/dev/null 2>&1
exit 0
