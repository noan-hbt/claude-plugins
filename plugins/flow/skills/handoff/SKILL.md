---
name: handoff
description: Save the current task's state to a handoff file so a fresh session can pick it up after /clear. Use for /handoff, "mets à jour le doc, je reprends en session fraîche", "on s'arrête là", "sauvegarde l'avancement", or before a /clear mid-task.
argument-hint: "[file path]"
---

# Handoff

Write what the next session needs to continue without re-deriving anything, then tell the user they can `/clear`.

## Where

- The argument path if given; else an existing progress file the task already uses (e.g. `phase2-progress.md`); else `.claude/handoff.md` at the repo root (or the cwd outside a repo).
- If `.claude/handoff.md` is new in a git repo, make sure `.claude/handoff.md` is git-ignored (add it to `.git/info/exclude`, not to `.gitignore`).

## Content (overwrite, keep it under ~60 lines)

```markdown
# Handoff — <task> — <YYYY-MM-DD HH:MM>
Repo: <path> · branch <branch> · worktree: yes/no · last commit <sha subject>

## Goal
<one or two lines: the outcome the user wants>

## Done
- <facts, with file paths>

## Next
1. <the very next concrete action>
2. ...

## Decisions & constraints
- <choices made and why; things the user rejected>

## Open questions / blockers
- <or "none">

## Verify
<command(s) that prove the current state, e.g. pytest path::test>
```

## Rules

- Facts only, verified from the code and git, not from memory of the chat.
- Uncommitted work: list the files and say whether it is safe to commit.
- Reply with the file path and one line: "prêt pour /clear, reprends avec /resume".
