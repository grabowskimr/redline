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

# Boundaries and edit promotion are ordered with Claude's tool lifecycle. Detaching Stop
# lets the next UserPromptSubmit overtake it and destroys that prompt's starting snapshot.
sync_mode=1

# Only the plugin's own copy. There used to be a fallback to `$HOME/.claude/redline-touched.mjs`,
# from a manual install route that no longer exists — nothing writes that path any more, so all
# the fallback could still find was somebody's unversioned orphan from an old install, and run it
# in preference to nothing.
script="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/hooks/redline-touched.mjs"
if [ ! -r "$script" ]; then
  [ -n "$sync_mode" ] && printf '{}\n'
  exit 0
fi

# A minimal macOS PATH often selects Apple's Git launcher, which can stop at an
# Xcode licence prompt. Prefer an installed Homebrew Git in that case. Keep any
# explicit Git shim/custom executable already supplied by the caller.
case "$(command -v git 2>/dev/null)" in
  /usr/bin/git|"")
    for redline_git_dir in /opt/homebrew/bin /usr/local/bin; do
      if [ -x "$redline_git_dir/git" ]; then
        PATH="$redline_git_dir:$PATH"
        export PATH
        break
      fi
    done
    ;;
esac

node=$(command -v node 2>/dev/null)
if [ -z "$node" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.nvm/versions/node"/*/bin/node \
    "${ASDF_DATA_DIR:-${HOME}/.asdf}/installs/nodejs"/*/bin/node \
    "${MISE_DATA_DIR:-${HOME}/.local/share/mise}/installs/node"/*/bin/node
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

printf '%s' "$payload" | "$node" "$script"
exit 0
