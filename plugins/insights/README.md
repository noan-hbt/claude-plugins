# insights

Turn Claude Code session transcripts into a usage report, then turn recurring friction into selected configuration changes.

- `/insights [days] [project]`: five observations, recurring friction, ranked changes with exact files and snippets. Default: 30 days; project matches a substring.
- `/adapt`: inspect the current repository and its history, then draft project instructions, scoped command permissions, and optional qa configuration. Show the diff and apply on confirmation, preserving existing content.
- `usage-analyst`: Haiku agent for large reports; keeps transcript analysis out of the main context.

Run the analyzer directly with Node.js 18 or later; no dependencies:

```sh
node plugins/insights/scripts/analyze.js
node plugins/insights/scripts/analyze.js --days 14 --project my-app
node plugins/insights/scripts/analyze.js --days 30 --json
node plugins/insights/scripts/analyze.js --config-dir /path/to/.claude --config-dir /path/to/.claude-2
```

JSON output contains `{ "stats": ..., "suggestions": ... }`. Markdown includes project dates and tokens, prompts, tools, command heads, errors, permission denials, resets, activity hours, and evidence-backed suggestions. Main sessions and subagent transcript files are counted separately. French share is a common-word heuristic; timestamps use local hours. Token figures come from recorded assistant usage; the report does not estimate costs.

Without `--config-dir`, read `CLAUDE_CONFIG_DIR` or `~/.claude`, plus `~/.claude-2` when present. Explicit `--config-dir` options replace those defaults. Resolve transcript real paths to avoid duplicate counts from symlinked project folders. Read JSONL line by line and skip malformed records.

Analysis runs locally and does not modify transcripts or configuration. Reports include prompt and error excerpts: review them before sharing. Skills propose changes; selected settings edits receive a timestamped backup, and existing instructions/settings are appended or merged.

Hooks: none. No background collection or telemetry.

```sh
node --test plugins/insights/tests
claude plugin validate plugins/insights
```
