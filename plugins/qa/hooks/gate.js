'use strict';

const fs = require('node:fs');
const { statePath, readState, writeState, gate } = require('./lib');

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const file = statePath(input.session_id);
    if (!file) return;
    const result = await gate({ cwd: input.cwd || process.cwd(), state: readState(file), env: process.env });
    writeState(file, result.state);
    if (result.output) console.log(JSON.stringify(result.output));
  } catch {
    // A hook failure must never interrupt Claude.
  }
}

main();
