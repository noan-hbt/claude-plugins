# claude-plugins

My Claude Code setup: a plugin marketplace plus **megaclaude**, one command that installs and syncs everything.

## Quick start

Fresh Windows machine:

```powershell
irm https://raw.githubusercontent.com/noan-hbt/claude-plugins/main/megaclaude/bootstrap.ps1 | iex
```

Existing clone, after pulling changes (re-running = sync, idempotent):

```powershell
megaclaude\install.ps1            # add --dry-run to preview, --install-tools to winget/npm missing tools
```

It checks tools (git, gh, node, python, uv, codex, opencode, rtk, cargo), merges `megaclaude/profile.json` into
`settings.json` of every config dir (`~/.claude`, `~/.claude-2`, `CLAUDE_CONFIG_DIR`) with backups, syncs home files
(status line, caveman hook, CLAUDE.md managed block), installs the plugins below, and runs a doctor that reports
drift between config dirs, double hooks and stale backups. Details: [megaclaude/README.md](megaclaude/README.md).

Plugins only:

```
claude plugin marketplace add noan-hbt/claude-plugins
claude plugin install flow@noan-hbt   # and delegate, guard, qa, insights, token-usage
```

## Plugins

| Plugin | What it does |
|---|---|
| [`flow`](plugins/flow) | `/ship [merge]` commit → push → PR → merge. `/handoff` + `/resume`. Hooks: on `/clear` and before compaction it snapshots the session (prompts, task list, edited files, last message) and re-injects it into the next session; injects repo/branch/worktree at start; turns a bare "ok / vsy / go" into "carry the plan through, don't ask again". |
| [`delegate`](plugins/delegate) | `/delegate` hands an isolated task to `codex exec` (fallback `opencode run`, then a Claude subagent) through `scripts/run.js`, which returns only the engine report and `git diff --stat`. `delegate-runner` agent verifies the result off the main context. |
| [`guard`](plugins/guard) | PreToolUse layer. Auto-allows read-only commands (git status/log/diff, gh pr view, tests, ls/cat/rg…, compound commands only if every part is safe) to cut auto-mode prompts. Denies edits outside the current worktree, force-push to protected branches, `--no-verify`, staging `.env`/keys, writing secrets, `rm -rf` on home/root; asks on `reset --hard`, `clean -f`, `branch -D`. `/guard` shows rules and log; per-project `.claude/guard.json`. |
| [`qa`](plugins/qa) | Tracks files Claude edits; at Stop runs the related tests (pytest on matching test files, vitest/jest related, npm test, cargo check, go vet) and blocks with the failure until fixed (max 3 rounds). `/qa` shows/sets `.claude/qa.json`; `CLAUDE_QA=off` disables. |
| [`insights`](plugins/insights) | `/insights [days] [project]`: analyses your transcripts (prompts, tools, MCP, errors, permission denials, resets, hours, tokens) and ranks concrete fixes. `/adapt`: drafts a project CLAUDE.md, permissions and qa config from the stack and your history. |
| `token-usage` | Token profiler per command, skill and subagent; feeds the status line. External: [Wicked-Sick-Ltd/token-usage](https://github.com/Wicked-Sick-Ltd/token-usage) pinned to `v0.9.0` (update `ref`/`sha` after reviewing the upstream diff). |

## Layout

```
.claude-plugin/marketplace.json   marketplace index
plugins/<name>/                    .claude-plugin/plugin.json, skills/, agents/, hooks/, scripts/, tests/
megaclaude/                        installer: profile.json, install.js (+ .ps1/.sh entries), bootstrap.ps1, home/
```

Every hook is zero-dependency Node and exits 0 on any internal error, so a bug never blocks a session.

## Develop

```
node --test plugins/*/tests megaclaude/tests
claude plugin validate .            # and: claude plugin validate plugins/<name>
```

Then re-run `megaclaude\install.ps1` (or `claude plugin marketplace update noan-hbt`) to pick up changes.
