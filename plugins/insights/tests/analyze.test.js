'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  analyze, parseLine, normalizePrompt, commandHead, projectName, percentile,
  suggest, renderMarkdown,
} = require('../scripts/lib.js');

const configDir = path.join(__dirname, 'fixtures', 'config');
const now = new Date('2026-11-10T12:00:00Z');
const analyzeFixture = options => analyze({ configDirs: [configDir], now, ...options });
const rowCount = (rows, name, key = 'name') => rows.find(row => row[key] === name)?.count || 0;
const prompts = [
  'Bonjour, peux tu corriger le fichier et faire les tests ?', 'ok', 'vas-y', 'yes',
  'Always test changes 123', 'always test changes 456', 'ALWAYS TEST CHANGES 789',
  'Non, ça marche pas, refais les tests.', 'wrong response', 'reprends le travail',
  'continue with the next step', 'Investigate parser behavior', 'Please inspect parser',
];

function temporaryConfig(t, records) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'projects', 'C--work-sample');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'main.jsonl'), records.map(record =>
    typeof record === 'string' ? record : JSON.stringify(record)).join('\n'));
  return directory;
}

function message(type, content, timestamp = '2026-11-01T10:00:00Z') {
  return { type, cwd: '/work/sample', timestamp, message: { role: type, content } };
}

test('parseLine skips malformed, empty and non-record JSON safely', () => {
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('null'), null);
  assert.equal(parseLine('[]'), null);
  assert.equal(parseLine('42'), null);
  const record = message('user', 'hello');
  assert.deepEqual(parseLine(JSON.stringify(record)), record);
});

test('prompt normalization removes case, spacing, paths and numbers', () => {
  assert.equal(normalizePrompt('  RUN   tests 123  '), 'run tests <n>');
  assert.equal(normalizePrompt('Review /tmp/source.js 12'), normalizePrompt('review C:\\work\\source.js 99'));
  assert.equal(normalizePrompt('Review ./src/source.js 12'), normalizePrompt('review /tmp/source.js 99'));
  assert.ok(!normalizePrompt('Read /tmp/private/source.js 123').includes('private'));
});

test('shell command heads strip rtk and preserve first two tokens', () => {
  assert.equal(commandHead('rtk npm test -- --runInBand'), 'npm test');
  assert.equal(commandHead('  RTK   git status --short'), 'git status');
  assert.equal(commandHead('Get-Content README.md'), 'get-content readme.md');
  assert.equal(commandHead('pytest'), 'pytest');
  assert.equal(commandHead(''), '');
});

test('project names handle Windows, POSIX and slug paths', () => {
  assert.equal(projectName('C--work-alpha', 'C:\\work\\alpha'), 'alpha');
  assert.equal(projectName('-work-alpha', '/work/alpha/'), 'alpha');
  assert.equal(projectName('C--work-alpha'), 'alpha');
});

test('percentiles use interpolation without mutating values', () => {
  const values = [4, 1, 3, 2];
  assert.equal(percentile(values, 0.5), 2.5);
  assert.ok(Math.abs(percentile(values, 0.9) - 3.7) < 1e-9);
  assert.equal(percentile([9], 0.9), 9);
  assert.equal(percentile([], 0.9), 0);
  assert.deepEqual(values, [4, 1, 3, 2]);
});

test('fixture sessions, subagents, periods and usage totals', async () => {
  const stats = await analyzeFixture();
  assert.equal(stats.sessions.total, 2);
  assert.equal(stats.sessions.subagents, 1);
  assert.equal(stats.sources.files, 4);
  assert.equal(stats.sources.badLines, 1);
  assert.equal(stats.sources.unreadableFiles, 0);
  assert.equal(stats.period.days, 30);
  assert.equal(Date.parse(stats.period.to), now.getTime());
  assert.equal(Date.parse(stats.period.from), now.getTime() - 30 * 86400000);
  const alpha = stats.sessions.projects.find(row => row.name === 'alpha');
  const beta = stats.sessions.projects.find(row => row.name === 'beta');
  assert.ok(alpha);
  assert.ok(beta);
  assert.deepEqual([alpha.sessions, alpha.subagents], [1, 1]);
  assert.deepEqual(alpha.tokens, { input: 350, output: 70, cacheRead: 105 });
  assert.deepEqual(beta.tokens, { input: 70, output: 7, cacheRead: 14 });
  assert.equal(Date.parse(alpha.first), Date.parse('2026-11-01T10:00:00Z'));
  assert.equal(Date.parse(alpha.last), Date.parse('2026-11-01T13:01:00Z'));
});

