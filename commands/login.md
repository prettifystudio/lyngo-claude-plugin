---
description: Sign in to Lyngo from this machine (browser, one time)
---

Run `lyngo login` and show the user its output. If `lyngo` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/lyngo" login` instead. It prints a code and a URL and waits: tell the user to open the URL and enter the code. The token is saved in the user's home folder, never in the repository, and never appears in the output.

$ARGUMENTS
