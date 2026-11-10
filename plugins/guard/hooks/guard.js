'use strict';

try {
  const fs = require('node:fs');
  const { decide } = require('./lib');
  const { createDeps, loadConfig, logDecision } = require('./runtime');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const deps = createDeps();
  const result = decide(input, loadConfig(input.cwd, deps), deps);
  if (result) {
    logDecision(input, result, deps);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: result.decision,
      permissionDecisionReason: result.reason,
    } }));
  }
} catch { /* Hook failures have no opinion and must not interrupt Claude. */ }
