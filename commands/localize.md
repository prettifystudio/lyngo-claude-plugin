---
description: Localize and translate the files you changed, through Lyngo
---

Run `lyngo localize` from the repository root and show the user its output. If `lyngo` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/lyngo" localize` instead. It reads the changed files and the catalogs itself, applies the server's patch, and prints what was localized, the keys added and reused, and the translations per language. Do not read or write the files yourself.

If it says the user is not logged in, tell them to run `lyngo login`. If it says there is no Lyngo project for this repository, tell them to run `lyngo init`.

$ARGUMENTS
