# Guard

PreToolUse safety and speed layer for Claude Code auto mode, including Windows and git worktrees. Prevents protected-branch force pushes, skipped verification, secret staging/content, dangerous deletions, and edits outside the active worktree. Requests confirmation for destructive commands. Allows recognized safe command chains without prompting; unknown commands receive no decision.

Requires Node.js 18+. Git metadata lookups use a per-directory temporary cache for 60 seconds. No npm dependencies.

## Configuration

Run `/guard` to show active rules, effective configuration, and the last 20 denied or confirmation-required actions.

Loads `<CLAUDE_CONFIG_DIR or ~/.claude>/guard.json`, then `<git root or cwd>/.claude/guard.json`. Project keys replace user keys, including arrays. Invalid configuration values and regular expressions are ignored.

```json
{
  "disable": [],
  "extraSafe": ["^make test$"],
  "protectedBranches": ["main", "master", "develop"]
}
```

Rule IDs: `worktree-fence`, `force-push`, `no-verify`, `destructive`, `secrets-staging`, `secrets-content`, `safe-allow`. Add an ID to `disable` to disable that rule. `extraSafe` extends safe command matching; destructive and denied rules retain precedence. Keep expressions narrow and anchored.

Denied and confirmation-required actions are logged to `<config dir>/guard/log.jsonl`. Logs stay under 1 MiB by dropping the oldest half when the limit is exceeded. Worktree edits may always target the config directories, system temporary directory, or a path containing `scratchpad`.

## Hooks and tests

- `PreToolUse`: `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit`, via `hooks/guard.js`.
- Decision precedence: deny, then ask, then allow. Hook failures print nothing and exit successfully.
- Run tests: `node --test plugins/guard/tests`.
