---
description: Localize and translate the files you changed, through Lyngo
---

Run `lyngo localize` from the repository root and show the user its output. With `--all` it localizes the whole repository instead of the changed files, in batches of 30; use it once on a repository that was never localized, and tell the user it can take several minutes. If `lyngo` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/lyngo" localize` instead. It reads the changed files and the catalogs itself, applies the server's patch, and prints what was localized, the keys added and reused, and the translations per language. Do not read or write the files yourself.

If it says the user is not logged in, tell them to run `lyngo login`. If it says there is no Lyngo project for this repository, tell them to run `lyngo init`.

Only one Lyngo run works in a repository at a time. When another run is in progress, `lyngo localize` waits up to 2 minutes for it. When the other run is `lyngo localize --all`, it stops at once. Do not start a second run in the background. Tell the user, and run the command again when the other run ends. If it names files that it did not change because the patch did not apply, tell the user which files. The next run sends them again.

$ARGUMENTS
