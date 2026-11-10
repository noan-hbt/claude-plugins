// Statusline: modèle | dossier | branche git | contexte % | coût session | quotas | cache | taux de cache
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Minutes left on the prompt cache: last main-chain response + its TTL (1 h or 5 min).
function cacheMinutesLeft(file) {
  if (!file) return null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    let last = null, ttl = null;
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"usage"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'assistant' || e.isSidechain || !e.message?.usage) continue;
      last ??= Date.parse(e.timestamp);
      const cc = e.message.usage.cache_creation || {};
      if (cc.ephemeral_1h_input_tokens > 0) ttl = 60;
      else if (cc.ephemeral_5m_input_tokens > 0) ttl = 5;
      if (ttl) break;
    }
    if (!Number.isFinite(last) || !ttl) return null;
    return Math.max(0, Math.ceil(ttl - (Date.now() - last) / 60000));
  } catch {
    return null;
  }
}

// Session cache hit rate: read tokens over all input tokens of main-chain responses.
function cacheHitRate(file) {
  if (!file) return null;
  try {
    const seen = new Set();
    let read = 0, total = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const u = e.message?.usage;
      if (e.type !== 'assistant' || e.isSidechain || !u) continue;
      // One response spans several lines carrying the same usage.
      if (e.message.id) {
        if (seen.has(e.message.id)) continue;
        seen.add(e.message.id);
      }
      const r = u.cache_read_input_tokens || 0;
      read += r;
      total += r + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    return total > 0 ? (100 * read) / total : null;
  } catch {
    return null;
  }
}

// Quota points used since this session started: sum of rises seen in used_percentage.
// Counts anything else consuming the same quota meanwhile (other sessions, claude.ai).
function sessionQuotaSpent(id, rl, cost) {
  if (!id) return {};
  const file = path.join(os.tmpdir(), 'claude-statusline', `${id}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const spent = {};
  for (const key of ['five_hour', 'seven_day']) {
    const used = rl[key]?.used_percentage;
    if (!Number.isFinite(used)) continue;
    const resets = rl[key].resets_at;
    const prev = state[key];
    if (!prev) {
      state[key] = { used, resets, spent: 0 };
    } else {
      // A new window restarts from 0, so everything used in it counts.
      const renewed = Number.isFinite(resets) && Number.isFinite(prev.resets) && resets - prev.resets > 60;
      prev.spent += renewed ? used : Math.max(0, used - prev.used);
      prev.used = used;
      prev.resets = resets;
    }
    spent[key] = state[key].spent;
  }
  // Read by ticket-usage.js to diff a ticket's cost.
  if (Number.isFinite(cost)) state.cost = cost;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {}
  return spent;
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch {}

  const model = j.model?.display_name || '?';
  const dir = j.workspace?.current_dir || j.cwd || '';
  const parts = [`\x1b[36m${model}\x1b[0m`, path.basename(dir)];

  try {
    const br = execSync('git branch --show-current', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (br) parts.push(`\x1b[35m${br}\x1b[0m`);
  } catch {}

  const cw = j.context_window || {};
  const pct = cw.used_percentage ?? (cw.current_usage && cw.context_window_size
    ? Math.round(100 * ((cw.current_usage.input_tokens || 0) + (cw.current_usage.cache_read_input_tokens || 0) + (cw.current_usage.cache_creation_input_tokens || 0)) / cw.context_window_size)
    : null);
  if (pct != null) {
    const c = pct >= 80 ? 31 : pct >= 50 ? 33 : 32;
    parts.push(`\x1b[${c}mctx ${Math.round(pct)}%\x1b[0m`);
  }

  const cost = j.cost?.total_cost_usd;
  if (cost != null) parts.push(`$${cost.toFixed(2)}`);

  const rl = j.rate_limits || {};
  const spent = sessionQuotaSpent(j.session_id, rl, j.cost?.total_cost_usd);
  const win = (label, key) => {
    const p = rl[key]?.used_percentage;
    if (!Number.isFinite(p)) return null;
    const c = p >= 80 ? 31 : p >= 50 ? 33 : 32;
    const s = spent[key];
    const own = s == null ? '' : ` (+${s < 10 ? s.toFixed(1) : Math.round(s)})`;
    return `\x1b[${c}m${label} ${Math.round(p)}%${own}\x1b[0m`;
  };
  const quotas = [win('5h', 'five_hour'), win('7d', 'seven_day')].filter(Boolean);
  if (quotas.length) parts.push(quotas.join(' · '));

  const cache = cacheMinutesLeft(j.transcript_path);
  if (cache != null) {
    const c = cache <= 2 ? 31 : cache <= 10 ? 33 : 32;
    parts.push(`\x1b[${c}m${cache > 0 ? `cache ${cache} min` : 'cache expiré'}\x1b[0m`);
  }

  const hit = cacheHitRate(j.transcript_path);
  if (hit != null) {
    const c = hit >= 80 ? 32 : hit >= 50 ? 33 : 31;
    parts.push(`\x1b[${c}mhit ${Math.round(hit)}%\x1b[0m`);
  }

  process.stdout.write(parts.join(' │ '));
});
