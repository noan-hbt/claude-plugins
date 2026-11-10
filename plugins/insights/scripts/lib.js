'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { suggest, renderMarkdown } = require('./report');

function parseLine(line) {
  try {
    const value = JSON.parse(line.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizePrompt(text) {
  return String(text).toLowerCase()
    .replace(/"(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])[^"\r\n]+"|'(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])[^'\r\n]+'|(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])[^\s<>"']+|(?:[\w.@-]+[\\/])+[\w.@-]+/gi, ' <path> ')
    .replace(/\d+(?:[.,]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ').trim();
}

const SETUP_HEADS = /^(cd|pushd|popd|export|set|set-location|sl|source|\.|\$env:\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)$/i;

function segmentHead(segment) {
  const tokens = String(segment || '').trim().match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) || [];
  const executable = (token) => token.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (tokens.length && executable(tokens[0]).toLowerCase() === 'rtk') {
    tokens.shift();
    if (tokens[0] === 'proxy') tokens.shift();
  }
  if (tokens.length) tokens[0] = executable(tokens[0]);
  return tokens.slice(0, 2).join(' ').toLowerCase();
}

// Head of the first meaningful segment: skips cd/export/env setup before ; && || |.
function commandHead(command) {
  const segments = String(command || '').split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter((x) => x.trim());
  for (const seg of segments) {
    const head = segmentHead(seg);
    if (head && !SETUP_HEADS.test(head.split(' ')[0])) return head;
  }
  return segments.length ? segmentHead(segments[0]) : '';
}

function projectName(slug, cwd) {
  if (typeof cwd === 'string' && cwd.trim()) {
    const segments = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    if (segments.at(-1)) return segments.at(-1);
  }
  // Claude's slug encoding loses directory boundaries; cwd preserves hyphenated names.
  return String(slug).split(/[\\/]/).pop().split(/-+/).filter(Boolean).pop() || String(slug);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

function defaultConfigDirs() {
  const dirs = [path.join(os.homedir(), '.claude')];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.unshift(process.env.CLAUDE_CONFIG_DIR);
  const second = path.join(os.homedir(), '.claude-2');
  if (fs.existsSync(second)) dirs.push(second);
  return dirs;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textContent).filter(Boolean).join('\n');
  return content && typeof content.text === 'string' ? content.text : '';
}

const frenchWords = new Set(('je tu il elle nous vous ils elles le la les un une des du de au aux et ou mais donc pas ne pour avec sans sur dans en est sont ce cette ces qui que quoi mon ma mes ton ta tes son sa ses faire fais peut peux aussi tout tous plus rien bien comment pourquoi besoin faudrait ajoute ajouter modifie corrige donne lance faut maintenant voici comme marche toujours').split(' '));
const frenchMarker = /\b(?:non|oui|merci|bonjour|salut|français|française|déjà|très|être|arrête|reprends|stp|svp|vsy)\b|(?:^|\s)(?:ça|où|vas-y|c bon)(?:\s|[.!?]|$)/iu;
const frictionPattern = /(?:^|[^\p{L}\p{N}_])(?:non|pas\s+[çc]a|arr[eê]te|stop|refais|toujours\s+pas|[çc]a\s+marche\s+pas|wrong)(?=$|[^\p{L}\p{N}_])/iu;
const approvalPattern = /^(?:ok|vsy|vas[- ]y|go|continue|c bon|oui|yes)[.!?…]*$/i;
const denialPattern = /Permission for this action was denied|requires approval|classifier/i;

function isFrench(text) {
  if (frenchMarker.test(text)) return true;
  const words = new Set(text.toLowerCase().match(/[\p{L}]+/gu) || []);
  return [...words].filter((word) => frenchWords.has(word)).length >= 2;
}

function increment(map, key, count = 1) {
  if (key) map.set(key, (map.get(key) || 0) + count);
}

function ranked(map, field = 'name', limit = Infinity) {
  return [...map].map(([key, count]) => ({ [field]: key, count }))
    .sort((a, b) => b.count - a.count || String(a[field]).localeCompare(String(b[field])))
    .slice(0, limit);
}

function accumulator() {
  return {
    promptCount: 0, lengths: [], french: 0, approvals: 0, friction: 0,
    repeated: new Map(), examples: new Map(), slash: new Map(), skills: new Map(),
    agentTypes: new Map(), agentModels: new Map(), shell: new Map(), tools: new Map(),
    mcp: new Map(), errors: new Map(), errorCount: 0, denials: new Map(), denialCount: 0,
    interrupts: 0, clear: 0, compact: 0, resumes: 0, hours: Array(24).fill(0),
    tokens: { input: 0, output: 0, cacheRead: 0 },
  };
}

function shellKey(tool, head) { return `${tool}\0${head}`; }
function shellRows(map, limit = Infinity) {
  return [...map].map(([key, count]) => {
    const [tool, head] = key.split('\0');
    return { tool, head, count };
  }).sort((a, b) => b.count - a.count || a.head.localeCompare(b.head) || a.tool.localeCompare(b.tool)).slice(0, limit);
}

async function transcriptFiles(configDirs, sources) {
  const files = [];
  const seenFiles = new Set();
  const seenDirs = new Set();
  const canonical = (filename) => {
    const real = fs.realpathSync(filename);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  async function walk(directory, slug) {
    let entries;
    try {
      const real = canonical(directory);
      if (seenDirs.has(real)) return;
      seenDirs.add(real);
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') sources.unreadableDirectories++;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      try {
        const stat = entry.isSymbolicLink() ? await fs.promises.stat(filename) : entry;
        if (stat.isDirectory()) {
          await walk(filename, slug || entry.name);
        } else if (stat.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
          const real = canonical(filename);
          if (seenFiles.has(real)) continue;
          seenFiles.add(real);
          files.push({ filename, slug: slug || entry.name, subagent: filename.split(/[\\/]/).some((part) => part.toLowerCase() === 'subagents') });
        }
      } catch {
        sources.unreadableFiles++;
      }
    }
  }
  for (const directory of configDirs) await walk(path.join(directory, 'projects'), '');
  return files;
}

async function readTranscript(file, from, to, project, sources) {
  const data = accumulator();
  const toolUses = new Map();
  const seenTools = new Set();
  const seenResults = new Set();
  const seenRows = new Set();
  const usage = new Map();
  let pendingReset = false;
  let cwd;
  let first = null;
  let last = null;
  let matched = !project || file.slug.toLowerCase().includes(project);
  const stream = fs.createReadStream(file.filename, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  // Forward stream errors to the async iterator, including failures before its first read.
  stream.on('error', (error) => lines.emit('error', error));
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = parseLine(line);
      if (!record) { sources.badLines++; continue; }
      if (record.uuid && seenRows.has(record.uuid)) continue;
      if (record.uuid) seenRows.add(record.uuid);
      if (typeof record.cwd === 'string' && record.cwd) {
        cwd ||= record.cwd;
        if (project && record.cwd.toLowerCase().includes(project)) matched = true;
      }
      const date = new Date(record.timestamp);
      const time = date.getTime();
      const inPeriod = Number.isFinite(time) && time >= from && time <= to;
      if (inPeriod && ['user', 'assistant', 'system'].includes(record.type)) {
        const iso = date.toISOString();
        if (!first || iso < first) first = iso;
        if (!last || iso > last) last = iso;
      }
      const message = record.message || {};
      const content = message.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && record.type === 'assistant') {
          const name = typeof block.name === 'string' ? block.name : 'unknown';
          const input = block.input && typeof block.input === 'object' ? block.input : {};
          const head = /^(Bash|PowerShell)$/i.test(name) ? commandHead(input.command) : '';
          const server = /^mcp__(.+?)__/.exec(name)?.[1];
          if (block.id) toolUses.set(block.id, { name, head, server });
          if (!inPeriod || (block.id && seenTools.has(block.id))) continue;
          if (block.id) seenTools.add(block.id);
          increment(data.tools, name);
          if (head) increment(data.shell, shellKey(name, head));
          if (server) {
            if (!data.mcp.has(server)) data.mcp.set(server, { count: 0, errors: 0 });
            data.mcp.get(server).count++;
          }
          if (name === 'Skill' && typeof input.skill === 'string') increment(data.skills, input.skill);
          if (name === 'Agent') {
            increment(data.agentTypes, typeof input.subagent_type === 'string' ? input.subagent_type : 'unspecified');
            increment(data.agentModels, typeof input.model === 'string' ? input.model : 'default');
          }
        }
        if (block.type === 'tool_result' && inPeriod) {
          if (block.tool_use_id && seenResults.has(block.tool_use_id)) continue;
          if (block.tool_use_id) seenResults.add(block.tool_use_id);
          const text = textContent(block.content);
          const denied = denialPattern.test(text);
          if (!denied && block.is_error !== true) continue;
          const tool = toolUses.get(block.tool_use_id);
          if (denied) {
            data.denialCount++;
            if (tool?.head) increment(data.denials, shellKey(tool.name, tool.head));
          } else {
            data.errorCount++;
            increment(data.errors, normalizePrompt(text || '(empty tool error)').slice(0, 80));
          }
          if (tool?.server) {
            if (!data.mcp.has(tool.server)) data.mcp.set(tool.server, { count: 0, errors: 0 });
            data.mcp.get(tool.server).errors++;
          }
        }
      }
      if (record.type === 'assistant' && inPeriod && message.usage) {
        const current = {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens,
        };
        const key = message.id || Symbol();
        const previous = usage.get(key) || { input: 0, output: 0, cacheRead: 0 };
        for (const field of Object.keys(previous)) {
          if (Number.isFinite(current[field]) && current[field] >= 0) previous[field] = Math.max(previous[field], current[field]);
        }
        usage.set(key, previous);
      }
      if (record.type !== 'user' || blocks.some((block) => block?.type === 'tool_result')) continue;
      const text = textContent(content).trim();
      if (!text || file.subagent || record.isSidechain) continue;
      if (text.includes('[Request interrupted')) {
        if (inPeriod) data.interrupts++;
        continue;
      }
      const commands = [...text.matchAll(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/gi)].map((match) => match[1]);
      const bareCommand = /^\/([a-z][\w:-]*)(?:\s|$)/i.exec(text);
      if (!commands.length && bareCommand) commands.push(bareCommand[1]);
      for (const name of commands) {
        if (inPeriod) increment(data.slash, `/${name}`);
        if (name.toLowerCase() === 'clear' || name.toLowerCase() === 'compact') {
          pendingReset = true;
          if (inPeriod) data[name.toLowerCase()]++;
        }
      }
      if (commands.length || /^(?:<command-|<local-command|<system-reminder>|Caveat:|\[Image)/i.test(text)) continue;
      if (inPeriod) {
        data.promptCount++;
        data.lengths.push(text.length);
        data.hours[date.getHours()]++;
        if (isFrench(text)) data.french++;
        if (approvalPattern.test(text.toLowerCase())) data.approvals++;
        increment(data.repeated, normalizePrompt(text));
        if (frictionPattern.test(text)) {
          data.friction++;
          increment(data.examples, text.replace(/\s+/g, ' ').slice(0, 100));
        }
        if (pendingReset && /^(?:reprends|continue|resume)\b/i.test(text)) data.resumes++;
      }
      pendingReset = false;
    }
  } catch {
    sources.unreadableFiles++;
  } finally {
    lines.close();
    stream.destroy();
  }
  for (const value of usage.values()) for (const key of Object.keys(data.tokens)) data.tokens[key] += value[key];
  return { data, first, last, matched, name: projectName(file.slug, cwd) };
}

async function analyze({ days = 30, project, configDirs = defaultConfigDirs(), now = new Date() } = {}) {
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  if (!Array.isArray(configDirs) || configDirs.some((dir) => typeof dir !== 'string' || !dir.trim())) throw new Error('configDirs must contain directory paths');
  const to = new Date(now).getTime();
  const from = to - days * 86400000;
  if (!Number.isFinite(to) || !Number.isFinite(from) || !Number.isFinite(new Date(from).getTime())) throw new Error('Invalid analysis period');
  const dirs = [...new Set(configDirs.map((dir) => path.resolve(dir)))];
  const sources = { configDirs: dirs, files: 0, badLines: 0, unreadableFiles: 0, unreadableDirectories: 0 };
  const files = await transcriptFiles(dirs, sources);
  sources.files = files.length;
  const total = accumulator();
  const projects = new Map();
  let sessions = 0;
  let subagents = 0;
  let longSessionsWithoutCompact = 0;
  const mapFields = ['repeated', 'examples', 'slash', 'skills', 'agentTypes', 'agentModels', 'shell', 'tools', 'errors', 'denials'];
  const countFields = ['promptCount', 'french', 'approvals', 'friction', 'errorCount', 'denialCount', 'interrupts', 'clear', 'compact', 'resumes'];
  for (const file of files) {
    const result = await readTranscript(file, from, to, project?.toLowerCase(), sources);
    if (!result.matched || !result.first) continue;
    const data = result.data;
    if (file.subagent) subagents++; else sessions++;
    if (!file.subagent && data.compact === 0 && (Date.parse(result.last) - Date.parse(result.first) >= 3600000 || data.promptCount >= 50)) longSessionsWithoutCompact++;
    for (const field of countFields) total[field] += data[field];
    total.lengths.push(...data.lengths);
    for (const field of mapFields) for (const [key, value] of data[field]) increment(total[field], key, value);
    for (let hour = 0; hour < 24; hour++) total.hours[hour] += data.hours[hour];
    for (const [server, value] of data.mcp) {
      if (!total.mcp.has(server)) total.mcp.set(server, { count: 0, errors: 0 });
      total.mcp.get(server).count += value.count;
      total.mcp.get(server).errors += value.errors;
    }
    if (!projects.has(file.slug)) projects.set(file.slug, { name: result.name, slug: file.slug, sessions: 0, subagents: 0, first: result.first, last: result.last, tokens: { input: 0, output: 0, cacheRead: 0 } });
    const item = projects.get(file.slug);
    if (item.name === projectName(file.slug) && result.name !== item.name) item.name = result.name;
    item[file.subagent ? 'subagents' : 'sessions']++;
    if (result.first < item.first) item.first = result.first;
    if (result.last > item.last) item.last = result.last;
    for (const key of Object.keys(item.tokens)) item.tokens[key] += data.tokens[key];
  }
  return {
    period: { days, from: new Date(from).toISOString(), to: new Date(to).toISOString(), project: project || null },
    sources,
    sessions: { total: sessions, subagents, projects: [...projects.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)) },
    prompts: {
      count: total.promptCount,
      length: { median: percentile(total.lengths, 0.5), p90: percentile(total.lengths, 0.9) },
      french: { count: total.french, share: total.promptCount ? total.french / total.promptCount : 0 },
      repeated: ranked(total.repeated, 'prompt').filter((row) => row.count >= 2).slice(0, 15),
      shortApprovals: { count: total.approvals, share: total.promptCount ? total.approvals / total.promptCount : 0 },
      friction: { count: total.friction, examples: ranked(total.examples, 'prompt', 15) },
    },
    commands: {
      slash: ranked(total.slash), skills: ranked(total.skills),
      agents: { byType: ranked(total.agentTypes), byModel: ranked(total.agentModels) },
      shell: shellRows(total.shell, 25),
    },
    tools: {
      total: [...total.tools.values()].reduce((sum, count) => sum + count, 0),
      byName: ranked(total.tools),
      mcp: [...total.mcp].map(([server, value]) => ({ server, ...value, errorRate: value.count ? value.errors / value.count : 0 })).sort((a, b) => b.count - a.count || a.server.localeCompare(b.server)),
    },
    errors: { total: total.errorCount, top: ranked(total.errors, 'message', 15), permissionDenials: { count: total.denialCount, commands: shellRows(total.denials) }, interrupts: total.interrupts },
    context: { clear: total.clear, compact: total.compact, resumedAfterReset: total.resumes, longSessionsWithoutCompact },
    hours: total.hours,
  };
}

module.exports = { analyze, parseLine, normalizePrompt, commandHead, projectName, percentile, defaultConfigDirs, suggest, renderMarkdown };
