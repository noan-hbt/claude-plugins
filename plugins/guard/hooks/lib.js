'use strict';

const os = require('node:os');
const path = require('node:path');

const RULES = ['worktree-fence', 'force-push', 'no-verify', 'destructive', 'secrets-staging', 'secrets-content', 'safe-allow'];
const DEFAULT_CONFIG = { disable: [], extraSafe: [], protectedBranches: ['main', 'master', 'develop'] };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function windowsPath(value) {
  return /^[a-z]:|^\\\\/i.test(value);
}

function resolvePath(value, cwd, deps) {
  const home = deps.home || os.homedir();
  let expanded = String(value).replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$(?:HOME\b|\{HOME\}|env:(?:USERPROFILE|HOME)\b)/i, () => home)
    .replace(/^%(?:USERPROFILE|HOME)%/i, () => home);
  const api = windowsPath(expanded) || windowsPath(cwd) ? path.win32 : path.posix;
  if (api === path.posix) expanded = expanded.replace(/\\/g, '/');
  return api.resolve(cwd || process.cwd(), expanded);
}

function inside(file, directory) {
  const api = windowsPath(file) || windowsPath(directory) ? path.win32 : path.posix;
  const relative = api.relative(api === path.win32 ? directory.toLowerCase() : directory,
    api === path.win32 ? file.toLowerCase() : file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

// A small lexer: operators split commands only outside quotes. Preserve Windows
// backslashes; consume shell escapes only when they escape shell punctuation.
function commands(source) {
  const segments = [];
  let tokens = [], token = '', started = false, quote = '', valid = true;
  const endToken = () => { if (started) tokens.push(token); token = ''; started = false; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && ['"', '\\', '$', '`'].includes(next)) token += source[++i];
      else token += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && next === '\n') { i++; continue; }
    if (c === '\\' && next && /[\s;&|'"<>]/.test(next)) { token += source[++i]; started = true; continue; }
    if (c === '#' && !started) {
      while (i < source.length && source[i] !== '\n') i++;
      endSegment();
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && next === '&')) {
      endSegment();
      if ((c === '|' || c === '&') && next === c) i++;
      if ((c === '|' || c === '&') && !source.slice(i + 1).trim()) valid = false;
      continue;
    }
    if ((c === '&' && source[i - 1] !== '>') || c === '(' || c === ')') valid = false;
    if (/\s/.test(c)) endToken();
    else { token += c; started = true; }
  }
  endSegment();
  return { segments, valid: valid && !quote };
}

function normalize(tokens) {
  const result = tokens.slice();
  while (/^(?:[A-Za-z_]\w*|\$env:\w+)=/.test(result[0] || '')) result.shift();
  if (/^rtk(?:\.exe)?$/i.test(result[0] || '')) result.shift();
  while (/^(?:[A-Za-z_]\w*|\$env:\w+)=/.test(result[0] || '')) result.shift();
  return result;
}

function gitCommand(tokens, cwd, deps) {
  tokens = normalize(tokens);
  if (tokens[0] === '&') tokens = tokens.slice(1);
  if (!/^git(?:\.exe)?$/i.test(tokens[0] || '')) return null;
  let index = 1, safeGlobals = true;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index++];
    if (option === '-C') {
      if (!tokens[index]) return null;
      cwd = resolvePath(tokens[index++], cwd, deps);
    } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(option)) {
      index++;
      safeGlobals = false;
    } else if (!['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'].includes(option)) {
      safeGlobals = false;
    }
  }
  const args = tokens.slice(index + 1);
  const redirect = args.findIndex(value => /^(?:[012]?>|<)/.test(value));
  return { verb: (tokens[index] || '').toLowerCase(), args: redirect < 0 ? args : args.slice(0, redirect), cwd, safeGlobals };
}

function secretName(value) {
  const name = value.split(/[\\/]/).pop().toLowerCase();
  if (name === '.env.example' || name === '.env.sample') return false;
  return name === '.env' || name.startsWith('.env.') || /\.(pem|key)$/.test(name) || name.startsWith('id_rsa') || name === 'credentials.json';
}

function statusSecret(status) {
  if (typeof status !== 'string') return null;
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4 || line.startsWith('!!') || line[1] === 'D' || line.slice(0, 2).trim() === 'D') continue;
    let filename = line.slice(3);
    if (/^[RC ]/.test(line[0]) && filename.includes(' -> ')) filename = filename.slice(filename.lastIndexOf(' -> ') + 4);
    if (filename.startsWith('"')) {
      try { filename = JSON.parse(filename); } catch { filename = filename.slice(1, -1); }
    }
    if (secretName(filename)) return filename;
  }
  return null;
}

