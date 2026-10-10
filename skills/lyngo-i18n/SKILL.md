---
name: lyngo-i18n
description: Use whenever you write or change text a person will read (views, components, PHP responses, toasts, notifications) in a project connected to Lyngo, and whenever the user asks to localize or translate. Lyngo knows the project's keys, glossary, refused strings and catalog format.
---

# Writing user-facing text in a Lyngo project

This project's localization is kept by Lyngo. `lyngo init` connected this
repository: the `lyngo` MCP server answers questions about the project, and the
`lyngo` command localizes and translates what you changed. Use them instead of
inventing keys or translating by hand: they keep the keys, the wording and the
translations consistent with everything the project already has.

## When

1. **Once per session**, before your first edit to a view or component: call
   the MCP tool `status`. It tells you the primary language, the target
   languages, the i18n library and call (`__()`, `t()`, `$t()`, `$_()`), the
   catalog folder, and the strings the developers refused to localize.
2. **Before you write new text a person reads**: call `lookup` with those texts.
   - `key_exists: true`: write the i18n call with exactly that key.
   - `similar_keys` not empty: reuse one of them instead of adding a near
     duplicate ("Save" next to "save" or "Save.").
   - `refused: true`: leave the text hardcoded. The developers took it out of
     localization on purpose.
   - Otherwise write the text in plain words, in the primary language. Do not
     invent a key; `lyngo localize` wraps it and adds the key.
3. **`check`** lists the user-facing strings of one file when you are not sure
   what Lyngo will pick up.
4. **When the user asks to localize or translate what you changed**, or at the
   end of a task that added text: run `lyngo localize` from the repository root
   (if `lyngo` is not on PATH: `node "${CLAUDE_PLUGIN_ROOT}/bin/lyngo" localize`)
   and show the user its output. It reads the changed files and catalogs itself
   and applies the patch; never read or write those files yourself for this.
   The Stop hook that `lyngo init` installed runs it at the end of a task too.
5. Scans, pull requests, the glossary, refusals and the translation editor live
   in the Lyngo web app. When the user asks for one of them, tell them where it
   is; do not try to do it from here.

## What is never copy

Text handed to a machine stays as it is, even when it reads like a sentence:
log lines, exception messages, HTTP and API payloads, model prompts, commit
messages, branch and PR titles, cache, session and queue keys, slot names
(`->with('success', ...)`), CSS classes, file paths, and a language's own name
in a language switcher ("Français"). Lyngo applies these rules; do not wrap such
text yourself either.

## Do not

- Do not translate catalog values yourself. Lyngo uses the project's glossary,
  translation memory and plural rules, and verifies every value.
- Do not reformat or reorder catalog files.
- Do not run `lyngo localize` per file or per edit. One run for the whole
  change, at the end.
