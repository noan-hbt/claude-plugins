'use strict';

const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const count = rows => rows.reduce((total, row) => total + number(row.count), 0);
const percent = value => `${(number(value) * 100).toFixed(1)}%`;

function suggest(stats = {}) {
  const suggestions = [];
  const errors = stats.errors || {};
  const prompts = stats.prompts || {};
  const context = stats.context || {};
  const shell = list(stats.commands?.shell);
  const topErrors = list(errors.top);
  const errorMatches = pattern => topErrors.filter(row => pattern.test(row.message || ''));
  const add = (id, evidence, change) => suggestions.push({ id, evidence, change });

  const denials = errors.permissionDenials || {};
  const deniedCommands = list(denials.commands).filter(row => number(row.count) >= 2);
  if (deniedCommands.length) {
    const permissions = deniedCommands.map(row => `${row.tool === 'PowerShell' ? 'PowerShell' : 'Bash'}(${row.head}:*)`);
    add('permission-denials',
      `${number(denials.count)} permission denials; ${deniedCommands.map(row => `${row.head}: ${number(row.count)}`).join(', ')} (threshold: 2 per command head).`,
      `Review each command's safety, then merge ${JSON.stringify({ permissions: { allow: permissions } })} into .claude/settings.json. Use the guard plugin for commands needing inspection instead of a persistent allow rule.`);
  } else if (number(denials.count) >= 3) {
    add('permission-denials', `${number(denials.count)} permission denials (threshold: 3); no command head denied at least twice.`,
      'Use the guard plugin to inspect repeated permission requests; add only reviewed, narrowly scoped commands to .claude/settings.json permissions.allow.');
  }

  if (number(context.clear) >= 3 && number(context.resumedAfterReset) >= 2) {
    add('reset-resume', `${number(context.clear)} /clear calls and ${number(context.resumedAfterReset)} resume prompts after resets (thresholds: 3 and 2).`,
      'Append to project CLAUDE.md: "Before /clear, run the flow plugin /handoff; start the next session by loading the handoff and resuming its next action automatically."');
  }

  const repeated = list(prompts.repeated).filter(row => number(row.count) >= 3).slice(0, 3);
  if (repeated.length) {
    add('repeated-prompts', repeated.map(row => `${JSON.stringify(row.prompt)}: ${number(row.count)} occurrences (threshold: 3)`).join('; '),
      `Append verified recurring instructions to project CLAUDE.md: ${repeated.map(row => JSON.stringify(row.prompt)).join('; ')}. Replace stripped path/number placeholders with project facts first. For a recurring procedure, create .claude/skills/<procedure>/SKILL.md with that procedure instead.`);
  }

  const unread = errorMatches(/file has not been read yet/i);
  if (count(unread) >= 2) {
    add('read-before-edit', `${count(unread)} "File has not been read yet" errors (threshold: 2).`,
      'Append to project CLAUDE.md: "Read each existing file in the current session before editing it; re-read it after external changes."');
  }

  const missing = errorMatches(/command not found|not recognized|is not recognised|is not recognized/i);
  if (count(missing) >= 2) {
    add('missing-command', `${count(missing)} missing-command errors (threshold: 2): ${missing.slice(0, 3).map(row => row.message).join('; ')}.`,
      'Install the named missing tools or fix the shell PATH, then verify with command -v <tool> (Bash) or Get-Command <tool> (PowerShell). Append verified tool paths and setup commands to project CLAUDE.md under "Setup".');
  }

  const worktree = errorMatches(/isolated in the worktree/i);
  if (count(worktree) >= 1) {
    add('worktree-fence', `${count(worktree)} "isolated in the worktree" errors (threshold: 1).`,
      'Enable the guard plugin worktree-fence. Append to project CLAUDE.md: "Keep reads and writes inside the current worktree; resolve project paths from the current working directory."');
  }

  const approvals = prompts.shortApprovals || {};
  if (number(approvals.count) >= 5 && number(approvals.share) >= 0.25) {
    add('batch-decisions', `${number(approvals.count)} short approvals among ${number(prompts.count)} prompts (${percent(approvals.share)}; thresholds: 5 and 25%).`,
      'Append to project CLAUDE.md: "Batch routine decisions and continue authorized reversible work without asking for approval at each step. Ask only for missing requirements or consequential actions needing explicit approval."');
  }

  const tests = shell.filter(row => /^(?:(?:npm|pnpm|yarn|bun) (?:test|run test)|(?:npx|bunx) (?:vitest|jest)|(?:go|cargo|dotnet|gradle) test|(?:pytest|py\.test|vitest|jest|ctest|invoke-pester)(?:\s|$)|(?:node --test|mvn test))/i.test(row.head || ''));
  if (count(tests) >= 5) {
    add('automate-tests', `${count(tests)} manual shell test runs (threshold: 5): ${tests.map(row => `${row.head}: ${number(row.count)}`).join(', ')}.`,
      'Use the qa plugin. Create or merge .claude/qa.json using the qa plugin schema and the project\'s verified test commands; append to project CLAUDE.md: "Use the qa plugin for routine verification after changes."');
  }

  const codex = shell.filter(row => /^codex(?:\.exe)? exec(?:\s|$)/i.test(row.head || ''));
  if (count(codex) >= 3) {
    add('delegate-codex', `${count(codex)} codex exec calls (threshold: 3).`,
      'Use the delegate plugin. Append to project CLAUDE.md: "Route recurring Codex tasks through the delegate plugin; supply a bounded task, relevant files, and acceptance checks."');
  }

  if (number(context.longSessionsWithoutCompact) >= 2) {
    add('long-session-handoff', `${number(context.longSessionsWithoutCompact)} sessions lasting at least 60 minutes or 50 prompts without /compact (threshold: 2).`,
      'Append to project CLAUDE.md: "At a major task boundary, or before context pressure, run the flow plugin /handoff and resume from its saved next action; use /compact when continuing in the same session."');
  }

  const noisyServers = list(stats.tools?.mcp).filter(row => number(row.count) >= 5 && number(row.errors) >= 3 && number(row.errorRate ?? (row.errors / row.count)) >= 0.2);
  if (noisyServers.length) {
    add('mcp-preflight', noisyServers.map(row => `${row.server}: ${number(row.errors)}/${number(row.count)} failed calls (${percent(row.errorRate ?? (row.errors / row.count))})`).join('; ') + ' (thresholds: 5 calls, 3 errors, 20% error rate).',
      `Create .claude/skills/mcp-preflight/SKILL.md with: "Before using ${noisyServers.map(row => row.server).join(', ')}, verify server connectivity, authentication, and required project/resource IDs with a read-only call. Stop and repair the specific failed prerequisite before retrying."`);
  }

  return suggestions;
}

