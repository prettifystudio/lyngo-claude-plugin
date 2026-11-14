#!/bin/sh
# The Stop hook of the Lyngo plugin. Claude Code runs it at every stop, in every
# repository the person opens. Outside a Lyngo project it is silent and quick:
# one git command, no Node.
#
# - A Lyngo project only: lyngo init, and every lyngo command that the server
#   answers for this repository, set lyngo.project in the repository's git
#   config. Outside a git repository, or without git, the check fails silently.
# - One run per stop: when .claude/settings.local.json or .claude/settings.json
#   still has the Stop hook that an earlier lyngo init wrote, that hook runs and
#   this one does not. Claude Code runs a plugin's hook and a settings file's
#   hook both, also when their commands are the same.
# - Nothing here reads stdin: the CLI reads Claude Code's JSON from it.
# - The project is where the session started, as for the CLI (localizeHook).
dir=${CLAUDE_PROJECT_DIR:-.}
git -C "$dir" config --local --get lyngo.project >/dev/null 2>&1 || exit 0
grep -Eqs '"command" *: *"[^"]*lyngo +localize' "$dir/.claude/settings.local.json" "$dir/.claude/settings.json" && exit 0
if command -v lyngo >/dev/null 2>&1; then
  exec lyngo localize --hook
fi
echo '{"systemMessage":"Lyngo: the CLI is not on PATH. Install it: npm i -g @prettifystudio/lyngo-cli"}'
