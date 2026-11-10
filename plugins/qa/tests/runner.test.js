'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { run, quote } = require('../hooks/lib');

function worker(t, source) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-qa-runner-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const filename = path.join(cwd, "worker's $cash file.js");
  fs.writeFileSync(filename, source);
  return { cwd, command: `node ${quote(filename)}` };
}

test('shell runner captures stdout and stderr in the requested cwd with literal quoted paths', async (t) => {
  const fixture = worker(t, 'console.log("stdout:" + process.cwd()); console.error("stderr:hello");');
  const result = await run(fixture.command, { cwd: fixture.cwd, timeoutMs: 10000 });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.timedOut, false);
  assert.ok(result.output.includes(`stdout:${fixture.cwd}`), result.output);
  assert.ok(result.output.includes('stderr:hello'), result.output);
});

test('shell runner preserves nonzero exit status and failure output', async (t) => {
  const fixture = worker(t, 'console.error("fixture failure"); process.exit(7);');
  const result = await run(fixture.command, { cwd: fixture.cwd, timeoutMs: 10000 });
  assert.notEqual(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /fixture failure/);
});

test('shell runner terminates commands exceeding their timeout', { timeout: 15000 }, async (t) => {
  const fixture = worker(t, 'console.log("started"); setInterval(() => {}, 1000);');
  const started = Date.now();
  const result = await run(fixture.command, { cwd: fixture.cwd, timeoutMs: 2000 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /started/);
  assert.ok(Date.now() - started < 12000, 'timed-out command must stop promptly');
});
