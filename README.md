# lyngo

Manual: https://docs.lyngo.app (every page also as Markdown; https://docs.lyngo.app/llms-full.txt for agents).

Localization for Laravel applications, from your terminal: Blade, Livewire, PHP, and Inertia with React, Vue or Svelte. Your agent builds the product;
Lyngo keeps it localized.

When you or your agent add text a person reads, `lyngo localize` wraps it with
your project's i18n calls, reuses the keys you already have, and translates the
catalogs with your glossary, translation memory and plural rules, before you
commit. The files come back to your working tree as one patch. A model never
holds them. The work runs as a job on the server: the CLI starts it, checks on
it every few seconds and applies the result, so a large change set takes as
long as it needs instead of hitting a time limit.

## Install

You need a Lyngo account (lyngo.app) and Node 20 or newer.

```bash
npm i -g @prettifystudio/lyngo-cli
lyngo login          # opens the browser once; the token goes to ~/.config/lyngo/token
cd your-repository
lyngo init           # project, i18n setup, languages, agent hook
```

`lyngo init` does this, in order:

1. Shows the workspace it uses. `--workspace <name>` picks another one.
2. Finds the Lyngo project for the repository's `origin` remote, or creates it
   when you own the workspace. When the Lyngo GitHub App cannot read the
   repository yet, it prints the GitHub link where you add it, opens it in your
   browser (in a terminal it asks first) and waits until you have added it: up
   to 10 minutes in a terminal, 9 minutes for an agent or a script. Then it
   continues by itself. When `CI` is set, or with `--no-wait`, it does not wait:
   it stops with exit code 3, and the next run continues. With the project, it
   marks the repository as a Lyngo project: `lyngo.project = true` in the repository's
   git config (`.git/config`, never committed). The plugin's Stop hook reads
   it, and does nothing in other repositories. Every other command that the
   server answers for the repository sets it too.
3. Detects the framework and the i18n library.
4. Sets the languages: `--languages fr,de`, or it asks.
5. Applies the i18n setup as a patch to your working tree. When the patch
   edits `package.json`, it runs your package manager's install (npm, pnpm,
   yarn or bun, read from the lockfile) so the lockfile and `node_modules`
   follow. Restart your dev server afterwards. `--no-install` prints the
   command instead of running it.
6. When Claude Code is installed: registers the Lyngo MCP server for this
   repository in Claude Code's local scope (stored in your home folder, never in
   the repository). Claude Code loads it when the next session starts. Until
   then, the agent uses `lyngo status`, `lyngo lookup` and `lyngo check`. The
   Stop hook runs `lyngo localize --hook` when your agent finishes a task. It
   comes with the Claude Code plugin (see below): a session that has the plugin
   runs it from the first stop after init, with no restart. Without the plugin,
   init adds the hook to `.claude/settings.local.json`; in an open Claude Code
   session it then says to restart: exit, then run `claude --continue` to keep
   the conversation. In a terminal, init never asks for a restart.

Run it again at any time: it prints the state and changes nothing that is
already set up.

## Daily use

- With an agent: build as usual. The hook runs `lyngo localize --hook` at the
  end of every task. You see one line (what was localized and translated); the
  agent gets the full report and tells you what changed. It stays silent when
  nothing changed, and sends a file again only after it is edited. This is
  also true after a `lyngo localize` or `lyngo localize --all` that you run
  yourself: the next stop sends only the files edited after that run.
- Without an agent: run `lyngo localize` before you commit.
- One Lyngo run at a time in a repository. `localize`, `translate` and `init`
  hold a lock file in the git directory (`.git/lyngo.lock`, never tracked).
  When the hook finds another run, it does nothing and says so in one line.
  The next stop sends the changes. A command that you start waits up to 2
  minutes for the other run, and stops at once when the other run is
  `localize --all`. A lock whose process is dead, or that nobody touched for
  15 minutes, is taken over.
- When the patch does not apply as a whole, the CLI applies it file by file.
  It names each file it did not change, keeps those blocks in a temporary
  file, and exits with code 1. The next run sends those files again.
- A repository that was never localized: `lyngo localize --all` once. It walks
  every source file a scan would read, in batches. It also reads the new
  files that git does not track yet and does not ignore. It leaves the result
  in your working tree to review and commit. No pull request.
- Anything pushed without it still gets a pull request from the Lyngo GitHub
  App.

## Commands

| Command | What it does |
|---|---|
| `lyngo login` | Signs in through the browser and saves the token (mode 600) |
| `lyngo logout` | Revokes the token and deletes it from this machine |
| `lyngo whoami` | The account, the token prefix and your workspaces |
| `lyngo init` | Connects the repository (see above). Flags: `--languages`, `--workspace`, `--yes`, `--github`, `--no-wait`, `--no-install` |
| `lyngo localize` | Localizes and translates what changed in the working tree, as server jobs of up to 100 files. It sends the catalogs and Laravel's `lang/<code>/*.php` with the files, and prints what the server skipped or left untranslated. Flags: `--all` (the whole repository, in batches), `--languages`, `--no-translate`, `--dry`, `--hook` (the Claude Code Stop hook) |
| `lyngo translate <code>…` | Fills every key a language's catalog lacks, from the primary catalog, as server jobs of 100 keys |
| `lyngo check <file>` | The user-facing strings of one file |
| `lyngo lookup <text>…` | For each text: the key exists, similar keys, refused, the languages that have it |
| `lyngo status` | The project as Lyngo knows it |

Configuration: `LYNGO_HOST` (default `https://lyngo.app`), `LYNGO_TOKEN`
(otherwise `~/.config/lyngo/token`), `LYNGO_JOB_TIMEOUT` (seconds to wait for
one job, default 3900). Revoke tokens in Lyngo under Settings, CLI.

## The Claude Code plugin (optional)

This repository is also a Claude Code plugin. It adds the commands
`/lyngo:init`, `/lyngo:localize`, `/lyngo:status` and `/lyngo:login`, the
`lyngo-i18n` skill, which makes the agent check existing keys before it writes
new text, and the Stop hook. It needs the `lyngo` command from npm; `lyngo init`
prints these two lines when the plugin is not installed yet.

```bash
claude plugin marketplace add prettifystudio/lyngo-claude-plugin
claude plugin install lyngo@lyngo
```

Since 0.2.22 the plugin ships the Stop hook (`hooks/hooks.json`). Claude Code
loads plugin hooks when a session starts, so the hook is already there when
`lyngo init` runs in that session. It runs at every stop in every repository,
and does something only where `lyngo.project` is set in the repository's git
config. Outside a Lyngo project it runs one git command and prints nothing.
When an earlier `lyngo init` put the Stop hook in `.claude/settings.local.json`,
the plugin's hook leaves the stop to that one, so the hook runs once. The
plugin's SessionStart hook sets `LYNGO_PLUGIN_HOOK=1` for the commands of the
session: that is how `lyngo init` knows that the hook runs in this session.
Both hooks are POSIX sh. On Windows, Claude Code runs them in Git Bash, which
comes with Git for Windows.

## Other MCP clients

Server `https://lyngo.app/mcp`, headers `Authorization: Bearer <token>` and
`X-Lyngo-Remote: <the repository's git remote URL>`. Tools: `status`, `lookup`,
`check`.
