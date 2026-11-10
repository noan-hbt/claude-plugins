# megaclaude

Sync a fresh or existing machine with the tuned Claude Code setup: tool checks, six plugins, settings, status line, Caveman session hook, and managed instructions. Requires Node.js 18+ and Claude Code for plugin installation. No npm dependencies. This directory is an installer, not a Claude Code plugin.

Windows bootstrap (PowerShell 5.1+):

```powershell
irm https://raw.githubusercontent.com/noan-hbt/claude-plugins/main/megaclaude/bootstrap.ps1 | iex
```

Bootstrap installs missing Git through winget, clones or fast-forward pulls into `$HOME\dev\claude-plugins`, then runs the installer. Existing checkouts must have a clean path to a fast-forward update; a failed pull stops installation.

From an existing checkout:

```powershell
.\megaclaude\install.ps1 --install-tools
```

```sh
sh megaclaude/install.sh --dry-run
```

```sh
node megaclaude/install.js --config-dir /path/to/.claude --skip-tools --skip-plugins
```

Entry scripts offer Node.js installation when missing; PowerShell uses winget, POSIX uses Homebrew or apt. With `--dry-run`, they print the prerequisite command without installing. Tool installation through the main CLI uses winget on Windows or npm for npm tools; unsupported installers are reported as commands to run manually. Optional RTK and Cargo are checked but never installed automatically. If Claude Code is missing, plugin commands are printed for later execution.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report planned changes and commands; write nothing. |
| `--config-dir <dir>` | Target a config directory. Repeat for multiple targets. |
| `--skip-tools` | Skip tool checks and installations. |
| `--install-tools` | Install missing non-optional tools. Without it, print install commands. |
| `--skip-plugins` | Skip marketplace and plugin commands. |

Default targets: `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`; also `~/.claude-2` when it exists. Explicit `--config-dir` flags replace these defaults. Arguments pass through entry scripts unchanged.

Edit `profile.json` to change marketplaces, plugins, tools, settings, local settings, or home-file strategies. `{{CONFIG_DIR}}` expands to each target path with forward slashes. The profile forces `statusLine`, `model`, and `modelSettings`; existing user scalar values win elsewhere. Objects merge without deleting user keys. Permission lists use an ordered union. Hook groups retain existing entries and add profile groups only when their commands are absent from that event; Windows comparisons ignore path slash style and case. A hook group's `requires` tool must be present, and this metadata is stripped before writing settings.

Home-file strategies:

- `copy`: sync `statusline.js` and `caveman-on.js`, backing up changed target files.
- `managed-block`: insert or replace `CLAUDE.md` content between `<!-- megaclaude:begin -->` and `<!-- megaclaude:end -->`; preserve surrounding instructions.
- `copy-if-absent`: create `RTK.md` only when missing.

Re-run to sync profile changes. Modified existing files receive timestamped `.bak-YYYYMMDD-HHmmss` backups before writing. An unchanged run makes no file changes or new backups. Plugin steps add or update the marketplace and ensure each configured plugin is installed in each target.

Doctor runs after synchronization and reports duplicate Caveman activation, settings differences between targets, backups older than 30 days, enabled plugins missing from installed plugins, and hook commands referring to missing files. Reports never delete files or disable settings.

Run tests from repository root:

```sh
node --test megaclaude/tests
```
