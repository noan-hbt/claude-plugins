---
name: qa
description: Configure automatic checks before Claude finishes. Use for /qa, /qa off, "run tests automatically", "configure QA", "lance les tests automatiquement", or "désactive les tests automatiques".
argument-hint: "[off | files...]"
---

# QA

1. For `/qa off`, write `{"enabled":false}` to the project's `.claude/qa.json`. Preserve other existing settings. Report that automatic checks are disabled.
2. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/detect.js" [files...]` from the project directory. Pass file arguments individually, quoted; omit arguments when none were supplied.
3. Show detected stacks, commands, mode, timeout, and config path. With no files, detection uses representative extensions: Python related mode may need actual touched files to find related tests.
4. Offer to create or adjust `.claude/qa.json`: enable/disable, custom `command`, `mode` (`related` or `full`), `timeoutSec`, or `ignore` substrings. Apply settings already requested; otherwise ask which change the user wants. Preserve unrelated settings.

Defaults: enabled, related mode, 180 seconds per command. No matching checks means no blocking. Failures block completion for at most three attempts; the next Stop resets the counter and lets Claude finish with a warning. Fix the cause before finishing; change tests only when tests are wrong.

Custom `command` replaces autodetection. `{files}` expands to quoted related Python tests when found, otherwise quoted touched files. `CLAUDE_QA=off` disables checks for the environment.

Example `.claude/qa.json`:

```json
{"enabled":true,"mode":"related","timeoutSec":180,"ignore":["generated/"]}
```
