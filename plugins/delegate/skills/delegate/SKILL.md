---
name: delegate
description: Delegate an isolated coding task to an external CLI (codex exec, fallback opencode run) to save Claude quota, then verify the diff. Use for /delegate, "délègue à codex", "fais-le faire par codex/opencode", or when the user's instructions say to delegate serious code work. Not for exploration or one-line edits.
argument-hint: "[codex|opencode] <task>"
---

# Delegate

## When it pays off

Isolable work with a clear done-criterion: implement a function or module, write tests, a mechanical refactor, a migration across files. Skip it for a one-line fix, work that needs this conversation's context, or anything needing secrets or network side effects.

Several independent tasks: delegate them in parallel, each in its own background run, as long as they touch disjoint files.

## 1. Write a self-contained prompt

The CLI sees none of this conversation. The prompt must state:

- **Goal** — the outcome, in one or two sentences.
- **Files** — exact paths to read and to change; files it must not touch.
- **Constraints** — conventions (point to an example file), no new dependencies unless named, keep the public API, no git commands.
- **Done when** — the command that must pass (e.g. `pytest tests/test_x.py -q`).
- **Report** — "End with the files changed and the check output."

Write it to a file in the scratchpad.

## 2. Run

Default — keep the main context clean: spawn the `delegate-runner` agent with the prompt; it runs the CLIs, verifies, and returns a short verdict.

Direct, when you want to watch it yourself:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.js" --cwd <repo root> --prompt-file <file> [--engine codex|opencode] [--timeout 1200]
```

It tries codex (`exec -s workspace-write`, prompt via stdin, final message via `-o`), falls back to opencode on failure, quota or missing binary, and prints only: engine, its final report, `git diff --stat`, new files. Exit 1 = both failed → use a Claude subagent (`model: "sonnet"`) with the same prompt. Use `run_in_background` for long tasks. In a worktree, pass the worktree root as `--cwd`.

## 3. Verify (always, unless delegate-runner did)

1. Changes stay within the declared files; revert stray edits.
2. Read the diff of the changed files, not whole files.
3. Run the "Done when" command yourself; don't trust the CLI's claim.
4. Fix small gaps directly; a wrong approach → re-delegate once with a sharper prompt citing the failure, else do it yourself.

Report in one or two lines: which engine did it, check result, anything you fixed.
