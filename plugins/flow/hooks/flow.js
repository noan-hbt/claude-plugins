#!/usr/bin/env node
// Single entry for all flow hooks. Never fails the session: errors exit 0 silently.
const fs = require("fs");
const lib = require("./lib");

function emit(event, context) {
  if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
}

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const event = input.hook_event_name || process.argv[2];
  if (event === "SessionStart") emit(event, lib.sessionContext(input));
  else if (event === "UserPromptSubmit") emit(event, lib.promptContext(input));
  else if (event === "PreCompact" || event === "SessionEnd") {
    // SessionEnd: only snapshot on /clear (other ends are real exits; resume has the transcript).
    if (event === "PreCompact" || input.reason === "clear") lib.writeAutoHandoff(input);
  }
} catch {}
process.exit(0);
