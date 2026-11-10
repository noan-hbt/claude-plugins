---
name: resume
description: Pick up work saved by /handoff or a progress file. Use for /resume, "reprends", "reprends le travail en attente", "reprends la phase N d'après <fichier>", "on continue".
argument-hint: "[file path]"
---

# Resume

1. **Find the file** — the argument; else `.claude/handoff.md` at the repo root; else the most recent `*progress*.md` / `HANDOFF*.md` in the repo. None found: say so in one line and ask what to resume.
2. **Check it against reality** — one call: `git branch --show-current`, `git status --short`, `git log -3 --oneline`. Flag any mismatch with the file (other branch, new commits, missing files) before acting.
3. **Run the Verify command** from the file if there is one and it is cheap.
4. **Continue with the first item of "Next"** without asking, unless an open question blocks it. Respect "Decisions & constraints" — don't reopen settled choices.
5. When a step from "Next" is done, tick it in the file so the next `/handoff` or `/resume` stays accurate.

Start the reply with one line: what you are resuming and the step you are on.
