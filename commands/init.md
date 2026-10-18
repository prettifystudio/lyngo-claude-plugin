---
description: Connect this repository to Lyngo (project, i18n setup, languages, agent hook)
---

Run `lyngo init` from the repository root and show the user its output. If `lyngo` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/lyngo" init` instead. Pass the user's arguments through, for example `--languages fr,de`.

It finds or creates the Lyngo project for the `origin` remote, detects the i18n setup, sets the languages, applies the i18n scaffolding as a patch, and registers the Lyngo MCP server and the Stop hook for this repository. It never runs `npm install`; when it prints an install command, tell the user.

If it says the user is not logged in, run `/lyngo:login`. If it prints a GitHub link and waits, tell the user to open it and add the repository to the Lyngo GitHub App; init continues by itself once that is done. If it stops at the language question, run it again with `--languages`.

$ARGUMENTS
