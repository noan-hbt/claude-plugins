'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const SKIP = new Set(['.venv', 'venv', 'node_modules', '.git', 'dist', 'build']);
const JS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']);
const windowsPath = value => /^[a-z]:[\\/]|^\\\\/i.test(value);
const paths = value => windowsPath(value) ? path.win32 : path;
const key = value => process.platform === 'win32' || windowsPath(value) ? value.toLowerCase() : value;

function normalizeState(state = {}) {
  return {
    files: Array.isArray(state.files) ? state.files.filter(file => typeof file === 'string') : [],
    blocks: Number.isInteger(state.blocks) && state.blocks >= 0 ? state.blocks : 0,
    lastRun: state.lastRun ?? null
  };
}

function trackFile(state, filePath, cwd) {
  const next = normalizeState(state);
  if (typeof filePath !== 'string' || !filePath || /[\0\r\n]/.test(filePath)) return next;
  const api = paths(cwd || filePath);
  const absolute = api.resolve(cwd || process.cwd(), filePath);
  if (!next.files.some(file => key(api.normalize(file)) === key(absolute))) next.files.push(absolute);
  return next;
}

function statePath(sessionId, tmpDir = os.tmpdir()) {
  if (typeof sessionId !== 'string' || !/^[a-z0-9_-]+$/i.test(sessionId)) return null;
  return path.join(tmpDir, 'claude-qa', `${sessionId}.json`);
}

function readState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeState();
    throw error;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(normalizeState(state)), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function getRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, windowsHide: true
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function readConfig(root) {
  const file = path.join(root, '.claude', 'qa.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid qa config');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function filterFiles(root, files, ignore = []) {
  const api = paths(root);
  const ignored = Array.isArray(ignore) ? ignore.filter(value => typeof value === 'string') : [];
  const result = [];
  for (const file of files) {
    if (typeof file !== 'string' || /[\0\r\n]/.test(file)) continue;
    const absolute = api.resolve(root, file);
    const relative = api.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) continue;
    if (ignored.some(part => key(absolute).includes(key(part)))) continue;
    if (!result.some(existing => key(existing) === key(absolute))) result.push(absolute);
  }
  return result;
}

// PowerShell on Windows and /bin/sh on POSIX both support literal single-quoted paths.
function quote(file, platform = process.platform) {
  return platform === 'win32' ? `'${file.replace(/'/g, "''")}'` : `'${file.replace(/'/g, "'\\''")}'`;
}

function relatedPython(root, files) {
  const python = files.filter(file => path.extname(file).toLowerCase() === '.py');
  const names = new Set(python.flatMap(file => {
    const stem = path.basename(file, path.extname(file));
    return [key(`test_${stem}.py`), key(`${stem}_test.py`)];
  }));
  const related = new Set(python.filter(file => /^(test_.+|.+_test)\.py$/i.test(path.basename(file))));
  function walk(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 6 && !SKIP.has(entry.name.toLowerCase())) walk(file, depth + 1);
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.py') continue;
      if (names.has(key(entry.name))) related.add(file);
    }
  }
  if (python.length) walk(root, 0);
  return [...related];
}

function detect(root, files, config = {}) {
  files = filterFiles(root, files, config.ignore);
  const plan = { root, files, stacks: [], commands: [] };
  if (!files.length) return plan;
  const extensions = new Set(files.map(file => path.extname(file).toLowerCase()));
  const exists = name => fs.existsSync(path.join(root, name));
  const python = extensions.has('.py') && ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py', 'tests'].some(exists);
  if (typeof config.command === 'string' && config.command.trim()) {
    const related = python && config.command.includes('{files}') ? relatedPython(root, files) : [];
    plan.stacks.push('custom');
    plan.commands.push(config.command.replace(/\{files\}/g, () => (related.length ? related : files).map(file => quote(file)).join(' ')));
    return plan;
  }
  if (python) {
    const related = relatedPython(root, files);
    plan.stacks.push('python');
    if (related.length) plan.commands.push(`python -m pytest -q -x --no-header -p no:cacheprovider ${related.map(file => quote(file)).join(' ')}`);
    else if (config.mode === 'full') plan.commands.push('python -m pytest -q -x');
  }
  if ([...extensions].some(extension => JS.has(extension)) && exists('package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const touched = files.filter(file => JS.has(path.extname(file).toLowerCase())).map(file => quote(file)).join(' ');
    plan.stacks.push('javascript');
    if (typeof scripts.test === 'string' && scripts.test.trim() && !/no test specified/i.test(scripts.test)) {
      if (config.mode !== 'full' && Object.hasOwn(deps, 'vitest')) plan.commands.push(`npx vitest related --run ${touched}`);
      else if (config.mode !== 'full' && Object.hasOwn(deps, 'jest')) plan.commands.push(`npx jest --findRelatedTests ${touched} --passWithNoTests`);
      else plan.commands.push('npm test --silent');
    }
    if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) plan.commands.push('npm run -s typecheck');
  }
  if (extensions.has('.rs') && exists('Cargo.toml')) {
    plan.stacks.push('rust');
    plan.commands.push('cargo check -q');
  }
  if (extensions.has('.go') && exists('go.mod')) {
    plan.stacks.push('go');
    plan.commands.push('go build ./...', 'go vet ./...');
  }
  return plan;
}

function run(command, { cwd, timeoutMs }) {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : command, windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : [], {
      cwd, shell: !windows,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let timedOut = false;
    const capture = chunk => { output = (output + chunk.toString()).slice(-1024 * 1024); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); }
        catch { child.kill(); }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: 1, output: output + error.message, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut });
    });
  });
}

async function gate({ cwd, state, env = process.env }, deps = {}) {
  state = normalizeState(state);
  if (env.CLAUDE_QA === 'off') return { state };
  if (state.blocks >= 3) return { state: { ...state, blocks: 0 }, output: { systemMessage: 'qa: tests still failing after 3 attempts, stopping' } };
  if (!state.files.length) return { state };
  const root = await (deps.getRoot || getRoot)(cwd);
  const config = await (deps.readConfig || readConfig)(root);
  if (config.enabled === false) return { state };
  state.files = filterFiles(root, state.files, config.ignore);
  if (!state.files.length) return { state };
  const plan = await (deps.detect || detect)(root, state.files, config);
  if (!plan.commands.length) return { state };
  const timeoutMs = typeof config.timeoutSec === 'number' && Number.isFinite(config.timeoutSec) && config.timeoutSec > 0 ? config.timeoutSec * 1000 : 180000;
  for (const command of plan.commands) {
    const result = await (deps.run || run)(command, { cwd: root, timeoutMs });
    state.lastRun = (deps.now || (() => new Date().toISOString()))();
    if (result.code !== 0 || result.timedOut) {
      state.blocks++;
      const timeout = result.timedOut ? ` Timed out after ${timeoutMs / 1000}s; adjust timeoutSec in .claude/qa.json.` : '';
      const tail = String(result.output || '').trimEnd().split(/\r?\n/).slice(-80).join('\n');
      return {
        state,
        output: { decision: 'block', reason: `qa: \`${command}\` failed after your edits (attempt ${state.blocks}/3). Fix the cause (not the test, unless the test is wrong), then finish.${timeout}\n\n${tail}` }
      };
    }
  }
  return { state: { ...state, files: [], blocks: 0 }, output: { systemMessage: `qa: ok - ${plan.commands.join(' ; ')}` } };
}

module.exports = { normalizeState, trackFile, statePath, readState, writeState, getRoot, readConfig, filterFiles, quote, relatedPython, detect, run, gate };
