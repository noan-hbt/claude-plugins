'use strict';

const BEGIN = '<!-- megaclaude:begin -->';
const END = '<!-- megaclaude:end -->';
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => Array.isArray(value) ? value.map(clone)
  : object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;

function substitutePlaceholders(value, ctx = {}) {
  if (typeof value === 'string') {
    const dir = String(ctx.configDir || '').replace(/\\/g, '/');
    return value.replace(/\{\{CONFIG_DIR\}\}/g, () => dir);
  }
  if (Array.isArray(value)) return value.map(item => substitutePlaceholders(item, ctx));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitutePlaceholders(item, ctx)]));
  return value;
}

// Shell-like words for inspection, never execution. Backslashes in Windows paths stay literal.
function parseToolCheck(check) {
  if (typeof check !== 'string' || !check.trim()) throw new Error('Tool check must be a non-empty command');
  const words = [];
  let word = '', quote = '', started = false;
  for (const char of check.trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in tool check');
  if (started) words.push(word);
  return {command: words[0], args: words.slice(1)};
}

function mergeSettings(current, profileSettings, ctx = {}) {
  if (!object(current) || !object(profileSettings)) throw new Error('Settings must be JSON objects');
  const changes = [];
  const profile = substitutePlaceholders(profileSettings, ctx);
  const available = name => ctx.tools instanceof Set ? ctx.tools.has(name)
    : Array.isArray(ctx.tools) ? ctx.tools.includes(name) : Boolean(ctx.tools && own(ctx.tools, name) && ctx.tools[name]);
  const normalize = command => {
    const value = command.trim().replace(/\\/g, '/');
    return ctx.platform === 'win32' ? value.toLowerCase() : value;
  };
  const commands = group => (group.hooks || []).filter(hook => typeof hook.command === 'string').map(hook => normalize(hook.command));

  function merge(base, incoming, prefix = '', force = false) {
    let result = clone(base);
    for (const [key, value] of Object.entries(incoming)) {
      const location = prefix ? `${prefix}.${key}` : key;
      const present = own(result, key);
      const previous = result[key];
      const forced = force || (!prefix && ['statusLine', 'model', 'modelSettings'].includes(key));
      let next = previous;
      if (prefix === 'hooks' && Array.isArray(value)) {
        if (present && !Array.isArray(previous)) continue;
        next = clone(previous || []);
        const seen = new Set(next.flatMap(commands));
        for (const group of value) {
          if (group.requires && !available(group.requires)) continue;
          const {requires, ...clean} = group;
          clean.hooks = (clean.hooks || []).filter(hook => !hook.requires || available(hook.requires)).map(hook => {
            const {requires, ...rest} = hook;
            return rest;
          });
          if (!clean.hooks.length || commands(clean).some(command => seen.has(command))) continue;
          next.push(clean);
          commands(clean).forEach(command => seen.add(command));
        }
        if (!present && !next.length) continue;
      } else if (prefix === 'permissions' && ['allow', 'deny', 'ask'].includes(key) && Array.isArray(value)) {
        if (present && !Array.isArray(previous)) continue;
        next = [...new Set([...(previous || []), ...value])];
      } else if (object(value) && (!present || object(previous))) {
        next = merge(present ? previous : {}, value, location, forced);
      } else if (!present || forced) {
        next = clone(value);
      }
      if (!present && next === undefined) continue;
      if (!present || JSON.stringify(previous) !== JSON.stringify(next)) {
        // Computed properties also preserve literal __proto__ keys without changing prototypes.
        result = {...result, [key]: next};
        if (!object(value) || !object(next)) changes.push(location);
      }
    }
    return result;
  }
  return {result: merge(current, profile), changes};
}

function upsertManagedBlock(text, block) {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const content = block.replace(/\s+$/, '');
  const managed = `${BEGIN}\n${content}\n${END}`;
  if (begin !== -1 || end !== -1) {
    if (begin === -1 || end < begin || text.indexOf(BEGIN, begin + BEGIN.length) !== -1 || text.indexOf(END, end + END.length) !== -1) {
      throw new Error('Malformed megaclaude managed block; repair markers before syncing');
    }
    return text.slice(0, begin) + managed + text.slice(end + END.length);
  }
  // First sync of a file that already holds the same text unmarked: wrap it instead of duplicating it.
  const norm = s => s.replace(/\r\n/g, '\n');
  const at = norm(text).indexOf(norm(content));
  if (content && at !== -1) {
    const t = norm(text);
    return t.slice(0, at) + managed + t.slice(at + norm(content).length);
  }
  return text + (text && !text.endsWith('\n') ? '\n\n' : text ? '\n' : '') + managed + '\n';
}

module.exports = {mergeSettings, upsertManagedBlock, substitutePlaceholders, parseToolCheck};
