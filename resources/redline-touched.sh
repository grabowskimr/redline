#!/bin/sh
# Redline hook entry point for Claude Code.
#
# A shell wrapper rather than a direct `node` call: hooks are spawned with a minimal PATH,
# and a Node installed by nvm, Homebrew or Volta is frequently not on it. Without this, the
# hook silently records nothing — the worst outcome, since it is designed not to complain.
#
# Answers `{}` immediately and always exits 0. A hook that fails or stalls interferes with
# the tool call it is attached to, and recording file names is never worth that.
printf '{}\n'

script="${HOME}/.claude/redline-touched.mjs"
[ -r "$script" ] || exit 0

# Redline's own installation check sets this: run inline and report problems, so a failure
# is diagnosed instead of guessed at.
sync_mode="${REDLINE_HOOK_SYNC-}"

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
  [ -n "$sync_mode" ] && echo "redline-hook: no node on PATH or in the usual locations" >&2
  exit 0
fi

# Read stdin here, then hand the payload to a detached child.
#
# Claude Code waits for this process to exit, so anything done synchronously is added to
# every tool call — measured at 80-120ms for an edit and 210-350ms for Bash, where a `git
# diff` is involved. None of that work is anything the agent needs to wait for: Redline
# reacts to the log file changing, whenever that happens. The double fork detaches the
# child so it survives this shell exiting.
payload=$({ command -p cat 2>/dev/null || cat; })
[ -n "$payload" ] || exit 0
# A run-start snapshot must complete before the agent begins editing, so that one event is
# handled inline. Everything else is detached and costs the tool call nothing.
case "$payload" in
  *'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*) sync_mode=1 ;;
esac

if [ -n "$sync_mode" ]; then
  printf '%s' "$payload" | "$node" "$script" >/dev/null
  exit 0
fi
( printf '%s' "$payload" | "$node" "$script" >/dev/null 2>&1 & ) >/dev/null 2>&1
exit 0
