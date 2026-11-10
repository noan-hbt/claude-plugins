const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeSettings,
  upsertManagedBlock,
  substitutePlaceholders,
  parseToolCheck,
} = require('../lib');

const begin = '<!-- megaclaude:begin -->';
const end = '<!-- megaclaude:end -->';

test('merge keeps user values and keys while setting missing and managed values', () => {
  const current = {
    model: 'sonnet',
    statusLine: { command: 'user-status', padding: 2 },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', custom: true }, other: { budget: 12 } },
    enableWorkflows: false,
    custom: { keep: 'yes' },
    nested: { present: false },
  };
  const profile = {
    model: 'opus',
    statusLine: { type: 'command', command: 'node {{CONFIG_DIR}}/statusline.js' },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium', autoCompactWindow: 500000 } },
    enableWorkflows: true,
    autoCompactEnabled: true,
    nested: { present: true, missing: 42 },
  };
  const beforeCurrent = structuredClone(current);
  const beforeProfile = structuredClone(profile);
  const { result, changes } = mergeSettings(current, profile, {
    configDir: 'C:\\Users\\test\\.claude', platform: 'win32', tools: new Set(),
  });

  assert.equal(result.model, 'opus');
  assert.deepEqual(result.statusLine, {
    command: 'node C:/Users/test/.claude/statusline.js', padding: 2, type: 'command',
  });
  assert.deepEqual(result.modelSettings, {
    'claude-opus-5-5': { effortLevel: 'medium', custom: true, autoCompactWindow: 500000 },
    other: { budget: 12 },
  });
  assert.equal(result.enableWorkflows, false);
  assert.equal(result.autoCompactEnabled, true);
  assert.deepEqual(result.custom, { keep: 'yes' });
  assert.deepEqual(result.nested, { present: false, missing: 42 });
  assert.ok(changes.length > 0);
  assert.ok(changes.every(change => typeof change === 'string'));
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(profile, beforeProfile);
  assert.deepEqual(mergeSettings(result, profile, {
    configDir: 'C:\\Users\\test\\.claude', platform: 'win32', tools: new Set(),
  }), { result, changes: [] });
});

test('permissions form ordered unions for allow, deny, and ask', () => {
  const { result } = mergeSettings({
    permissions: {
      allow: ['Bash(user:*)', 'Bash(git status:*)'],
      deny: ['Bash(rm:*)'],
      ask: ['Bash(curl:*)'],
      defaultMode: 'default',
    },
  }, {
    permissions: {
      allow: ['Bash(git status:*)', 'Bash(npm test:*)'],
      deny: ['Bash(rm:*)', 'Bash(del:*)'],
      ask: ['Bash(curl:*)', 'Bash(wget:*)'],
    },
  });

  assert.deepEqual(result.permissions, {
    allow: ['Bash(user:*)', 'Bash(git status:*)', 'Bash(npm test:*)'],
    deny: ['Bash(rm:*)', 'Bash(del:*)'],
    ask: ['Bash(curl:*)', 'Bash(wget:*)'],
    defaultMode: 'default',
  });
});

test('Windows hook dedupe finds matching command anywhere in the same event', () => {
  const existing = {
    matcher: 'Read',
    hooks: [
      { type: 'command', command: 'echo preserve' },
      { type: 'command', command: 'NODE C:\\Users\\Test\\.claude\\caveman-on.js', timeout: 19 },
    ],
  };
  const current = { hooks: { SessionStart: [existing] } };
  const profile = { hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node {{CONFIG_DIR}}/caveman-on.js' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'node {{CONFIG_DIR}}/caveman-on.js' }] }],
  } };
  const { result } = mergeSettings(current, profile, {
    configDir: 'C:/Users/Test/.claude', platform: 'win32', tools: new Set(),
  });

  assert.deepEqual(result.hooks.SessionStart, [existing]);
  assert.equal(result.hooks.SessionEnd.length, 1);
  assert.equal(result.hooks.SessionEnd[0].hooks[0].command, 'node C:/Users/Test/.claude/caveman-on.js');
});

test('POSIX hook commands remain case-sensitive and duplicate profile groups collapse', () => {
  const group = command => ({ hooks: [{ type: 'command', command }] });
  const { result } = mergeSettings({ hooks: { SessionStart: [group('node /tmp/Case.js')] } }, {
    hooks: { SessionStart: [group('node /tmp/case.js'), group('node /tmp/case.js')] },
  }, { platform: 'linux', tools: new Set() });

  assert.deepEqual(result.hooks.SessionStart.map(item => item.hooks[0].command), [
    'node /tmp/Case.js', 'node /tmp/case.js',
  ]);
});