test('human prompt metrics exclude tool results, wrappers, interrupts and subagent prompts', async () => {
  const stats = await analyzeFixture();
  assert.equal(stats.prompts.count, prompts.length);
  assert.equal(stats.prompts.length.median, percentile(prompts.map(value => value.length), 0.5));
  assert.equal(stats.prompts.length.p90, percentile(prompts.map(value => value.length), 0.9));
  assert.equal(stats.prompts.shortApprovals.count, 3);
  assert.equal(stats.prompts.shortApprovals.share, 3 / prompts.length);
  assert.ok(stats.prompts.french.count >= 2);
  assert.ok(stats.prompts.french.count <= prompts.length);
  assert.equal(stats.prompts.french.share, stats.prompts.french.count / prompts.length);
  assert.equal(rowCount(stats.prompts.repeated, normalizePrompt('always test changes 123'), 'prompt'), 3);
  assert.equal(stats.prompts.friction.count, 2);
  assert.ok(stats.prompts.friction.examples.some(row => row.prompt.includes('ça marche pas')));
  assert.ok(stats.prompts.friction.examples.every(row => row.prompt.length <= 100));
  assert.equal(stats.errors.interrupts, 1);
  assert.equal(stats.hours.length, 24);
  assert.equal(stats.hours.reduce((sum, count) => sum + count, 0), prompts.length);
  assert.equal(stats.hours[new Date('2026-11-01T10:00:00Z').getHours()], 12);
  assert.equal(stats.hours[new Date('2026-11-03T15:00:00Z').getHours()], 1);
});

test('slash commands, skills, agents and shell heads retain useful detail', async () => {
  const stats = await analyzeFixture();
  assert.equal(rowCount(stats.commands.slash, '/clear'), 1);
  assert.equal(rowCount(stats.commands.slash, '/compact'), 1);
  assert.equal(rowCount(stats.commands.slash, '/help'), 1);
  assert.equal(rowCount(stats.commands.skills, 'qa:qa'), 1);
  assert.equal(rowCount(stats.commands.agents.byType, 'Explore'), 1);
  assert.equal(rowCount(stats.commands.agents.byType, 'general-purpose'), 1);
  assert.equal(rowCount(stats.commands.agents.byModel, 'haiku'), 1);
  assert.equal(rowCount(stats.commands.agents.byModel, 'sonnet'), 1);
  assert.equal(rowCount(stats.commands.shell, 'npm test', 'head'), 1);
  assert.equal(rowCount(stats.commands.shell, 'git status', 'head'), 1);
  assert.ok(stats.commands.shell.some(row => row.tool === 'PowerShell' && row.head === 'get-content readme.md'));
  assert.equal(stats.context.clear, 1);
  assert.equal(stats.context.compact, 1);
  assert.equal(stats.context.resumedAfterReset, 2);
  assert.equal(stats.context.longSessionsWithoutCompact, 0);
});

test('tool errors, permission denials and MCP failures correlate with tool_use IDs', async () => {
  const stats = await analyzeFixture();
  assert.equal(stats.tools.total, 12);
  assert.equal(rowCount(stats.tools.byName, 'Bash'), 4);
  assert.equal(rowCount(stats.tools.byName, 'Agent'), 2);
  assert.equal(stats.errors.total, 3);
  assert.equal(stats.errors.permissionDenials.count, 2);
  assert.equal(rowCount(stats.errors.permissionDenials.commands, 'npm test', 'head'), 1);
  assert.equal(rowCount(stats.errors.permissionDenials.commands, 'get-content readme.md', 'head'), 1);
  assert.ok(stats.errors.top.some(row => /file has not been read yet/i.test(row.message)));
  assert.ok(stats.errors.top.some(row => /command not found/i.test(row.message)));
  assert.ok(!stats.errors.top.some(row => /requires approval|permission for this action/i.test(row.message)));
  assert.deepEqual(stats.tools.mcp, [{ server: 'github', count: 2, errors: 1, errorRate: 0.5 }]);
});

test('project and date filters exclude unrelated or old activity', async () => {
  const alpha = await analyzeFixture({ project: 'alpha' });
  assert.equal(alpha.sessions.total, 1);
  assert.equal(alpha.sessions.subagents, 1);
  assert.equal(alpha.prompts.count, 12);
  assert.equal(alpha.sessions.projects.length, 1);
  const recent = await analyzeFixture({ days: 8 });
  assert.equal(recent.sessions.total, 1);
  assert.equal(recent.sessions.projects[0].name, 'beta');
  assert.equal(recent.prompts.count, 1);
  const none = await analyzeFixture({ project: 'does-not-exist' });
  assert.equal(none.sessions.total, 0);
  assert.equal(none.prompts.count, 0);
  assert.equal(none.prompts.shortApprovals.share, 0);
});

