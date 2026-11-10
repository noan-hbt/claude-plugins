---
name: guard
description: Inspect Guard safety rules, effective project configuration, and recent blocked actions. Use for /guard, guard status, safety settings, disable a guard rule, allow a safe command, statut guard, règles de sécurité, désactiver une règle, or autoriser une commande.
argument-hint: "[status | rule ID | safe command]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.js"` from the current project directory.

Report active rules, effective configuration, user/project configuration paths, and the last 20 log lines. Explain relevant deny or ask decisions using the reported rule IDs.

To change this project's configuration:

1. Read the reported project `.claude/guard.json` if it exists. Preserve unrelated keys.
2. Show the exact proposed JSON change and explain its effect. Add rule IDs to `disable`, or add narrowly anchored regular expressions to `extraSafe`. Deny and ask rules retain precedence over `extraSafe`.
3. Obtain the user's confirmation before writing `.claude/guard.json`. Use the reported project path, including the current worktree root.
4. Run the status script again and report the effective configuration.

Supported rule IDs: `worktree-fence`, `force-push`, `no-verify`, `destructive`, `secrets-staging`, `secrets-content`, `safe-allow`.

Configuration loads user `guard.json` from `CLAUDE_CONFIG_DIR` or `~/.claude`, then project `.claude/guard.json`; project values replace user values for each key. Array values replace entire arrays. Protected branches default to `main`, `master`, and `develop` and can be overridden with `protectedBranches`.