function likelySecret(content) {
  if (/(?:AKIA[0-9A-Z]{16}|(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[bp]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) return true;
  const assignment = /\b[A-Za-z_][\w.-]*(?:SECRET|TOKEN|PASSWORD|API_KEY)\b["']?\s*[:=]\s*(?:"([^"\r\n]{24,})"|'([^'\r\n]{24,})')/gi;
  // Bare SECRET/TOKEN names also occur in dotenv and JSON configuration.
  const bare = /\b(?:SECRET|TOKEN|PASSWORD|API_KEY)\b["']?\s*[:=]\s*(?:"([^"\r\n]{24,})"|'([^'\r\n]{24,})')/gi;
  for (const pattern of [assignment, bare]) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1] || match[2];
      if (/\s/.test(value) || /^(?:your[_-]|example|changeme|placeholder|dummy|test[_-])/i.test(value)) continue;
      const counts = new Map();
      for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) { const probability = count / value.length; entropy -= probability * Math.log2(probability); }
      if (counts.size >= 10 && entropy >= 3.5) return true;
    }
  }
  return false;
}

function protectedRef(ref, branches, current) {
  let target = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  target = target.replace(/^\+/, '').replace(/^refs\/heads\//, '');
  if (target === 'HEAD' || target === '@') target = current() || '';
  if (branches.includes(target)) return true;
  if (!target.includes('*')) return false;
  const pattern = new RegExp(`^${target.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return branches.some(branch => pattern.test(branch));
}

function forcePush(git, branches, deps) {
  if (git.verb !== 'push') return null;
  let forced = false, remoteOption = false, all = false, endOptions = false;
  const positional = [];
  for (let i = 0; i < git.args.length; i++) {
    const arg = git.args[i];
    if (arg === '--') { endOptions = true; continue; }
    if (!endOptions && arg.startsWith('-')) {
      if (/^--force(?:-with-lease(?:=.*)?)?$/.test(arg) || /^-[^-]*f/.test(arg)) forced = true;
      if (arg === '--no-force') forced = false;
      if (arg === '--all' || arg === '--mirror') all = true;
      if (arg === '--repo') { remoteOption = true; i++; }
      else if (arg.startsWith('--repo=')) remoteOption = true;
      else if (['--receive-pack', '--exec', '-o', '--push-option'].includes(arg)) i++;
      continue;
    }
    positional.push(arg);
  }
  const refs = remoteOption ? positional : positional.slice(1);
  if (refs.some(ref => ref.startsWith('+'))) forced = true;
  if (!forced) return null;
  let branch;
  const current = () => branch === undefined ? (branch = deps.branch?.(git.cwd) || null) : branch;
  if ((all && branches.length) || refs.some(ref => protectedRef(ref, branches, current)) || (!refs.length && branches.includes(current()))) {
    return 'Force push targets a protected branch. Push a feature branch without rewriting protected history.';
  }
  return null;
}

function criticalPath(target, cwd, deps) {
  target = target.replace(/[\\/]\*+$/, '') || '/';
  const resolved = resolvePath(target, cwd, deps);
  const home = resolvePath(deps.home || os.homedir(), cwd, deps);
  const configDirs = [deps.configDir || path.join(deps.home || os.homedir(), '.claude'), `${deps.home || os.homedir()}/.claude`, `${deps.home || os.homedir()}/.claude-2`];
  const api = windowsPath(resolved) ? path.win32 : path.posix;
  return resolved === api.parse(resolved).root || /^[a-z]:\\users\\[^\\]+$/i.test(resolved)
    || inside(home, resolved) || configDirs.some(directory => inside(resolvePath(directory, cwd, deps), resolved));
}

function destructive(tokens, git, cwd, deps) {
  if (git) {
    const { verb, args } = git;
    if ((verb === 'reset' && args.includes('--hard'))
      || (verb === 'clean' && args.some(arg => arg === '--force' || /^-[^-]*f/.test(arg)))
      || (verb === 'checkout' && args.includes('--') && args.slice(args.indexOf('--') + 1).some(arg => /^\.[\\/]?$/.test(arg)))
      || (verb === 'restore' && args.some(arg => /^\.[\\/]?$/.test(arg)))
      || (verb === 'branch' && (args.some(arg => /^-[^-]*D/.test(arg)) || (args.includes('--delete') && args.includes('--force'))))) {
      return { decision: 'ask', reason: `Confirm destructive git ${verb} before discarding data or deleting branches.` };
    }
  }
  tokens = normalize(tokens);
  if (tokens[0] === '&') tokens.shift();
  const executable = (tokens[0] || '').toLowerCase().replace(/\.exe$/, '');
  if (!['rm', 'remove-item'].includes(executable)) return null;
  const args = tokens.slice(1);
  const powershell = executable === 'remove-item' || args.some(arg => /^-(?:recurse|force)(?::|$)/i.test(arg));
  let recursive = false, force = false, endOptions = false;
  const targets = [];
  for (const arg of args) {
    if (arg === '--') { endOptions = true; continue; }
    if (!endOptions && arg.startsWith('-')) {
      if (powershell) {
        if (/^-recurse(?::\$?true)?$/i.test(arg)) recursive = true;
        if (/^-force(?::\$?true)?$/i.test(arg)) force = true;
      } else {
        if (arg === '--recursive' || /^-[^-]*[rR]/.test(arg)) recursive = true;
        if (arg === '--force' || /^-[^-]*f/.test(arg)) force = true;
      }
    } else targets.push(...(powershell ? arg.split(',') : [arg]));
  }
  if (!recursive || (!powershell && !force)) return null;
  const critical = targets.find(target => criticalPath(target, cwd, deps));
  if (critical) return { decision: 'deny', reason: `Refusing recursive deletion of protected root ${critical}.` };
  if (force) return { decision: 'ask', reason: 'Confirm recursive forced deletion before removing files.' };
  return null;
}

function safeRedirection(source) {
  const remaining = source.replace(/\b2\s*>\s*&\s*1(?=\s|$|[;|&])/g, '')
    .replace(/(?:[12])?>\s*(?:\/dev\/null|\$null)(?=\s|$|[;|&])/gi, '');
  return !/[<>]/.test(remaining);
}

function safeSegment(tokens, cwd, deps, extraSafe) {
  tokens = normalize(tokens);
  if (!tokens.length) return false;
  const name = tokens[0].toLowerCase().replace(/\.exe$/, '');
  const args = tokens.slice(1);
  const lower = args.map(arg => arg.toLowerCase());
  const git = gitCommand(tokens, cwd, deps);
  if (git?.safeGlobals) {
    const values = git.args;
    if (values.some(arg => /^--(?:output|ext-diff)(?:=|$)/.test(arg))) return false;
    if (['status', 'diff', 'log', 'show', 'rev-parse', 'fetch', 'ls-files', 'blame'].includes(git.verb)) return true;
    if (git.verb === 'branch') {
      return !values.some(arg => /^-[^-]*[dDmMcCf]/.test(arg) || /^--(?:delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(arg))
        && (values.includes('--list') || values.every(arg => arg.startsWith('-')));
    }
    if (git.verb === 'remote' && values.length === 1 && ['-v', '--verbose'].includes(values[0])) return true;
    if (git.verb === 'stash' && values[0] === 'list') return true;
    if (git.verb === 'worktree' && values[0] === 'list') return true;
  }
  if (name === 'gh' && ((lower[0] === 'pr' && ['view', 'list', 'checks', 'status', 'diff'].includes(lower[1]))
    || (lower[0] === 'issue' && ['view', 'list'].includes(lower[1]))
    || (lower[0] === 'run' && ['view', 'list'].includes(lower[1])) || (lower[0] === 'repo' && lower[1] === 'view'))) return true;
  if (['ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'where', 'echo', 'type',
    'get-childitem', 'get-content', 'test-path', 'select-string', 'get-location'].includes(name)) return true;
  if (name === 'find' && !lower.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))) return true;
  if ((['node', 'python'].includes(name) && lower[0] === '--version') || (name === 'node' && lower[0] === '--test')
    || (name === 'npm' && (['ls', 'test'].includes(lower[0]) || (lower[0] === 'run' && ['test', 'lint', 'typecheck', 'build'].includes(lower[1]))))
    || (name === 'pip' && lower[0] === 'list') || name === 'pytest' || (name === 'python' && lower[0] === '-m' && lower[1] === 'pytest')
    || (name === 'cargo' && ['check', 'test', 'build'].includes(lower[0])) || (name === 'go' && ['test', 'build', 'vet'].includes(lower[0]))
    || (name === 'tsc' && args[0] === '--noEmit') || (name === 'ruff' && lower[0] === 'check') || name === 'eslint') return true;
  const normalized = tokens.join(' ');
  return extraSafe.some(pattern => { try { return new RegExp(pattern).test(normalized); } catch { return false; } });
}

function decide(input, config = {}, deps = {}) {
  const disabled = new Set(Array.isArray(config.disable) ? config.disable : []);
  const active = rule => !disabled.has(rule);
  const cwd = input.cwd || process.cwd();
  const tool = input.tool_name;
  const data = input.tool_input || {};
  const result = (decision, rule, reason) => ({ decision, reason, rule });
  const target = data.file_path || data.notebook_path;
  if (EDIT_TOOLS.has(tool)) {
    if (target && active('worktree-fence')) {
      const file = resolvePath(target, cwd, deps);
      const home = deps.home || os.homedir();
      const exceptions = [deps.configDir || `${home}/.claude`, `${home}/.claude`, `${home}/.claude-2`, deps.tmpdir || os.tmpdir()];
      if (!/scratchpad/i.test(file) && !exceptions.some(directory => inside(file, resolvePath(directory, cwd, deps)))) {
        const info = deps.gitInfo?.(cwd);
        if (info?.root && info.gitDir && info.commonDir) {
          const gitDir = resolvePath(info.gitDir, cwd, deps), commonDir = resolvePath(info.commonDir, cwd, deps);
          if (!inside(gitDir, commonDir) || !inside(commonDir, gitDir)) {
            const root = resolvePath(info.root, cwd, deps);
            if (!inside(file, root)) return result('deny', 'worktree-fence', `File resolves outside this worktree. Use the correct worktree root: ${root}.`);
          }
        }
      }
    }
    if (active('secrets-content') && ['Write', 'Edit', 'MultiEdit'].includes(tool)
      && !/(?:^|[\\/])tests[\\/]fixtures(?:[\\/]|$)/i.test(target || '') && !/\.(?:example|sample)$/i.test(target || '')) {
      const contents = [data.content, data.new_string, ...(Array.isArray(data.edits) ? data.edits.map(edit => edit.new_string) : [])];
      if (contents.some(content => typeof content === 'string' && likelySecret(content))) return result('deny', 'secrets-content', 'Written content contains a likely secret. Store credentials outside source files and reference environment variables.');
    }
    return null;
  }
  if (!SHELL_TOOLS.has(tool) || typeof data.command !== 'string' || !data.command.trim()) return null;
  const source = data.command;
  const parsed = commands(source);
  let ask = null;
  for (const tokens of parsed.segments) {
    const git = gitCommand(tokens, cwd, deps);
    if (git && active('force-push')) {
      const reason = forcePush(git, Array.isArray(config.protectedBranches) ? config.protectedBranches : DEFAULT_CONFIG.protectedBranches, deps);
      if (reason) return result('deny', 'force-push', reason);
    }
    if (git && active('no-verify') && ((git.verb === 'commit' && git.args.some(arg => arg === '--no-verify' || /^-[^-]*n/.test(arg)))
      || (git.verb === 'push' && git.args.includes('--no-verify')))) return result('deny', 'no-verify', 'Keep git verification hooks enabled; remove --no-verify/-n.');
    if (active('destructive')) {
      const action = destructive(tokens, git, cwd, deps);
      if (action?.decision === 'deny') return result('deny', 'destructive', action.reason);
      if (action) ask ||= result('ask', 'destructive', action.reason);
    }
    if (git?.verb === 'add' && active('secrets-staging')) {
      const args = git.args.filter(arg => !arg.startsWith('-'));
      const named = args.find(secretName);
      const bulk = args.some(arg => /^\.[\\/]?$/.test(arg)) || git.args.some(arg => arg === '--all' || /^-[^-]*A/.test(arg));
      const secret = named || (bulk && statusSecret(deps.status?.(git.cwd)));
      if (secret) return result('deny', 'secrets-staging', `Refusing to stage likely credential file ${secret}. Use an example file and keep credentials untracked.`);
    }
  }
  if (ask) return ask;
  if (active('safe-allow') && parsed.valid && parsed.segments.length && safeRedirection(source)
    && !/\$\s*\(|`|\b(?:eval|iex|Invoke-Expression)\b|-(?:EncodedCommand|e|en|enc)\b/i.test(source)
    && parsed.segments.every(tokens => safeSegment(tokens, cwd, deps, Array.isArray(config.extraSafe) ? config.extraSafe : []))) {
    return result('allow', 'safe-allow', 'Every command segment matches the configured safe list.');
  }
  return null;
}

module.exports = { decide, RULES, DEFAULT_CONFIG };
