'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { detect } = require('../hooks/lib');

function fixture(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-qa-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(entries)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

function quoted(command, filename) {
  assert.ok(command.includes(`"${filename}"`) || command.includes(`'${filename}'`), command);
}

test('Python module detection finds either test naming convention', (t) => {
  const root = fixture(t, {
    'pyproject.toml': '',
    'src/foo.py': '',
    'tests/test_foo.py': '',
    'other/foo_test.py': '',
    '.venv/test_foo.py': '',
    'venv/test_foo.py': '',
    'node_modules/test_foo.py': '',
    '.git/test_foo.py': '',
    'dist/test_foo.py': '',
    'build/test_foo.py': '',
    'a/b/c/d/e/f/g/test_foo.py': '',
  });
  const plan = detect(root, [path.join(root, 'src/foo.py')]);
  assert.equal(plan.commands.length, 1);
  assert.match(plan.commands[0], /^python -m pytest -q -x --no-header -p no:cacheprovider /);
  assert.ok(plan.commands[0].includes(path.join(root, 'tests/test_foo.py')));
  assert.ok(plan.commands[0].includes(path.join(root, 'other/foo_test.py')));
  for (const excluded of ['.venv', 'venv', 'node_modules', '.git', 'dist', 'build', 'a/b/c/d/e/f/g']) {
    assert.ok(!plan.commands[0].includes(path.join(root, excluded)), excluded);
  }
});

test('touched Python tests are related tests and paths with spaces stay quoted', (t) => {
  const root = fixture(t, { 'pytest.ini': '', 'tests with spaces/test_foo.py': '' });
  const filename = path.join(root, 'tests with spaces/test_foo.py');
  const plan = detect(root, [filename]);
  assert.equal(plan.commands.length, 1);
  quoted(plan.commands[0], filename);
});

test('Python related mode skips modules without matching tests', (t) => {
  const root = fixture(t, { 'setup.cfg': '', 'foo.py': '' });
  assert.deepEqual(detect(root, [path.join(root, 'foo.py')]).commands, []);
});

test('Python full mode falls back to full pytest when no related tests exist', (t) => {
  const root = fixture(t, { 'conftest.py': '', 'foo.py': '' });
  assert.deepEqual(detect(root, [path.join(root, 'foo.py')], { mode: 'full' }).commands,
    ['python -m pytest -q -x']);
});

test('Python files without a test setup do not trigger pytest', (t) => {
  const root = fixture(t, { 'foo.py': '' });
  assert.deepEqual(detect(root, [path.join(root, 'foo.py')], { mode: 'full' }).commands, []);
});

test('tests directory alone identifies a Python test setup', (t) => {
  const root = fixture(t, { 'foo.py': '', 'tests/test_foo.py': '' });
  assert.match(detect(root, [path.join(root, 'foo.py')]).commands[0], /^python -m pytest /);
});

test('Vitest related mode includes quoted touched files and typecheck', (t) => {
  const root = fixture(t, {
    'package.json': { scripts: { test: 'vitest', typecheck: 'tsc --noEmit' }, devDependencies: { vitest: '^2' } },
    'src/my component.tsx': '',
  });
  const filename = path.join(root, 'src/my component.tsx');
  const plan = detect(root, [filename]);
  assert.equal(plan.commands.length, 2);
  assert.match(plan.commands[0], /^npx vitest related --run /);
  quoted(plan.commands[0], filename);
  assert.equal(plan.commands[1], 'npm run -s typecheck');
});

test('Jest related mode finds related tests and permits no matches', (t) => {
  const root = fixture(t, {
    'package.json': { scripts: { test: 'jest' }, dependencies: { jest: '^29' } },
    'src/foo.jsx': '',
  });
  const filename = path.join(root, 'src/foo.jsx');
  const command = detect(root, [filename]).commands[0];
  assert.match(command, /^npx jest --findRelatedTests /);
  assert.ok(command.includes(filename));
  assert.match(command, /--passWithNoTests/);
});

test('plain npm test runs when a supported JS file changes', (t) => {
  const root = fixture(t, {
    'package.json': { scripts: { test: 'node --test' } },
    'foo.mjs': '',
  });
  assert.deepEqual(detect(root, [path.join(root, 'foo.mjs')]).commands, ['npm test --silent']);
});

test('full JS mode uses npm test instead of related runner flags', (t) => {
  const root = fixture(t, {
    'package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2' } },
    'foo.ts': '',
  });
  assert.deepEqual(detect(root, [path.join(root, 'foo.ts')], { mode: 'full' }).commands,
    ['npm test --silent']);
});

test('npm placeholder test script is skipped', (t) => {
  const root = fixture(t, {
    'package.json': { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
    'foo.cjs': '',
  });
  assert.deepEqual(detect(root, [path.join(root, 'foo.cjs')]).commands, []);
});

test('Rust requires a touched .rs file and Cargo.toml', (t) => {
  const root = fixture(t, { 'Cargo.toml': '', 'src/lib.rs': '', 'README.md': '' });
  assert.deepEqual(detect(root, [path.join(root, 'src/lib.rs')]).commands, ['cargo check -q']);
  assert.deepEqual(detect(root, [path.join(root, 'README.md')]).commands, []);
});

test('Go builds before vetting', (t) => {
  const root = fixture(t, { 'go.mod': 'module fixture', 'main.go': '' });
  assert.deepEqual(detect(root, [path.join(root, 'main.go')]).commands, ['go build ./...', 'go vet ./...']);
});

test('unrecognized files and empty projects have no commands', (t) => {
  const root = fixture(t, { 'foo.lua': '', 'foo.luau': '', 'README.md': '', 'data.json': '{}' });
  assert.deepEqual(detect(root, ['foo.lua', 'foo.luau', 'README.md', 'data.json']
    .map((name) => path.join(root, name))).commands, []);
  assert.deepEqual(detect(root, []).commands, []);
});

test('custom commands substitute related tests with paths containing spaces', (t) => {
  const root = fixture(t, { 'pytest.ini': '', 'foo.py': '', 'test folder/test_foo.py': '' });
  const command = detect(root, [path.join(root, 'foo.py')], { command: 'python -m pytest {files} --tb=short' }).commands[0];
  assert.match(command, /^python -m pytest /);
  assert.match(command, / --tb=short$/);
  assert.ok(!command.includes('{files}'));
  quoted(command, path.join(root, 'test folder/test_foo.py'));
});

test('custom command without placeholders overrides autodetection', (t) => {
  const root = fixture(t, { 'README.md': '' });
  assert.deepEqual(detect(root, [path.join(root, 'README.md')], { command: 'make verify' }).commands,
    ['make verify']);
});
