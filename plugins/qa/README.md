# qa

Automatically check edited code before Claude finishes. Failed checks block completion with the last 80 output lines and instructions to fix the cause. After three blocked attempts, the next Stop reports the failure and resets the counter.

Run `/qa` to inspect detected stacks and configure checks. `/qa off` writes `enabled:false` to the project's `.claude/qa.json`. `CLAUDE_QA=off` disables the gate through the environment.

```json
{"enabled":true,"mode":"related","timeoutSec":180,"ignore":["generated/"],"command":"python -m pytest -q {files}"}
```

All fields are optional. Defaults: enabled, related mode, 180 seconds per command. `command` overrides detection; `{files}` expands to quoted related Python tests when found, otherwise quoted touched files. Commands run sequentially from the Git root, falling back to the working directory. Windows commands use PowerShell; POSIX commands use the default shell.

Detection uses touched extensions and root markers:

- Python: related `test_*.py` / `*_test.py` files, searched through six directory levels; full pytest when no related tests exist and mode is `full`.
- JavaScript/TypeScript: Vitest related tests, Jest related tests, or `npm test --silent`; full mode uses the npm test script. Also runs a configured typecheck script.
- Rust: `cargo check -q`. Go: `go build ./...`, then `go vet ./...`.
- Other files: no automatic checks. A custom command can cover any stack.

Hooks: `PostToolUse` tracks Edit, Write, MultiEdit, and NotebookEdit paths; `Stop` runs checks with a 300-second hook timeout. State lives in `<os.tmpdir()>/claude-qa/<session_id>.json`. Ignored and out-of-project paths are dropped; successful checks clear tracked files. Hook errors fail open.

Inspect detection directly: `node "${CLAUDE_PLUGIN_ROOT}/scripts/detect.js" [files...]`.

Test: `node --test plugins/qa/tests`.
