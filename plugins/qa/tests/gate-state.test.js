'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gate, trackFile, statePath, readState, writeState, filterFiles } = require('../hooks/lib');

const root = path.resolve(os.tmpdir(), 'qa-gate-project');
const filename = path.join(root, 'src/foo.py');
const lastRun = '2026-11-10T09:00:00.000Z';
const now = '2026-11-10T10:00:00.000Z';

function state(extra = {}) {
  return { files: [filename], blocks: 0, lastRun, ...extra };
}

async function exercise(input = {}, overrides = {}) {
  const calls = [];
  const dependencies = {
    getRoot: () => root,
    readConfig: () => ({}),
    detect: (_root, files) => ({ root: _root, files, stacks: ['python'], commands: ['test command'] }),
    run: async (command, options) => { calls.push({ command, ...options }); return { code: 0, output: 'passed' }; },
    now: () => now,
    ...overrides,
  };
  const result = await gate({ cwd: root, state: state(), env: {}, ...input }, dependencies);
  return { ...result, calls };
}

test('successful gate runs commands in order and clears retry state', async () => {
  const result = await exercise({ state: state({ blocks: 2 }) }, {
    detect: () => ({ commands: ['first command', 'second command'] }),
  });
  assert.deepEqual(result.calls.map(({ command }) => command), ['first command', 'second command']);
  assert.deepEqual(result.calls.map(({ cwd }) => cwd), [root, root]);
  assert.ok(result.calls.every(({ timeoutMs }) => timeoutMs === 180000));
  assert.deepEqual(result.state, { files: [], blocks: 0, lastRun: now });
  assert.match(result.output.systemMessage, /^qa: ok - /);
  assert.ok(result.output.systemMessage.includes('second command'));
});

