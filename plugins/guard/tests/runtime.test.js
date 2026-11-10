'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createDeps, loadConfig, logDecision, configDir } = require('../hooks/runtime');
const { DEFAULT_CONFIG } = require('../hooks/lib');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-runtime-test-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('guard-runtime-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const global = path.join(root, 'config');
  const project = path.join(root, 'project');
  fs.mkdirSync(global);
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  return {
    root, global, project,
    deps: { configDir: global, gitInfo: () => ({ root: project }) },
    writeGlobal: value => fs.writeFileSync(path.join(global, 'guard.json'), JSON.stringify(value)),
    writeProject: value => fs.writeFileSync(path.join(project, '.claude', 'guard.json'), JSON.stringify(value)),
  };
}

test('config merges defaults, user config, then git-root project config', t => {
  const f = fixture(t);
  f.writeGlobal({ disable: ['destructive'], protectedBranches: ['release'], extraSafe: ['^make test$'] });
  f.writeProject({ disable: ['no-verify'], extraSafe: ['^make lint$'] });
  assert.deepEqual(loadConfig(path.join(f.project, 'src'), f.deps), {
    ...DEFAULT_CONFIG,
    disable: ['no-verify'], protectedBranches: ['release'], extraSafe: ['^make lint$'],
  });
});

test('without git, project config is read relative to cwd', t => {
  const f = fixture(t);
  f.writeProject({ protectedBranches: ['production'] });
  assert.deepEqual(loadConfig(f.project, { ...f.deps, gitInfo: () => null }).protectedBranches, ['production']);
});

test('empty project arrays replace global arrays', t => {
  const f = fixture(t);
  f.writeGlobal({ disable: ['destructive'], extraSafe: ['^make test$'], protectedBranches: ['release'] });
  f.writeProject({ disable: [], extraSafe: [], protectedBranches: [] });
  const config = loadConfig(f.project, f.deps);
  assert.deepEqual(config.disable, []);
  assert.deepEqual(config.extraSafe, []);
  assert.deepEqual(config.protectedBranches, []);
});

test('missing, malformed, and invalid config cannot break hook decisions', t => {
  const f = fixture(t);
  assert.deepEqual(loadConfig(f.project, f.deps), DEFAULT_CONFIG);
  fs.writeFileSync(path.join(f.global, 'guard.json'), '{');
  f.writeProject({ disable: 'destructive', extraSafe: 7, protectedBranches: null });
  assert.deepEqual(loadConfig(f.project, f.deps), DEFAULT_CONFIG);
  f.writeGlobal({ disable: ['destructive', 'unknown', 7], extraSafe: ['[', '^make test$', 8], protectedBranches: ['release', 5, ''] });
  assert.deepEqual(loadConfig(f.project, f.deps), {
    ...DEFAULT_CONFIG, disable: ['destructive'], extraSafe: ['^make test$'], protectedBranches: ['release'],
  });
});

test('configDir and dependencies respect CLAUDE_CONFIG_DIR', t => {
  const f = fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  process.env.CLAUDE_CONFIG_DIR = f.global;
  assert.equal(configDir(), f.global);
  assert.equal(createDeps().configDir, f.global);
});

test('log records deny and ask with bounded summaries, without logging allows', t => {
  const f = fixture(t);
  const input = { tool_name: 'Bash', tool_input: { command: `rm -rf ${'x'.repeat(200)}` }, cwd: f.project };
  logDecision(input, { decision: 'deny', rule: 'destructive', reason: 'test' }, f.deps);
  logDecision({ ...input, tool_name: 'Write', tool_input: { file_path: '/outside/file.js' } }, { decision: 'ask', rule: 'worktree-fence', reason: 'test' }, f.deps);
  logDecision(input, { decision: 'allow', rule: 'safe-allow', reason: 'test' }, f.deps);
  logDecision(input, null, f.deps);
  const rows = fs.readFileSync(path.join(f.global, 'guard', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['cwd', 'decision', 'rule', 'summary', 'tool', 'ts']);
  assert.equal(rows[0].decision, 'deny');
  assert.equal(rows[0].summary.length, 120);
  assert.equal(rows[0].tool, 'Bash');
  assert.equal(rows[0].cwd, f.project);
  assert.ok(Number.isFinite(Date.parse(rows[0].ts)));
  assert.equal(rows[1].summary, '/outside/file.js');
  assert.equal(rows[1].decision, 'ask');
});

test('log rotation drops oldest half and retains valid recent JSON lines below 1 MB', t => {
  const f = fixture(t);
  const directory = path.join(f.global, 'guard');
  const file = path.join(directory, 'log.jsonl');
  fs.mkdirSync(directory);
  const lines = Array.from({ length: 4500 }, (_, index) => JSON.stringify({ index, summary: 'x'.repeat(240) }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  logDecision({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: f.project }, { decision: 'ask', rule: 'destructive' }, f.deps);
  assert.ok(fs.statSync(file).size < 1024 * 1024);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows[0].index > 0);
  assert.equal(rows.at(-2).index, 4499);
  assert.equal(rows.at(-1).rule, 'destructive');
});

test('log filesystem errors are nonfatal', t => {
  const f = fixture(t);
  const blocked = path.join(f.root, 'file-not-directory');
  fs.writeFileSync(blocked, 'x');
  assert.doesNotThrow(() => logDecision({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: f.project }, { decision: 'ask', rule: 'destructive' }, { configDir: blocked }));
});
