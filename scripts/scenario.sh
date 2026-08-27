#!/bin/sh
# Builds a scratch repository that looks exactly like one Claude has just worked in — a real
# git history, a transcript, and the hook's tree snapshots around a run — then runs the
# real-repository suite against it.
#
# The suite mutates the repository it is pointed at (it creates, deletes and renames files to
# prove those show up), so it must never be pointed at work anyone cares about. This makes it
# a throwaway instead.
set -e
ROOT="${TMPDIR:-/tmp}/redline-scenario-$$"
IDX="${TMPDIR:-/tmp}/redline-scenario-idx-$$"
mkdir -p "$ROOT"
# Resolved: TMPDIR carries a trailing slash and /var is a symlink to /private/var on macOS,
# and the hook's state directory is keyed by the path git itself reports.
ROOT=$(cd "$ROOT" && pwd -P)
SLUG=$(printf '%s' "$ROOT" | sed 's/[^A-Za-z0-9-]/-/g')
STATE="$HOME/.claude/redline/$SLUG"
TRANSCRIPT="$HOME/.claude/projects/$SLUG"
# On a trap, not at the end: `set -e` skips the tail when the suite fails, and this writes
# into ~/.claude, where leftovers from a failed run would be read by the real extension.
cleanup() { rm -rf "$ROOT" "$STATE" "$TRANSCRIPT" "$IDX"; }
trap cleanup EXIT INT TERM
mkdir -p "$ROOT/src" "$STATE" "$TRANSCRIPT"
cd "$ROOT"
git init -q .
git config user.email scenario@example.com
git config user.name Scenario
git config commit.gpgsign false
printf 'export const kept = 1\n' > src/kept.ts
printf 'export const gone = 1\n' > src/gone.ts
printf 'export const component = 1\n' > src/component.ts
printf 'build/\n' > .gitignore
# Committed rather than set at runtime: `getConfiguration().update()` writes this file into the
# workspace, which changes the very working tree the assertions are about.
mkdir -p .vscode
printf '{\n  "redline.onRunFinished": "nothing"\n}\n' > .vscode/settings.json
git add -A
git commit -qm 'base'

snapshot() {
  cp "$(git rev-parse --git-path index)" "$IDX"
  GIT_INDEX_FILE="$IDX" git add -A --ignore-errors --
  GIT_INDEX_FILE="$IDX" git write-tree
}

# An edit from an *earlier* run, which must not be reported as part of the last one.
printf 'export const earlier = 1\n' >> src/component.ts
sleep 1

AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","timestamp":"%s","message":{"content":"extract the helper"}}\n' "$AT" \
  > "$TRANSCRIPT/session.jsonl"
printf '{"before":{"at":"%s","tree":"%s"}}\n' "$AT" "$(snapshot)" > "$STATE/runs.json"

# The run: a helper and its test created, an import updated, a file deleted, another renamed.
printf 'export const helper = () => 1\n' > src/utils.ts
printf 'it("helps", () => {})\n' > src/utils.test.ts
printf 'import { helper } from "./utils"\nexport const component = helper()\n' > src/component.ts
rm src/gone.ts
git mv src/kept.ts src/moved.ts
mkdir -p build && printf 'noise\n' > build/out.js

STOPPED=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"at":"%s","session":"scenario","tree":"%s"}\n' "$STOPPED" "$(snapshot)" > "$STATE/stopped.json"

echo "scenario repository: $ROOT"
cd - >/dev/null
REDLINE_TEST_WORKSPACE="$ROOT" REDLINE_SCENARIO=1 REDLINE_SCENARIO_STATE="$STATE" npm run test:real