test('failure blocks completion, keeps files, and limits output to final 80 lines', async () => {
  const result = await exercise({ state: state({ blocks: 1 }) }, {
    run: async () => ({ code: 1, output: Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}`).join('\n') }),
  });
  assert.deepEqual(result.state, { files: [filename], blocks: 2, lastRun: now });
  assert.equal(result.output.decision, 'block');
  assert.match(result.output.reason, /`test command` failed after your edits \(attempt 2\/3\)/);
  assert.match(result.output.reason, /Fix the cause \(not the test, unless the test is wrong\), then finish\./);
  const tail = result.output.reason.split('\n\n').at(-1).split('\n');
  assert.equal(tail.length, 80);
  assert.equal(tail[0], 'line-020');
  assert.equal(tail.at(-1), 'line-099');
});

test('first failure stops the command sequence', async () => {
  const calls = [];
  const result = await exercise({}, {
    detect: () => ({ commands: ['first', 'second'] }),
    run: async (command) => { calls.push(command); return { code: 1, output: 'failed' }; },
  });
  assert.deepEqual(calls, ['first']);
  assert.equal(result.output.decision, 'block');
});

test('timeout counts as failure and points to timeoutSec configuration', async () => {
  const result = await exercise({}, {
    readConfig: () => ({ timeoutSec: 12 }),
    run: async (_command, options) => {
      assert.equal(options.timeoutMs, 12000);
      return { code: null, timedOut: true, output: 'slow test' };
    },
  });
  assert.equal(result.state.blocks, 1);
  assert.equal(result.output.decision, 'block');
  assert.match(result.output.reason, /timeoutSec/);
  assert.match(result.output.reason, /\.claude[\\/]qa\.json/);
});

test('three-block cap resets attempts and allows stopping without another run', async () => {
  const initial = state({ blocks: 3 });
  const result = await exercise({ state: initial });
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.state, { ...initial, blocks: 0 });
  assert.deepEqual(result.output, { systemMessage: 'qa: tests still failing after 3 attempts, stopping' });
});

test('CLAUDE_QA=off bypasses work and preserves state', async () => {
  const initial = state({ blocks: 3 });
  const result = await exercise({ state: initial, env: { CLAUDE_QA: 'off' } }, {
    getRoot: () => { throw new Error('disabled gate should not resolve a project'); },
  });
  assert.deepEqual(result.state, initial);
  assert.equal(result.output, undefined);
  assert.equal(result.calls.length, 0);
});

test('no tracked files skips detection and execution', async () => {
  const result = await exercise({ state: state({ files: [] }) }, {
    detect: () => { throw new Error('no files should not require detection'); },
  });
  assert.equal(result.output, undefined);
  assert.equal(result.calls.length, 0);
});

test('enabled:false bypasses detection and execution', async () => {
  const result = await exercise({}, {
    readConfig: () => ({ enabled: false }),
    detect: () => { throw new Error('disabled project should not detect commands'); },
  });
  assert.equal(result.output, undefined);
  assert.equal(result.calls.length, 0);
});

test('gate filters ignored and outside-root files before detection', async () => {
  const ignored = path.join(root, 'generated/foo.py');
  const outside = path.join(`${root}-other`, 'foo.py');
  const config = { ignore: ['generated'], command: 'custom check' };
  const result = await exercise({ state: state({ files: [filename, ignored, outside] }) }, {
    readConfig: () => config,
    detect: (actualRoot, files, actualConfig) => {
      assert.equal(actualRoot, root);
      assert.deepEqual(files, [filename]);
      assert.deepEqual(actualConfig, config);
      return { commands: ['custom check'] };
    },
    run: async () => ({ code: 1, output: 'failed' }),
  });
  assert.deepEqual(result.state.files, [filename]);
  assert.match(result.output.reason, /`custom check` failed/);
});

test('empty command plans allow completion without changing lastRun', async () => {
  const result = await exercise({}, { detect: () => ({ commands: [] }) });
  assert.equal(result.calls.length, 0);
  assert.equal(result.output, undefined);
  assert.equal(result.state.lastRun, lastRun);
});

test('trackFile resolves paths, appends once, and preserves gate fields', () => {
  const initial = { files: [], blocks: 2, lastRun };
  const once = trackFile(initial, 'src/foo.py', root);
  const twice = trackFile(once, filename, root);
  assert.deepEqual(twice, { files: [filename], blocks: 2, lastRun });
  assert.deepEqual(initial, { files: [], blocks: 2, lastRun });
  assert.deepEqual(trackFile(twice, 'src/bar.py', root).files, [filename, path.join(root, 'src/bar.py')]);
});

test('trackFile deduplicates normalized paths', () => {
  const result = trackFile(state(), path.join(root, 'src/../src/foo.py'), root);
  assert.deepEqual(result.files, [filename]);
});

test('Windows paths deduplicate regardless of case or separator', () => {
  const initial = { files: ['C:\\Repo\\src\\foo.py'], blocks: 0, lastRun: null };
  const result = trackFile(initial, 'c:/repo/SRC/FOO.py', 'C:\\Repo');
  assert.deepEqual(result.files, initial.files);
});

test('Windows root filtering rejects sibling prefixes and other drives', () => {
  const files = ['c:\\repo\\src\\foo.py', 'C:/REPO/src/FOO.py', 'C:\\repo-other\\foo.py',
    'D:\\repo\\foo.py', 'C:\\repo\\GENERATED\\foo.py', 'C:\\repo\\..\\outside.py'];
  assert.deepEqual(filterFiles('C:\\Repo', files, ['generated']), ['c:\\repo\\src\\foo.py']);
});

test('invalid tracked paths cannot reach a shell command', () => {
  for (const invalid of ['', null, undefined, 3, 'foo\nbar.py', 'foo\rbar.py', 'foo\0bar.py']) {
    assert.deepEqual(trackFile(state(), invalid, root), state());
  }
});

test('state files round-trip with session isolation and reject traversal', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-qa-state-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const target = statePath('session-123', tmpDir);
  assert.equal(target, path.join(tmpDir, 'claude-qa', 'session-123.json'));
  writeState(target, state());
  assert.deepEqual(readState(target), state());
  assert.deepEqual(readState(statePath('session-456', tmpDir)).files, []);
  for (const unsafe of ['../escape', '..\\escape', '/absolute', 'C:\\absolute']) {
    assert.equal(statePath(unsafe, tmpDir), null, unsafe);
  }
});
