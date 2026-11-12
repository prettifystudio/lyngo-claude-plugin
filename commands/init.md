---
description: Connect this repository to Lyngo (project, i18n setup, languages, agent hook)
---

Run `lyngo init` from the repository root and show the user its output. If `lyngo` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/lyngo" init` instead. Pass the user's arguments through, for example `--languages fr,de`. Run it with the Bash tool's timeout set to 600000 ms (10 minutes), or in the background and read its output while it runs: it can wait up to 9 minutes for GitHub.

It finds or creates the Lyngo project for the `origin` remote, detects the i18n setup, sets the languages, applies the i18n scaffolding as a patch, and registers the Lyngo MCP server and the Stop hook for this repository. When the patch edits `package.json`, it runs the project's package install itself and says to restart the dev server; tell the user. If the install fails, it prints the command to run; tell the user.

When it prints a "Language detection" note, the new `app/Http/Middleware/SetLocale.php` reads only the session: the language switcher stores the choice there. Tell the user that, then ask them which other sources to use and in which order: their saved language (a `users.locale` column), the browser language (`Accept-Language`), a language in the URL. Change `app/Http/Middleware/SetLocale.php` only after they answer, and only as they say. The other sources are in that file as comments. When a note says that no page renders the language switcher, tell the user and offer to add it to the layout file the note names.

If it says the user is not logged in, run `/lyngo:login`. When it prints a GitHub link and "Waiting for GitHub", the Lyngo GitHub App cannot read this repository yet: tell the user that GitHub opened in their browser (the link is there if it did not), that they pick the account, add the repository under Repository access and save, and that init continues by itself once the repository is added. Let it run; do not start it again. Only if it fails because the 9-minute wait ran out, run it again after the user has added the repository. In CI or with `--no-wait` it does not wait: it ends with "WAITING FOR THE PERSON" and exit code 3, which means a person must install the GitHub App first. If it stops at the language question, run it again with `--languages`.

$ARGUMENTS
