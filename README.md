# claude-plugins

My settings and extensions for Claude Code. The repo is also a plugin marketplace:

```
claude plugin marketplace add noan-hbt/claude-plugins
claude plugin install token-usage@noan-hbt
```

## Plugins

| Plugin | Role | Source |
|---|---|---|
| `token-usage` | token profiler per command, skill and subagent; keeps the ledger read by the status line | [Wicked-Sick-Ltd/token-usage](https://github.com/Wicked-Sick-Ltd/token-usage), pinned to `v0.9.0` |

The plugin is referenced, not copied: to upgrade, change `ref` and `sha` in
`.claude-plugin/marketplace.json` after reviewing the upstream diff. It runs `python3`
(`Stop`/`SubagentStop` hooks and a local MCP server), with no network access.

## Usage status line

Shows your usage at all times, without typing `/usage`:

```
[CAVEMAN] Opus 5.5 · ctx 62% · 5h 12% · 7d 85% · 5k out · ~$0.46 · top: /code-review
```

| Part | Meaning | Source |
|---|---|---|
| `[CAVEMAN]` | caveman mode is on | `caveman` plugin |
| `ctx` | context used | Claude Code |
| `5h` / `7d` | plan limits (green, yellow from 50 %, red from 80 %) | Claude Code |
| `5k out` | session output tokens | `token-usage` plugin |
| `~$0.46` | estimated API cost, not a subscription bill | `token-usage` plugin |
| `top:` | most expensive command | `token-usage` plugin |

A part with no data is hidden, so both plugins are optional. The `token-usage` data refreshes at
the end of each turn or subagent.

### Install (Windows PowerShell 5.1)

Copy the script:

```powershell
Copy-Item statusline\statusline.ps1 "$HOME\.claude\statusline.ps1"
```

Then in `~/.claude/settings.json`, replacing `<user>`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<user>\\.claude\\statusline.ps1\""
  }
}
```
