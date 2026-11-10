// Pure-ish logic for the flow hooks. Every exported function is safe to call with bad input.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_INJECT = 6000; // chars of handoff injected into a fresh session

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

function repoInfo(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) return null;
  const gitDir = path.resolve(cwd, git(["rev-parse", "--git-dir"], cwd));
  const commonDir = path.resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd));
  return {
    top: path.resolve(top),
    branch: git(["branch", "--show-current"], cwd) || "(detached HEAD)",
    gitDir,
    commonDir,
    isWorktree: gitDir.toLowerCase() !== commonDir.toLowerCase(),
    status: git(["status", "--short"], cwd),
    lastCommit: git(["log", "-1", "--format=%h %s"], cwd),
  };
}

function handoffDir(cwd) {
  const info = repoInfo(cwd);
  return { info, dir: path.join(info ? info.top : cwd, ".claude") };
}

// Keep handoff files out of git without touching the user's .gitignore.
function excludeFromGit(info) {
  if (!info) return;
  try {
    const excl = path.join(info.commonDir, "info", "exclude");
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, "utf8") : "";
    if (!/^\.claude\/handoff\*\.md$/m.test(cur)) {
      fs.mkdirSync(path.dirname(excl), { recursive: true });
      fs.appendFileSync(excl, (cur && !cur.endsWith("\n") ? "\n" : "") + ".claude/handoff*.md\n");
    }
  } catch {}
}

function isTypedPrompt(text) {
  const t = text.trim();
  return t && !/^(<command-|<local-command|<system-reminder>|Caveat:|\[Request interrupted)/.test(t);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((p) => p && p.type === "tool_result")) return "";
  return content.filter((p) => p && p.type === "text").map((p) => p.text).join("\n");
}

// Read the main-chain transcript and extract what a successor session needs.
function digestTranscript(file) {
  const out = { prompts: [], files: new Set(), lastAssistant: "", tasks: null };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain || !o.message) continue;
    const c = o.message.content;
    if (o.type === "user") {
      const t = textOf(c);
      if (isTypedPrompt(t)) out.prompts.push(t.trim());
    } else if (o.type === "assistant" && Array.isArray(c)) {
      for (const p of c) {
        if (p.type === "text" && p.text.trim()) out.lastAssistant = p.text.trim();
        if (p.type === "tool_use" && p.input) {
          if (p.input.file_path && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(p.name)) out.files.add(p.input.file_path);
          if (p.name === "TodoWrite" && Array.isArray(p.input.todos)) out.tasks = p.input.todos;
        }
      }
    }
  }
  return out;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);

function renderAuto(d, info, cwd, reason) {
  const L = [`# Auto handoff — ${new Date().toISOString().slice(0, 16).replace("T", " ")} (${reason})`];
  L.push(info ? `Repo: ${info.top} · branch ${info.branch}${info.isWorktree ? " · WORKTREE" : ""} · last commit ${info.lastCommit}` : `Dir: ${cwd}`);
  if (d.prompts.length) {
    L.push("", "## User asked (oldest → newest, last 8)");
    for (const p of d.prompts.slice(-8)) L.push(`- ${clip(p.replace(/\s+/g, " "), 300)}`);
  }
  if (d.tasks && d.tasks.length) {
    L.push("", "## Task list");
    for (const t of d.tasks) L.push(`- [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`);
  }
  if (d.files.size) {
    L.push("", "## Files edited");
    for (const f of [...d.files].slice(-30)) L.push(`- ${f}`);
  }
  if (info && info.status) L.push("", "## Uncommitted", "```", clip(info.status, 1500), "```");
  if (d.lastAssistant) L.push("", "## Claude's last message", clip(d.lastAssistant, 1500));
  return L.join("\n") + "\n";
}

function writeAutoHandoff(input) {
  const cwd = input.cwd || process.cwd();
  if (!input.transcript_path) return null;
  const d = digestTranscript(input.transcript_path);
  if (!d.prompts.length && !d.files.size) return null;
  const { info, dir } = handoffDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "handoff.auto.md");
  fs.writeFileSync(file, renderAuto(d, info, cwd, input.reason || input.trigger || input.hook_event_name));
  excludeFromGit(info);
  return file;
}

function readIf(file) {
  try {
    return { text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

function sessionContext(input) {
  const cwd = input.cwd || process.cwd();
  const source = input.source || "startup";
  const { info, dir } = handoffDir(cwd);
  const lines = [];
  if (info) {
    const dirty = info.status ? info.status.split("\n").length : 0;
    lines.push(`Repo: ${info.top} · branch ${info.branch} · ${dirty} uncommitted file(s) · last commit ${info.lastCommit}`);
    if (info.isWorktree) {
      lines.push(
        `This session runs in a git WORKTREE. Main checkout: ${path.dirname(info.commonDir)}. ` +
          `Read and edit files only under ${info.top}; never cd into or edit the main checkout.`
      );
    }
  }
  const manual = readIf(path.join(dir, "handoff.md"));
  const auto = readIf(path.join(dir, "handoff.auto.md"));
  const fresh = (h) => h && Date.now() - h.mtime < 12 * 3600 * 1000;

  if (source === "clear" || source === "compact") {
    // Continuity after a reset: inject the freshest handoff so the user doesn't re-explain.
    const pick = [manual, auto].filter(fresh).sort((a, b) => b.mtime - a.mtime)[0];
    if (pick) {
      lines.push(
        "",
        "Context carried over from the previous session (written by the flow plugin). Use it if the user continues the same work; ignore it if they start something new:",
        clip(pick.text, MAX_INJECT)
      );
    }
  } else if (manual || fresh(auto)) {
    lines.push(`A handoff exists in ${dir} (${manual ? "handoff.md" : "handoff.auto.md"}). If the user says reprends/continue/resume, use the resume skill.`);
  }
  return lines.length ? lines.join("\n") : "";
}

const APPROVAL = /^(ok+|okay|vsy|vas[- ]?y|go+|let'?s go|c'?\s?bon|c'est bon|continue|continues|oui|yes|yep|fais[- ]le|fonce|valid[ée]?|parfait|nickel|top)[\s.!]*$/i;

function promptContext(input) {
  const p = (input.prompt || "").trim();
  if (p.length > 40 || !APPROVAL.test(p)) return "";
  return (
    "flow: the user approved with a short go-ahead. Carry the current plan through to completion in this turn " +
    "(including obvious follow-ups like running checks), without asking for confirmation on routine steps. " +
    "Stop only for destructive or irreversible actions, or a real ambiguity."
  );
}

module.exports = { repoInfo, digestTranscript, renderAuto, writeAutoHandoff, sessionContext, promptContext, APPROVAL };
