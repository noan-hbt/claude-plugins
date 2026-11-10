'use strict';

const fs = require('node:fs');
const { statePath, readState, writeState, trackFile } = require('./lib');

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const file = statePath(input.session_id);
  const edited = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (file && edited) writeState(file, trackFile(readState(file), edited, input.cwd || process.cwd()));
} catch {
  // A hook failure must never interrupt Claude.
}
