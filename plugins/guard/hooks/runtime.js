'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DEFAULT_CONFIG, RULES } = require('./lib');

const CACHE_MS = 60_000;
const MAX_LOG_BYTES = 1024 * 1024;

function configDir() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

function git(cwd, args) {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 500,
      maxBuffer: 1024 * 1024,
    });
    return !result.error && result.status === 0 ? result.stdout.trimEnd() : null;
  } catch {
    return null;
  }
}

function createDeps() {
  const home = os.homedir();
  const tmpdir = os.tmpdir();
  const memory = new Map();
  return {
    configDir: configDir(), home, tmpdir,
    gitInfo(cwd) {
      if (typeof cwd !== 'string' || !cwd) return null;
      const absolute = path.resolve(cwd);
      const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      const now = Date.now();
      const fresh = entry => entry && entry.cwd === key &&
        Number.isFinite(entry.ts) && now >= entry.ts && now - entry.ts < CACHE_MS;
      if (fresh(memory.get(key))) return memory.get(key).info;
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      const cacheFile = path.join(tmpdir, `claude-guard-git-${hash}.json`);
      try {
        const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (fresh(entry) && (entry.info === null ||
            (entry.info && ['root', 'gitDir', 'commonDir'].every(field =>
              typeof entry.info[field] === 'string' && path.isAbsolute(entry.info[field]))))) {
          memory.set(key, entry);
          return entry.info;
        }
      } catch { /* Missing or invalid caches are disposable. */ }
      const output = git(absolute, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
      const lines = output === null ? [] : output.split(/\r?\n/);
      const info = lines.length === 3 ? {
        root: path.resolve(absolute, lines[0]),
        gitDir: path.resolve(absolute, lines[1]),
        commonDir: path.resolve(absolute, lines[2]),
      } : null;
      const entry = { cwd: key, ts: now, info };
      memory.set(key, entry);
      const temporary = `${cacheFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, cacheFile);
      } catch {
        try { fs.unlinkSync(temporary); } catch { /* Cache is optional. */ }
      }
      return info;
    },
    branch(cwd) { return git(cwd, ['branch', '--show-current']); },
    status(cwd) { return git(cwd, ['status', '--porcelain']); },
  };
}

function validConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const config = {};
  if (Array.isArray(value.disable)) {
    config.disable = value.disable.filter(item => typeof item === 'string' && RULES.includes(item));
  }
  if (Array.isArray(value.protectedBranches)) {
    config.protectedBranches = value.protectedBranches.filter(item => typeof item === 'string' && item);
  }
  if (Array.isArray(value.extraSafe)) {
    config.extraSafe = value.extraSafe.filter(item => {
      if (typeof item !== 'string') return false;
      try { new RegExp(item); return true; } catch { return false; }
    });
  }
  return config;
}

function readConfig(file) {
  try { return validConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return {}; }
}

function loadConfig(cwd, deps) {
  const directory = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const info = deps.gitInfo(directory);
  const projectRoot = info && info.root || directory;
  return {
    ...DEFAULT_CONFIG,
    disable: [...DEFAULT_CONFIG.disable],
    extraSafe: [...DEFAULT_CONFIG.extraSafe],
    protectedBranches: [...DEFAULT_CONFIG.protectedBranches],
    ...readConfig(path.join(deps.configDir, 'guard.json')),
    ...readConfig(path.join(projectRoot, '.claude', 'guard.json')),
  };
}

function logDecision(input, result, deps) {
  if (!result || !['deny', 'ask'].includes(result.decision)) return;
  const toolInput = input.tool_input || {};
  const summary = String(toolInput.command || toolInput.file_path || '').slice(0, 120);
  const directory = path.join(deps.configDir, 'guard');
  const file = path.join(directory, 'log.jsonl');
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      ts: new Date().toISOString(), rule: result.rule, decision: result.decision,
      tool: input.tool_name, summary, cwd: input.cwd,
    })}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      const buffer = fs.readFileSync(file);
      const start = buffer.indexOf(10, Math.floor(buffer.length / 2));
      fs.writeFileSync(file, start === -1 ? '' : buffer.subarray(start + 1));
    }
  } catch { /* Logging must never suppress the safety decision. */ }
}

module.exports = { createDeps, loadConfig, logDecision, configDir };
