#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {mergeSettings, upsertManagedBlock, parseToolCheck} = require('./lib');

const log = (mark, message) => console.log(`${mark} ${message}`);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function options(argv) {
  const result = {dirs: [], dryRun: false, skipTools: false, installTools: false, skipPlugins: false};
  const flags = {'--dry-run': 'dryRun', '--skip-tools': 'skipTools', '--install-tools': 'installTools', '--skip-plugins': 'skipPlugins'};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config-dir') {
      const dir = argv[++i];
      if (!dir || dir.startsWith('--')) throw new Error('--config-dir needs a directory');
      result.dirs.push(path.resolve(dir));
    } else if (flags[argv[i]]) result[flags[argv[i]]] = true;
    else if (argv[i] === '--help' || argv[i] === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (result.skipTools && result.installTools) throw new Error('Choose --skip-tools or --install-tools');
  if (!result.dirs.length) {
    if (process.env.CLAUDE_CONFIG_DIR) result.dirs.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
    result.dirs.push(path.join(os.homedir(), '.claude'));
    const second = path.join(os.homedir(), '.claude-2');
    if (fs.existsSync(second)) result.dirs.push(second);
  }
  const seen = new Set();
  result.dirs = result.dirs.filter(dir => {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result;
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!isObject(value)) throw new Error('expected a JSON object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${error.message}`);
  }
}

function run(command, env = process.env, timeout = 10000) {
  return spawnSync(command, {shell: true, encoding: 'utf8', timeout, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024});
}

function output(result) {
  return [result.stdout, result.stderr, result.error && result.error.message].filter(Boolean).join('\n').trim();
}

function installCommand(tool) {
  const id = tool.npm || tool.winget;
  if (!id || !/^[\w@./+-]+$/.test(id)) throw new Error(`Invalid package for tool ${tool.name}`);
  return tool.npm ? `npm install -g ${id}`
    : `winget install --id ${id} --exact --accept-source-agreements --accept-package-agreements`;
}

function checkTools(profile, opts) {
  const available = new Set();
  let failures = 0;
  if (opts.skipTools) {
    log('•', 'Tool checks skipped; optional tool hooks will not be added');
    return {available, failures};
  }
  for (const tool of profile.tools) {
    parseToolCheck(tool.check);
    if (run(tool.check).status === 0) {
      available.add(tool.name);
      log('✓', `${tool.name}: present`);
      continue;
    }
    const command = installCommand(tool);
    log('•', `${tool.name}: missing${tool.optional ? ' (optional)' : ''}; ${command}`);
    if (!opts.installTools || tool.optional) continue;
    if (opts.dryRun) {
      log('•', `[dry-run] run ${command}`);
      continue;
    }
    if (tool.winget && process.platform !== 'win32') {
      log('•', `${tool.name}: winget is Windows-only; install with your platform package manager, then re-run`);
      continue;
    }
    const installed = run(command, process.env, 300000);
    if (installed.status !== 0) {
      log('✗', `${tool.name}: installation failed: ${output(installed)}`);
      failures++;
    } else if (run(tool.check).status === 0) {
      available.add(tool.name);
      log('✓', `${tool.name}: installed`);
    } else log('•', `${tool.name}: installer finished; open a new terminal to refresh PATH, then re-run`);
  }
  return {available, failures};
}

function planDirectory(dir, profile, tools) {
  const plans = [];
  const settings = {};
  const ctx = {configDir: dir, platform: process.platform, tools};
  for (const [name, desired] of [['settings.json', profile.settings], ['settings.local.json', profile.localSettings]]) {
    const file = path.join(dir, name);
    const template = JSON.parse(JSON.stringify(desired));
    // The declarative command remains readable; quote its complete file argument when paths contain spaces.
    if (/\s/.test(dir)) {
      const quote = value => {
        if (Array.isArray(value)) value.forEach(quote);
        else if (isObject(value)) {
          for (const [key, item] of Object.entries(value)) {
            if (key === 'command' && typeof item === 'string') {
              value[key] = item.replace(/^node (\{\{CONFIG_DIR\}\}\/\S+)$/, 'node "$1"');
            } else quote(item);
          }
        }
      };
      quote(template);
    }
    const merged = mergeSettings(readJson(file, {}), template, ctx);
    settings[name] = merged.result;
    plans.push({file, content: Buffer.from(`${JSON.stringify(merged.result, null, 2)}\n`)});
  }
  for (const [name, strategy] of Object.entries(profile.home)) {
    if (name !== path.basename(name) || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error(`Invalid home file: ${name}`);
    const file = path.join(dir, name);
    if (strategy === 'copy-if-absent' && fs.existsSync(file)) continue;
    let content = fs.readFileSync(path.join(__dirname, 'home', name));
    if (strategy === 'managed-block') {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      // A CLAUDE.md that @imports another config dir's CLAUDE.md already gets the block from there.
      const importsOther = text.split(/\r?\n/).some(line => {
        const m = line.trim().match(/^@(.+CLAUDE\.md)$/i);
        return m && path.resolve(m[1].trim()).toLowerCase() !== path.resolve(file).toLowerCase() && fs.existsSync(m[1].trim());
      });
      if (importsOther && !text.includes('<!-- megaclaude:begin -->')) continue;
      content =Buffer.from(upsertManagedBlock(text, content.toString('utf8')));
    } else if (!['copy', 'copy-if-absent'].includes(strategy)) throw new Error(`Unknown home strategy: ${strategy}`);
    plans.push({file, content});
  }
  return {dir, settings, plans};
}

function timestamp() {
  const date = new Date();
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupFile(file) {
  const base = `${file}.bak-${timestamp()}`;
  for (let index = 0; ; index++) {
    const target = base + (index ? `-${index}` : '');
    try {
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function syncDirectory(state, opts) {
  state.changed = 0;
  for (const {file, content} of state.plans) {
    const exists = fs.existsSync(file);
    if (exists && fs.readFileSync(file).equals(content)) continue;
    state.changed++;
    if (opts.dryRun) {
      log('•', `[dry-run] ${exists ? 'back up and update' : 'create'} ${file}`);
      continue;
    }
    fs.mkdirSync(path.dirname(file), {recursive: true});
    if (exists) log('✓', `Backed up ${backupFile(file)}`);
    const temporary = `${file}.megaclaude-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporary, content, {flag: 'wx', mode: exists ? fs.statSync(file).mode : 0o600});
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    log('✓', `${exists ? 'Updated' : 'Created'} ${file}`);
  }
}

function marketplaceName(dir, marketplace) {
  const known = readJson(path.join(dir, 'plugins', 'known_marketplaces.json'), {});
  return Object.keys(known).find(name => known[name].source && known[name].source.repo === marketplace)
    || marketplace.split('/')[0];
}

function syncPlugins(dir, profile, opts) {
  if (opts.skipPlugins) {
    log('•', `${dir}: plugin sync skipped`);
    return 0;
  }
  const env = {...process.env, CLAUDE_CONFIG_DIR: dir};
  const ready = !opts.dryRun && run('claude --version', env).status === 0;
  if (!opts.dryRun && !ready) log('•', `${dir}: claude missing; run these commands after installing Claude Code (set CLAUDE_CONFIG_DIR to ${dir})`);
  let failures = 0;
  function invoke(command) {
    if (!ready) {
      log('•', `${opts.dryRun ? '[dry-run] ' : ''}CLAUDE_CONFIG_DIR=${JSON.stringify(dir)}: ${command}`);
      return '';
    }
    const result = run(command, env, 300000);
    const details = output(result);
    const already = /already/i.test(details);
    if (result.status === 0 || already) log('✓', `${dir}: ${command}${already ? ' (already present)' : ''}`);
    else {
      log('✗', `${dir}: ${command}: ${details || `exit ${result.status}`}`);
      failures++;
    }
    return details;
  }
  for (const marketplace of profile.marketplaces) {
    if (!/^[\w./-]+$/.test(marketplace)) throw new Error(`Invalid marketplace: ${marketplace}`);
    const details = invoke(`claude plugin marketplace add ${marketplace}`);
    const name = marketplaceName(dir, marketplace);
    if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid marketplace name: ${name}`);
    if (/already/i.test(details)) invoke(`claude plugin marketplace update ${name}`);
    else if (!ready) log('•', `If already added: claude plugin marketplace update ${name}`);
  }
  for (const plugin of profile.plugins) {
    if (!/^[\w@.-]+$/.test(plugin)) throw new Error(`Invalid plugin: ${plugin}`);
    invoke(`claude plugin install ${plugin}`);
  }
  return failures;
}

function flatten(value, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isObject(item) && Object.keys(item).length) flatten(item, name, result);
    else Object.defineProperty(result, name, {value: item, enumerable: true, configurable: true});
  }
  return result;
}

function doctor(states) {
  log('•', 'Doctor (report only)');
  let warnings = 0;
  function warn(message) { warnings++; log('•', `Doctor: ${message}`); }
  for (const state of states) {
    const {dir} = state;
    const settings = state.settings['settings.json'];
    const enabled = Object.keys(settings.enabledPlugins || {}).filter(key => settings.enabledPlugins[key]);
    const hooks = Object.values(settings.hooks || {}).flatMap(groups => Array.isArray(groups) ? groups : [])
      .flatMap(group => Array.isArray(group.hooks) ? group.hooks : []).filter(hook => typeof hook.command === 'string');
    if (hooks.some(hook => /caveman-on\.js/i.test(hook.command)) && enabled.some(key => /^caveman(?:@|$)/i.test(key))) {
      warn(`${dir}: caveman activated twice (caveman-on.js hook and enabled caveman plugin)`);
    }
    try {
      const installed = readJson(path.join(dir, 'plugins', 'installed_plugins.json'), {});
      const entries = installed.plugins || installed;
      for (const key of enabled) {
        if (!Object.prototype.hasOwnProperty.call(entries, key) || (Array.isArray(entries[key]) && !entries[key].length)) {
          warn(`${dir}: enabledPlugins entry not installed: ${key}`);
        }
      }
    } catch (error) { warn(error.message); }
    for (const hook of hooks) {
      try {
        const parsed = parseToolCheck(hook.command);
        const candidates = [...(/[\\/]/.test(parsed.command) ? [parsed.command] : []), ...parsed.args.filter(arg => /\.(?:[cm]?js|py|ps1|sh|bash)$/i.test(arg))];
        for (let candidate of candidates) {
          candidate = candidate.replace(/^~(?=[\\/])/, os.homedir());
          if (/\$|%|\{\{/.test(candidate)) continue;
          const file = path.isAbsolute(candidate) ? candidate : path.resolve(dir, candidate);
          const planned = state.plans.some(plan => path.normalize(plan.file) === path.normalize(file));
          if (!fs.existsSync(file) && !planned) warn(`${dir}: hook points to missing file: ${candidate}`);
        }
      } catch (error) { warn(`${dir}: cannot inspect hook: ${error.message}`); }
    }
    function scan(folder) {
      let entries;
      try { entries = fs.readdirSync(folder, {withFileTypes: true}); }
      catch (error) { if (error.code !== 'ENOENT') warn(`${folder}: ${error.message}`); return; }
      for (const entry of entries) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (entry.isFile() && entry.name.includes('.bak')) {
          try {
            if (Date.now() - fs.statSync(file).mtimeMs > 30 * 86400000) warn(`${dir}: backup older than 30 days: ${file}`);
          } catch (error) { warn(`${file}: ${error.message}`); }
        }
      }
    }
    scan(dir);
  }
  if (states.length > 1) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const flat = states.map(state => flatten(state.settings[name]));
      const keys = new Set(flat.flatMap(value => Object.keys(value)));
      for (const key of keys) {
        if (new Set(flat.map(value => JSON.stringify(value[key]))).size > 1) {
          warn(`${name}: ${key} differs between config dirs (${states.map(state => state.dir).join(', ')})`);
        }
      }
    }
  }
  if (!warnings) log('✓', 'Doctor: no issues found');
  return warnings;
}

function main(argv) {
  const opts = options(argv);
  if (opts.help) {
    log('•', 'Usage: node install.js [--dry-run] [--config-dir <dir>]... [--skip-tools | --install-tools] [--skip-plugins]');
    return 0;
  }
  const profile = readJson(path.join(__dirname, 'profile.json'));
  if (!profile || !Array.isArray(profile.tools) || !Array.isArray(profile.marketplaces) || !Array.isArray(profile.plugins)
      || !isObject(profile.settings) || !isObject(profile.localSettings) || !isObject(profile.home)) throw new Error('Invalid profile.json');
  const tools = checkTools(profile, opts);
  let failures = tools.failures;
  const states = [];
  for (const dir of opts.dirs) {
    try {
      const state = planDirectory(dir, profile, tools.available);
      syncDirectory(state, opts);
      failures += syncPlugins(dir, profile, opts);
      // Plugin installation can change enabledPlugins; doctor should inspect the final settings.
      if (!opts.dryRun && !opts.skipPlugins) {
        state.settings['settings.json'] = readJson(path.join(dir, 'settings.json'), state.settings['settings.json']);
      }
      states.push(state);
    } catch (error) {
      log('✗', `${dir}: ${error.message}`);
      failures++;
      log('✗', `${dir}: summary: sync failed`);
    }
  }
  doctor(states);
  for (const state of states) log('✓', `${state.dir}: summary: ${state.changed ? `${state.changed} file(s) ${opts.dryRun ? 'would change' : 'changed'}` : 'no changes'}`);
  return failures ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { log('✗', error.message); process.exitCode = 1; }
}

module.exports = {main};
