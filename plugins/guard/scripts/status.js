'use strict';

try {
  const fs = require('node:fs');
  const path = require('node:path');
  const { RULES } = require('../hooks/lib');
  const { createDeps, loadConfig } = require('../hooks/runtime');
  const deps = createDeps();
  const cwd = process.cwd();
  const config = loadConfig(cwd, deps);
  const info = deps.gitInfo(cwd);
  const logPath = path.join(deps.configDir, 'guard', 'log.jsonl');
  let recent = [];
  try {
    recent = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-20);
  } catch { /* No log yet. */ }
  console.log(JSON.stringify({
    cwd,
    activeRules: RULES.filter(rule => !config.disable.includes(rule)),
    config,
    configFiles: {
      user: path.join(deps.configDir, 'guard.json'),
      project: path.join(info && info.root || cwd, '.claude', 'guard.json'),
    },
    logPath,
    last20LogLines: recent,
  }, null, 2));
} catch (error) {
  console.error(`Guard status unavailable: ${error.message}`);
  process.exitCode = 1;
}
