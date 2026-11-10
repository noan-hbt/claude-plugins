---
name: ship
description: Commit, push, open a PR and optionally merge the current work in one pass. Use for /ship, "commite", "commite et push", "push", "fais la PR", "merge", "ship it". Pass "merge" to also merge the PR once checks pass.
argument-hint: "[merge] [message hint]"
---

# Ship

Take the working tree to a pushed branch with a PR, and merge it when asked. Do it in as few tool calls as possible and report one line per step.

## Steps

1. **State** — one call: `git status --short`, `git branch --show-current`, `git rev-parse --git-dir --git-common-dir` (worktree if they differ), `git log -5 --format=%s`, default branch via `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
   - Nothing to commit and nothing ahead of the remote: say so and stop.
2. **Branch** — on the default branch, create `git switch -c <short-kebab-topic>` first. Never commit straight to the default branch.
3. **Check** — run the project's fast check when one is obvious (`pytest -q -x` on touched tests, `npm test --silent`, `cargo check`…). On failure: stop, show the failure, don't commit. No obvious check: skip and say so.
4. **Commit** — stage only files that belong to this change (never `.env`, secrets, build output, stray scratch files; ask if unsure). Follow the repo's message convention from step 1 (language, prefix style). Subject ≤ 72 chars, body = the why. End with the attribution lines the session requires.
5. **Push** — `git push -u origin HEAD`.
6. **PR** — reuse the open PR for this branch if there is one (`gh pr view --json url`), otherwise `gh pr create` with a short title and a body: what, why, how it was tested.
7. **Merge** (only if the argument contains `merge`, or the user said merge) — `gh pr checks --watch` when CI exists, then `gh pr merge --squash --delete-branch`. Then `git switch <default> && git pull --ff-only`. In a worktree, don't switch: just report that the worktree can be removed.

## Rules

- Never force-push, never `--no-verify`, never amend a pushed commit.
- Hook or check failure: fix the cause, then make a new commit.
- Report at the end: branch, commit subject, PR URL, merged or not. Nothing else.
