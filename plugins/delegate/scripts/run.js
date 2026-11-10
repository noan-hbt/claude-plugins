#!/usr/bin/env node
// Run a delegated task through codex, falling back to opencode, and print a compact result:
// which engine ran, its final message (from codex -o), and the git diff --stat.
// Usage: node run.js [--engine codex|opencode|auto] [--timeout 1200] [--cwd DIR] (--prompt-file F | -- "prompt")
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function parseArgs(argv) {
  const a = { engine: "auto", timeout: 1200, cwd: process.cwd(), prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--engine") a.engine = argv[++i];
    else if (k === "--timeout") a.timeout = Number(argv[++i]) || a.timeout;
    else if (k === "--cwd") a.cwd = argv[++i];
    else if (k === "--prompt-file") a.prompt = fs.readFileSync(argv[++i], "utf8");
    else if (k === "--") {
      a.prompt = argv.slice(i + 1).join(" ");
      break;
    }
  }
  return a;
}

const QUOTA = /(rate.?limit|quota|usage limit|insufficient|429|exceeded|not logged in|unauthori[sz]ed|ENOENT|not recognized|command not found)/i;

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { ...opts, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), timedOut: r.error && r.error.code === "ETIMEDOUT", error: r.error };
}

const tail = (s, n) => s.split("\n").slice(-n).join("\n").trim();

function tryCodex(a) {
  const out = path.join(os.tmpdir(), `delegate-codex-${Date.now()}.md`);
  // Prompt via stdin ("-") so quoting and length never break on Windows shells.
  const r = spawnSync("codex", ["exec", "-s", "workspace-write", "-o", out, "-"], {
    cwd: a.cwd, input: a.prompt, encoding: "utf8", timeout: a.timeout * 1000, shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024,
  });
  const log = (r.stdout || "") + (r.stderr || "");
  const msg = fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim() : "";
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  const ok = r.status === 0 && msg && !timedOut;
  return { engine: "codex", ok, msg: msg || tail(log, 30), reason: timedOut ? "timeout" : ok ? "" : QUOTA.test(log) ? "unavailable/quota" : `exit ${r.status}` };
}

function tryOpencode(a) {
  const r = run("opencode", ["run", JSON.stringify(a.prompt)], { cwd: a.cwd, timeout: a.timeout * 1000 });
  const ok = r.code === 0 && !r.timedOut;
  return { engine: "opencode", ok, msg: tail(r.out, 40), reason: r.timedOut ? "timeout" : ok ? "" : QUOTA.test(r.out) ? "unavailable/quota" : `exit ${r.code}` };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.prompt.trim()) {
    console.error("delegate: empty prompt");
    process.exit(2);
  }
  const before = run("git", ["status", "--porcelain"], { cwd: a.cwd }).out;
  const engines = a.engine === "codex" ? [tryCodex] : a.engine === "opencode" ? [tryOpencode] : [tryCodex, tryOpencode];
  const attempts = [];
  let res;
  for (const e of engines) {
    res = e(a);
    attempts.push(`${res.engine}: ${res.ok ? "ok" : res.reason}`);
    if (res.ok) break;
  }
  const stat = run("git", ["diff", "--stat"], { cwd: a.cwd }).out.trim();
  const after = run("git", ["status", "--porcelain"], { cwd: a.cwd }).out;
  const untracked = after.split("\n").filter((l) => l.startsWith("??") && !before.includes(l)).map((l) => l.slice(3));
  console.log(`## delegate — ${res.ok ? "done by " + res.engine : "FAILED"} (${attempts.join(", ")})`);
  console.log("\n### Engine report\n" + (res.msg || "(empty)"));
  console.log("\n### git diff --stat\n" + (stat || "(no tracked changes)"));
  if (untracked.length) console.log("\n### New files\n" + untracked.join("\n"));
  if (!res.ok) console.log("\nAll external engines failed: fall back to a Claude subagent with the same prompt.");
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { parseArgs, QUOTA };
