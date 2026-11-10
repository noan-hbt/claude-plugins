'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { suggest } = require('../scripts/lib.js');

function emptyStats() {
  return {
    prompts: { count: 0, repeated: [], shortApprovals: { count: 0, share: 0 } },
    commands: { shell: [] },
    errors: { top: [], permissionDenials: { count: 0, commands: [] } },
    context: { clear: 0, compact: 0, resumedAfterReset: 0, longSessionsWithoutCompact: 0 },
    tools: { mcp: [] },
  };
}

const cases = [
  ['permission-denials', stats => { stats.errors.permissionDenials = { count: 2, commands: [{ head: 'npm test', tool: 'Bash', count: 2 }] }; },
    stats => { stats.errors.permissionDenials.commands[0].count = 1; }],
  ['reset-resume', stats => { stats.context.clear = 3; stats.context.resumedAfterReset = 2; },
    stats => { stats.context.resumedAfterReset = 1; }],
  ['repeated-prompts', stats => { stats.prompts.repeated = [{ prompt: 'run tests', count: 3 }]; },
    stats => { stats.prompts.repeated[0].count = 2; }],
  ['read-before-edit', stats => { stats.errors.top = [{ message: 'File has not been read yet', count: 2 }]; },
    stats => { stats.errors.top[0].count = 1; }],
  ['missing-command', stats => { stats.errors.top = [{ message: 'tool: command not found', count: 2 }]; },
    stats => { stats.errors.top[0].count = 1; }],
  ['worktree-fence', stats => { stats.errors.top = [{ message: 'File is isolated in the worktree', count: 1 }]; },
    stats => { stats.errors.top[0].count = 0; }],
  ['batch-decisions', stats => { stats.prompts.count = 20; stats.prompts.shortApprovals = { count: 5, share: 0.25 }; },
    stats => { stats.prompts.shortApprovals.share = 0.24; }],
  ['automate-tests', stats => { stats.commands.shell = [{ head: 'npm test', tool: 'Bash', count: 5 }]; },
    stats => { stats.commands.shell[0].count = 4; }],
  ['delegate-codex', stats => { stats.commands.shell = [{ head: 'codex exec', tool: 'Bash', count: 3 }]; },
    stats => { stats.commands.shell[0].count = 2; }],
  ['long-session-handoff', stats => { stats.context.longSessionsWithoutCompact = 2; },
    stats => { stats.context.longSessionsWithoutCompact = 1; }],
  ['mcp-preflight', stats => { stats.tools.mcp = [{ server: 'github', count: 15, errors: 3, errorRate: 0.2 }]; },
    stats => { stats.tools.mcp[0].errorRate = 0.19; }],
];

test('quiet activity produces no speculative config changes', () => {
  assert.deepEqual(suggest(emptyStats()), []);
});

for (const [id, enable, disable] of cases) {
  test(`${id} fires at its threshold with numeric evidence and a concrete change`, () => {
    const stats = emptyStats();
    enable(stats);
    const suggestions = suggest(stats);
    const suggestion = suggestions.find(row => row.id === id);
    assert.ok(suggestion, id);
    assert.match(suggestion.evidence, /\d/);
    assert.ok(suggestion.change.length > 30);
    assert.match(suggestion.change, /CLAUDE\.md|settings\.json|qa\.json|SKILL\.md|guard plugin/);
    disable(stats);
    assert.ok(!suggest(stats).some(row => row.id === id), `${id} triggered below threshold`);
  });
}

test('all eleven supported rules coexist without duplicate IDs', () => {
  const stats = emptyStats();
  for (const [, enable] of cases) {
    const ruleStats = emptyStats();
    enable(ruleStats);
    stats.prompts.repeated.push(...ruleStats.prompts.repeated);
    if (ruleStats.prompts.shortApprovals.count) {
      stats.prompts.count = ruleStats.prompts.count;
      stats.prompts.shortApprovals = ruleStats.prompts.shortApprovals;
    }
    stats.commands.shell.push(...ruleStats.commands.shell);
    stats.errors.top.push(...ruleStats.errors.top);
    if (ruleStats.errors.permissionDenials.count) stats.errors.permissionDenials = ruleStats.errors.permissionDenials;
    for (const key of Object.keys(stats.context)) stats.context[key] += ruleStats.context[key];
    stats.tools.mcp.push(...ruleStats.tools.mcp);
  }
  const suggestions = suggest(stats);
  assert.equal(suggestions.length, 11);
  assert.equal(new Set(suggestions.map(row => row.id)).size, 11);
  assert.match(suggestions.find(row => row.id === 'permission-denials').change, /Bash\(npm test:\*\)/);
});

test('permission-denial fallback handles unmatched tool calls', () => {
  const stats = emptyStats();
  stats.errors.permissionDenials.count = 3;
  assert.ok(suggest(stats).some(row => row.id === 'permission-denials'));
  stats.errors.permissionDenials.count = 2;
  assert.ok(!suggest(stats).some(row => row.id === 'permission-denials'));
});

test('combined rule thresholds each require both counts and rates', () => {
  const stats = emptyStats();
  stats.prompts.count = 10;
  stats.prompts.shortApprovals = { count: 4, share: 0.4 };
  stats.context.clear = 2;
  stats.context.resumedAfterReset = 10;
  stats.tools.mcp = [{ server: 'github', count: 4, errors: 3, errorRate: 0.75 }];
  assert.deepEqual(suggest(stats), []);
  stats.tools.mcp = [{ server: 'github', count: 5, errors: 2, errorRate: 0.4 }];
  assert.deepEqual(suggest(stats), []);
});