test('requires skips unavailable tools and is stripped from installed hook groups', () => {
  const profile = { hooks: { PreToolUse: [{
    matcher: 'Bash', requires: 'rtk', hooks: [{ type: 'command', command: 'rtk hook claude' }],
  }] } };
  const current = { hooks: { PreToolUse: [{
    matcher: 'Write', hooks: [{ type: 'command', command: 'user-hook' }],
  }] } };
  const unavailable = mergeSettings(current, profile, { tools: new Set() }).result;
  assert.deepEqual(unavailable.hooks.PreToolUse, current.hooks.PreToolUse);
  const available = mergeSettings(current, profile, { tools: new Set(['rtk']) }).result;
  assert.deepEqual(available.hooks.PreToolUse, [current.hooks.PreToolUse[0], {
    matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }],
  }]);
  assert.equal(profile.hooks.PreToolUse[0].requires, 'rtk');
});

test('managed block appends to existing notes and replaces only managed content', () => {
  const notes = '# User notes\n\nKeep these instructions.\n';
  const appended = upsertManagedBlock(notes, '# Managed\n\nFirst version.\n');
  assert.ok(appended.startsWith(notes));
  assert.equal(appended.split(begin).length - 1, 1);
  assert.equal(appended.split(end).length - 1, 1);
  assert.ok(appended.includes('# Managed\n\nFirst version.'));

  const prefix = '# Before\n\n';
  const suffix = '\n\n# After\nUser tail.\n';
  const existing = `${prefix}${begin}\nOld instructions.\n${end}${suffix}`;
  const replaced = upsertManagedBlock(existing, 'New instructions.\n');
  assert.ok(replaced.startsWith(prefix + begin));
  assert.ok(replaced.endsWith(end + suffix));
  assert.ok(replaced.includes('New instructions.'));
  assert.ok(!replaced.includes('Old instructions.'));
  assert.equal(upsertManagedBlock(replaced, 'New instructions.\n'), replaced);
});

test('managed block creates a document when empty', () => {
  const result = upsertManagedBlock('', 'Managed instructions.');
  assert.match(result, /^<!-- megaclaude:begin -->\r?\nManaged instructions\.\r?\n<!-- megaclaude:end -->/);
  assert.equal(upsertManagedBlock(result, 'Managed instructions.'), result);
});

test('malformed managed markers fail instead of discarding user content', () => {
  for (const text of [
    `User notes\n${begin}\nUnclosed instructions.\n`,
    `User notes\n${end}\nTrailing instructions.\n`,
    `${end}\nUser notes\n${begin}`,
    `${begin}\nFirst block\n${end}\nUser notes\n${begin}\nSecond block\n${end}`,
  ]) {
    assert.throws(() => upsertManagedBlock(text, 'Replacement'), /managed block|markers/i);
  }
});

test('placeholder substitution handles strings and nested JSON without mutating input', () => {
  const input = {
    command: 'node {{CONFIG_DIR}}/statusline.js',
    array: ['{{CONFIG_DIR}}/a', { value: '{{CONFIG_DIR}}/{{CONFIG_DIR}}' }, true, null, 3],
    unknown: '{{OTHER}}',
  };
  const before = structuredClone(input);
  const ctx = { configDir: 'C:\\Users\\Test User\\.claude' };
  assert.deepEqual(substitutePlaceholders(input, ctx), {
    command: 'node C:/Users/Test User/.claude/statusline.js',
    array: ['C:/Users/Test User/.claude/a', { value: 'C:/Users/Test User/.claude/C:/Users/Test User/.claude' }, true, null, 3],
    unknown: '{{OTHER}}',
  });
  assert.equal(substitutePlaceholders('{{CONFIG_DIR}}/a', ctx), 'C:/Users/Test User/.claude/a');
  assert.deepEqual(input, before);
});

test('tool checks parse executable and arguments, including quoted paths', () => {
  assert.deepEqual(parseToolCheck('git --version'), { command: 'git', args: ['--version'] });
  assert.deepEqual(parseToolCheck('  npm  list -g @openai/codex  '), {
    command: 'npm', args: ['list', '-g', '@openai/codex'],
  });
  assert.deepEqual(parseToolCheck('"C:\\Program Files\\Git\\cmd\\git.exe" --version'), {
    command: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['--version'],
  });
  assert.deepEqual(parseToolCheck('python -c "print(1 + 2)"'), {
    command: 'python', args: ['-c', 'print(1 + 2)'],
  });
});

test('managed block wraps identical unmarked text instead of duplicating it', () => {
  const {upsertManagedBlock} = require('../lib');
  const block = '# Prefs\n- court\n';
  const out = upsertManagedBlock('intro\n\n# Prefs\r\n- court\n\nfin\n', block);
  assert.strictEqual(out.split('# Prefs').length, 2);
  assert.match(out, /<!-- megaclaude:begin -->\n# Prefs\n- court\n<!-- megaclaude:end -->/);
  assert.match(out, /^intro/);
  assert.match(out, /fin\n$/);
});