function escapeCell(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/([`*_[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}

function table(headers, rows) {
  return [`| ${headers.map(escapeCell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(escapeCell).join(' | ')} |`)].join('\n');
}

function renderMarkdown(stats = {}, suggestions = suggest(stats)) {
  const sessions = stats.sessions || {};
  const prompts = stats.prompts || {};
  const commands = stats.commands || {};
  const tools = stats.tools || {};
  const errors = stats.errors || {};
  const context = stats.context || {};
  const period = stats.period || {};
  const sources = stats.sources || {};
  const sections = ['# Claude Code insights'];
  const section = (title, contents) => sections.push(`## ${title}\n\n${contents}`);
  const named = rows => list(rows).map(row => [row.name, number(row.count)]);
  const addCounts = (title, rows, label = 'Name') => {
    if (list(rows).length) section(title, table([label, 'Count'], named(rows)));
  };

  sections.push(`${escapeCell(period.from || 'Start')} → ${escapeCell(period.to || 'End')} · ${number(period.days)} days${period.project ? ` · project: ${escapeCell(period.project)}` : ''}`);
  sections.push(`${number(sources.files)} transcript files · ${number(sources.badLines)} bad lines skipped · ${number(sources.unreadableFiles)} unreadable files${list(sources.configDirs).length ? ` · config: ${sources.configDirs.map(escapeCell).join(', ')}` : ''}`);

  section('Overview', table(['Metric', 'Value'], [
    ['Main sessions', number(sessions.total)], ['Subagent transcripts', number(sessions.subagents)],
    ['User prompts', number(prompts.count)], ['Prompt length median / p90 (characters)', `${number(prompts.length?.median)} / ${number(prompts.length?.p90)}`],
    ['French prompts (heuristic)', `${number(prompts.french?.count)} (${percent(prompts.french?.share)})`],
    ['Short approvals', `${number(prompts.shortApprovals?.count)} (${percent(prompts.shortApprovals?.share)})`],
    ['Friction prompts', number(prompts.friction?.count)], ['Tool calls', number(tools.total)],
    ['Tool errors (excluding permission denials)', number(errors.total)], ['Permission denials', number(errors.permissionDenials?.count)],
    ['Interrupts', number(errors.interrupts)],
  ]));

  if (list(sessions.projects).length) section('Projects', table(['Project', 'Sessions', 'Subagents', 'First', 'Last', 'Input', 'Output', 'Cache read'],
    sessions.projects.map(row => [row.name || row.slug, number(row.sessions), number(row.subagents), row.first, row.last,
      number(row.tokens?.input), number(row.tokens?.output), number(row.tokens?.cacheRead)])));

  if (list(prompts.repeated).length) section('Repeated prompts', table(['Normalized prompt', 'Count'],
    prompts.repeated.slice(0, 15).map(row => [row.prompt, number(row.count)])));
  if (list(prompts.friction?.examples).length) section('Friction examples', table(['Prompt', 'Count'],
    prompts.friction.examples.slice(0, 15).map(row => [String(row.prompt || '').slice(0, 100), number(row.count)])));
  addCounts('Slash commands', commands.slash, 'Command');
  addCounts('Skills', commands.skills, 'Skill');
  addCounts('Agents by type', commands.agents?.byType, 'Type');
  addCounts('Agents by model', commands.agents?.byModel, 'Model');
  addCounts('Tools', tools.byName, 'Tool');
  if (list(tools.mcp).length) section('MCP servers', table(['Server', 'Calls', 'Errors', 'Error rate'],
    tools.mcp.map(row => [row.server, number(row.count), number(row.errors), percent(row.errorRate ?? (row.errors / row.count))])));
  if (list(commands.shell).length) section('Shell commands', table(['Tool', 'Command head', 'Count'],
    commands.shell.slice(0, 25).map(row => [row.tool || 'Bash', row.head, number(row.count)])));
  if (list(errors.top).length) section('Tool errors', table(['Normalized error', 'Count'],
    errors.top.slice(0, 15).map(row => [row.message, number(row.count)])));
  if (list(errors.permissionDenials?.commands).length) section('Denied commands', table(['Tool', 'Command head', 'Count'],
    errors.permissionDenials.commands.map(row => [row.tool || 'Bash', row.head, number(row.count)])));

  section('Context', table(['Metric', 'Count'], [['/clear', number(context.clear)], ['/compact', number(context.compact)],
    ['Resume prompts immediately after reset', number(context.resumedAfterReset)],
    ['Long sessions without /compact (≥60 min or ≥50 prompts)', number(context.longSessionsWithoutCompact)]]));
  section('Activity by local hour', table(['Hour', 'Prompts'],
    Array.from({ length: 24 }, (_, hour) => [String(hour).padStart(2, '0'), number(stats.hours?.[hour])])));

  section('Suggestions', list(suggestions).length
    ? table(['Priority', 'Rule', 'Evidence', 'Concrete change'], suggestions.map((row, index) => [index + 1, row.id, row.evidence, row.change]))
    : 'No suggestion thresholds reached.');
  return sections.join('\n\n') + '\n';
}

module.exports = { suggest, renderMarkdown };
