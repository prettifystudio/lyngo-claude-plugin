# lyngo

Localization like code, from your terminal. Your agent builds the product;
Lyngo keeps it localized.

When you or your agent add text a person reads, `lyngo localize` wraps it with
your project's i18n calls, reuses the keys you already have, and translates the
catalogs with your glossary, translation memory and plural rules, before you
commit. The files come back to your working tree as one patch. A model never
holds them.

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
   when you own the workspace. When GitHub is not connected yet, it prints the
   link to connect it and waits.
3. Detects the framework and the i18n library.
4. Sets the languages: `--languages fr,de`, or it asks.
5. Applies the i18n setup as a patch to your working tree. It edits
   `package.json` but never runs `npm install`; it prints the command.
6. When Claude Code is installed: registers the Lyngo MCP server for this
   repository in Claude Code's local scope (stored in your home folder, never in
   the repository), and adds one Stop hook to `.claude/settings.local.json` that
   runs `lyngo localize` when your agent finishes a task.

Run it again at any time: it prints the state and changes nothing that is
already set up.

## Daily use

- With an agent: build as usual. The hook runs `lyngo localize` at the end of
  every task.
- Without an agent: run `lyngo localize` before you commit.
- Anything pushed without it still gets a pull request from the Lyngo GitHub
  App.

## Commands

| Command | What it does |
|---|---|
| `lyngo login` | Signs in through the browser and saves the token (mode 600) |
| `lyngo logout` | Revokes the token and deletes it from this machine |
| `lyngo whoami` | The account, the token prefix and your workspaces |
| `lyngo init` | Connects the repository (see above). Flags: `--languages`, `--workspace`, `--yes`, `--github` |
| `lyngo localize` | Localizes and translates what changed in the working tree. Flags: `--languages`, `--dry` |
| `lyngo check <file>` | The user-facing strings of one file |
| `lyngo status` | The project as Lyngo knows it |

Configuration: `LYNGO_HOST` (default `https://lyngo.app`), `LYNGO_TOKEN`
(otherwise `~/.config/lyngo/token`). Revoke tokens in Lyngo under Settings, CLI.

## The Claude Code plugin (optional)

This repository is also a Claude Code plugin. It adds the `/lyngo:localize`
command and the `lyngo-i18n` skill, which makes the agent check existing keys
before it writes new text. It needs the `lyngo` command from npm.

```bash
claude plugin marketplace add <owner>/lyngo-claude-plugin
claude plugin install lyngo@lyngo
```

## Other MCP clients

Server `https://lyngo.app/mcp`, headers `Authorization: Bearer <token>` and
`X-Lyngo-Remote: <the repository's git remote URL>`. Tools: `status`, `lookup`,
`check`.