test('duplicate config directories never double-count transcript realpaths', async () => {
  const once = await analyzeFixture();
  const twice = await analyzeFixture({ configDirs: [configDir, configDir] });
  assert.deepEqual(twice.sessions, once.sessions);
  assert.deepEqual(twice.prompts, once.prompts);
  assert.equal(twice.sources.files, once.sources.files);
});

test('symlinked config project trees deduplicate by realpath', async t => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const linkedConfig = path.join(directory, 'linked-config');
  fs.mkdirSync(linkedConfig);
  try {
    fs.symlinkSync(path.join(configDir, 'projects'), path.join(linkedConfig, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Symlinks unavailable: ${error.code}`);
    throw error;
  }
  const stats = await analyzeFixture({ configDirs: [configDir, linkedConfig] });
  assert.equal(stats.sessions.total, 2);
  assert.equal(stats.sources.files, 4);
  assert.equal(stats.prompts.count, 13);
});

test('missing config directory yields an empty report', async () => {
  const stats = await analyzeFixture({ configDirs: [path.join(configDir, 'missing')] });
  assert.equal(stats.sessions.total, 0);
  assert.equal(stats.prompts.count, 0);
  assert.equal(stats.tools.total, 0);
  assert.equal(stats.errors.total, 0);
  assert.equal(stats.hours.length, 24);
});

test('future, invalid-date and bad lines do not contribute period activity', async t => {
  const config = temporaryConfig(t, [
    message('user', 'current prompt'),
    message('user', 'future prompt', '2026-12-01T00:00:00Z'),
    message('user', 'invalid timestamp', 'not-a-date'),
    '{bad',
    message('assistant', [{ type: 'text', text: 'done' }]),
  ]);
  const stats = await analyzeFixture({ configDirs: [config] });
  assert.equal(stats.prompts.count, 1);
  assert.equal(stats.sources.badLines, 1);
});

test('resumes must immediately follow a reset and long sessions require no compact', async t => {
  const config = temporaryConfig(t, [
    message('user', '<command-name>/clear</command-name>'),
    message('user', 'a different task'),
    message('user', 'resume the previous task'),
    message('assistant', [{ type: 'text', text: 'done' }], '2026-11-01T11:01:00Z'),
  ]);
  const stats = await analyzeFixture({ configDirs: [config] });
  assert.equal(stats.context.clear, 1);
  assert.equal(stats.context.resumedAfterReset, 0);
  assert.equal(stats.context.longSessionsWithoutCompact, 1);
});

test('CLI --json and repeatable --config-dir produce machine-readable reports', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'analyze.js'),
    '--days', '100000', '--project', 'alpha', '--json', '--config-dir', configDir,
    '--config-dir', configDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.suggestions));
  assert.equal(report.stats.sessions.total, 2);
  assert.equal(report.stats.sessions.subagents, 1);
  assert.equal(report.stats.prompts.count, 13);
  assert.equal(report.stats.sessions.projects[0].name, 'alpha');
});

test('CLI rejects invalid arguments with nonzero exit and useful error', () => {
  for (const args of [['--days', '0'], ['--days', 'nope'], ['--project'], ['--config-dir'], ['--unknown']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'analyze.js'), ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.ok(result.stderr.trim(), args.join(' '));
  }
});

test('markdown includes compact metric tables and concrete Suggestions', async () => {
  const stats = await analyzeFixture();
  const suggestions = suggest(stats);
  const markdown = renderMarkdown(stats, suggestions);
  assert.match(markdown, /^# .*insights/im);
  assert.match(markdown, /\| Project \|/);
  assert.match(markdown, /\| Main sessions \| 2 \|/);
  assert.match(markdown, /^## Suggestions$/m);
  assert.match(markdown, /CLAUDE\.md/);
  assert.match(markdown, /always test changes/);
  assert.match(markdown, /github/);
});

test('markdown escapes transcript content inside tables', async () => {
  const stats = await analyzeFixture();
  stats.prompts.repeated = [{ prompt: 'do | <script>\nnext', count: 3 }];
  const markdown = renderMarkdown(stats, []);
  assert.ok(!markdown.includes('<script>'));
  assert.ok(markdown.includes('&lt;script&gt;'));
  assert.ok(markdown.includes('do \\|'));
});
