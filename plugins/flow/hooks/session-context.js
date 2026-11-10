#!/usr/bin/env node
// SessionStart: tell Claude where it is (repo, branch, worktree, pending handoff)
// so the user no longer has to type "tu travailles dans <path> (worktree)".
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

let cwd = process.cwd();
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (input.cwd) cwd = input.cwd;
} catch {}

const top = git(["rev-parse", "--show-toplevel"], cwd);
if (!top) process.exit(0);

const branch = git(["branch", "--show-current"], cwd) || "(detached HEAD)";
const gitDir = path.resolve(cwd, git(["rev-parse", "--git-dir"], cwd));
const commonDir = path.resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd));
const isWorktree = gitDir !== commonDir;
const dirty = git(["status", "--porcelain"], cwd).split("\n").filter(Boolean).length;

const lines = [`Repo: ${top} · branch ${branch} · ${dirty} uncommitted file(s)`];
if (isWorktree) {
  const mainRepo = path.dirname(commonDir);
  lines.push(
    `This session runs in a git WORKTREE. Main checkout: ${mainRepo}. ` +
      `Read and edit files only under ${top}; do not cd into or edit the main checkout.`
  );
}
const handoff = path.join(top, ".claude", "handoff.md");
if (fs.existsSync(handoff)) {
  lines.push(`A handoff file exists: ${handoff}. If the user asks to resume/continue, use the resume skill.`);
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } })
);
