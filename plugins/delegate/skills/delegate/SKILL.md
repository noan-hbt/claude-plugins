---
name: delegate
description: Delegate an isolated coding task to an external CLI (codex exec, then opencode run) to save Claude quota, then verify the diff. Use for /delegate, "délègue à codex", "fais-le faire par codex/opencode", or when the user's instructions say to delegate serious code work. Not for exploration or one-line edits.
argument-hint: "[codex|opencode] <task>"
---

# Delegate

## When it pays off

Isolable work with a clear done-criterion: implement a function or module, write tests, a mechanical refactor, a migration across files. Skip it for a one-line fix, work that needs this conversation's context, or anything needing secrets or network side effects — doing it yourself is cheaper there.

## 1. Write a self-contained prompt

The CLI sees none of this conversation. The prompt must state:

- **Goal** — the outcome, in one or two sentences.
- **Files** — exact paths to read and to change; files it must not touch.
- **Constraints** — conventions to follow (point to an example file), no new dependencies unless named, keep the public API.
- **Done when** — the command that must pass (e.g. `pytest tests/test_x.py -q`).
- **Report** — "End with a list of the files changed and the check output."

Write it to `<scratchpad>/delegate-prompt.md` when it is long; pass it with `"$(cat file)"`.

## 2. Run

```bash
codex exec -s workspace-write -o "<scratchpad>/codex-out.md" "<prompt>"
```

- Run with `run_in_background` when it may take over ~2 minutes; you are notified on exit.
- Read **only** the `-o` file, never the full stream.
- Fallback when codex fails, is out of quota, or is not installed: `opencode run "<prompt>"` (capture its last lines only).
- Both fail: use a Claude subagent (`model: "sonnet"` for code, `"haiku"` for mechanical edits) with the same prompt.
- In a git worktree, run from the worktree root so the CLI writes there.

## 3. Verify (always)

1. `git diff --stat` — changes stay within the declared files. Revert stray edits.
2. Read the diff of the changed files, not whole files.
3. Run the "Done when" command yourself; don't trust the CLI's claim.
4. Fix small gaps directly. A wrong approach: re-delegate once with a sharper prompt citing the failure, else do it yourself.

Report in one or two lines: which CLI did it, check result, anything you fixed.
