const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseToolCheck } = require('../lib');

const megaclaude = path.resolve(__dirname, '..');
const install = path.join(megaclaude, 'install.js');
const profile = JSON.parse(fs.readFileSync(path.join(megaclaude, 'profile.json'), 'utf8'));
const begin = '<!-- megaclaude:begin -->';
const end = '<!-- megaclaude:end -->';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'megaclaude-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(root) {
  const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        result[relative + '/'] = null;
        visit(absolute);
      } else {
        result[relative] = fs.readFileSync(absolute).toString('base64');
      }
    }
  }
  visit(root);
  return result;
}

function run(root, configDirs, extraArgs = []) {
  return spawnSync(process.execPath, [
    install, '--skip-tools', '--skip-plugins',
    ...configDirs.flatMap(dir => ['--config-dir', dir]), ...extraArgs,
  ], {
    cwd: megaclaude,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'unused-default') },
  });
}

function expectSuccess(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function backups(dir, file) {
  return fs.readdirSync(dir).filter(name => name.startsWith(file + '.bak-'));
}

test('dry-run reports planned sync and writes nothing in existing or absent config dirs', t => {
  const root = workspace(t);
  const existing = path.join(root, 'existing config');
  const absent = path.join(root, 'absent config');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'settings.json'), '{"custom":true}\n');
  fs.writeFileSync(path.join(existing, 'CLAUDE.md'), '# User instructions\n');
  const before = snapshot(root);

  const result = run(root, [existing, absent], ['--dry-run']);
  expectSuccess(result);
  assert.match(result.stdout, /dry[- ]run/i);
  assert.match(result.stdout, /settings\.json/);
  assert.match(result.stdout, /CLAUDE\.md/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(absent), false);
});

test('real sync preserves user config, backs up replaced files, and is idempotent across dirs', t => {
  const root = workspace(t);
  const first = path.join(root, 'first config');
  const second = path.join(root, 'second config');
  fs.mkdirSync(first);
  const originalSettings = JSON.stringify({
    model: 'sonnet', custom: { untouched: true }, enableWorkflows: false,
    permissions: { allow: ['Bash(user:*)'], deny: ['Bash(rm:*)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo custom-hook' }] }] },
  }, null, 4) + '\n';
  const originalLocal = '{"outputStyle":"User style","customLocal":true}\n';
  const originalStatus = '// Custom status line\n';
  const prefix = '# Personal instructions\n\n';
  const suffix = '\n\n# Personal footer\n';
  const originalClaude = `${prefix}${begin}\nOutdated managed instructions.\n${end}${suffix}`;
  const originalRtk = '# User RTK instructions\n';
  const originals = {
    'settings.json': originalSettings,
    'settings.local.json': originalLocal,
    'statusline.js': originalStatus,
    'CLAUDE.md': originalClaude,
  };
  for (const [file, content] of Object.entries(originals)) fs.writeFileSync(path.join(first, file), content);
  fs.writeFileSync(path.join(first, 'RTK.md'), originalRtk);

  const result = run(root, [first, second]);
  expectSuccess(result);
  for (const dir of [first, second]) {
    const settings = readJson(path.join(dir, 'settings.json'));
    assert.equal(settings.model, profile.settings.model);
    assert.equal(settings.statusLine.command, 'node "' + dir.replace(/\\/g, '/') + '/statusline.js"');
    assert.deepEqual(parseToolCheck(settings.statusLine.command), {
      command: 'node', args: [dir.replace(/\\/g, '/') + '/statusline.js'],
    });
    assert.ok(settings.permissions.allow.includes('Bash(codex exec:*)'));
    assert.ok(settings.hooks.SessionStart.some(group => group.hooks.some(hook => hook.command.includes('/caveman-on.js'))));
    const activation = settings.hooks.SessionStart.flatMap(group => group.hooks)
      .find(hook => hook.command.includes('/caveman-on.js')).command;
    assert.deepEqual(parseToolCheck(activation), {
      command: 'node', args: [dir.replace(/\\/g, '/') + '/caveman-on.js'],
    });
    const activated = spawnSync(activation, {
      cwd: dir, shell: true, encoding: 'utf8', timeout: 10000,
    });
    expectSuccess(activated);
    assert.match(activated.stdout, /Caveman mode: on/);
    assert.ok(!JSON.stringify(settings).includes('"requires"'));
    assert.ok(!JSON.stringify(settings).includes('{{CONFIG_DIR}}'));
    for (const file of ['statusline.js', 'caveman-on.js']) {
      assert.deepEqual(fs.readFileSync(path.join(dir, file)), fs.readFileSync(path.join(megaclaude, 'home', file)));
    }
    const settingsText = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.equal(settingsText, JSON.stringify(settings, null, 2) + '\n');
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.equal(claude.split(begin).length - 1, 1);
    assert.equal(claude.split(end).length - 1, 1);
    assert.ok(claude.includes(fs.readFileSync(path.join(megaclaude, 'home', 'CLAUDE.md'), 'utf8').trim()));
  }

  const settings = readJson(path.join(first, 'settings.json'));
  assert.deepEqual(settings.custom, { untouched: true });
  assert.equal(settings.enableWorkflows, false);
  assert.deepEqual(settings.permissions.deny, ['Bash(rm:*)']);
  assert.equal(settings.permissions.allow[0], 'Bash(user:*)');
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo custom-hook');
  assert.deepEqual(readJson(path.join(first, 'settings.local.json')), { outputStyle: 'User style', customLocal: true });
  assert.equal(readJson(path.join(second, 'settings.local.json')).outputStyle, 'Concise');
  const claude = fs.readFileSync(path.join(first, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith(prefix + begin));
  assert.ok(claude.endsWith(end + suffix));
  assert.ok(!claude.includes('Outdated managed instructions.'));
  assert.equal(fs.readFileSync(path.join(first, 'RTK.md'), 'utf8'), originalRtk);
  assert.deepEqual(fs.readFileSync(path.join(second, 'RTK.md')), fs.readFileSync(path.join(megaclaude, 'home', 'RTK.md')));
  for (const file of ['settings.json', 'statusline.js', 'CLAUDE.md']) {
    const names = backups(first, file);
    assert.equal(names.length, 1, file);
    assert.match(names[0], /\.bak-\d{8}-\d{6}/);
    assert.equal(fs.readFileSync(path.join(first, names[0]), 'utf8'), originals[file]);
  }
  assert.equal(backups(first, 'RTK.md').length, 0);
  assert.equal(fs.readdirSync(second).filter(name => name.includes('.bak-')).length, 0);

  const afterFirst = snapshot(root);
  const again = run(root, [first, second]);
  expectSuccess(again);
  assert.match(again.stdout, /no changes/i);
  assert.deepEqual(snapshot(root), afterFirst);
});

test('invalid existing settings JSON survives a failed sync unchanged', t => {
  const root = workspace(t);
  const dir = path.join(root, 'broken config');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'settings.json');
  const malformed = '{"permissions": [ broken JSON\n';
  fs.writeFileSync(file, malformed);
  const result = run(root, [dir]);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /settings\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  assert.equal(backups(dir, 'settings.json').length, 0);
});

test('malformed managed markers preserve every existing file on failed sync', t => {
  const root = workspace(t);
  const dir = path.join(root, 'malformed managed block');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"model":"sonnet","custom":true}\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# User instructions\n${begin}\nKeep this unclosed text.\n`);
  const before = snapshot(root);
  const result = run(root, [dir]);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /managed block|markers/i);
  assert.deepEqual(snapshot(root), before);
});
