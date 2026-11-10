const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const lib = require("../hooks/lib");

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
    return dir;
  } catch {
    return null;
  }
}

function transcript(dir) {
  const lines = [
    { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { type: "user", message: { role: "user", content: "ajoute un endpoint /health" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/app.py" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent noise" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Endpoint ajouté, tests à écrire." }] } },
    { type: "user", message: { content: [{ type: "text", text: "vsy écris les tests" }] } },
  ];
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  return f;
}

test("digestTranscript keeps typed prompts, edited files, last assistant text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-t-"));
  const d = lib.digestTranscript(transcript(dir));
  assert.deepStrictEqual(d.prompts, ["ajoute un endpoint /health", "vsy écris les tests"]);
  assert.deepStrictEqual([...d.files], ["src/app.py"]);
  assert.strictEqual(d.lastAssistant, "Endpoint ajouté, tests à écrire.");
});

test("approval detection", () => {
  for (const p of ["ok", "vsy", "Vas-y", "go", "c bon", "continue", "oui !", "fais-le"]) assert.ok(lib.promptContext({ prompt: p }), p);
  for (const p of ["ok mais change le nom", "vsy écris les tests unitaires pour le module auth", "non", ""]) assert.strictEqual(lib.promptContext({ prompt: p }), "", p);
});

test("auto handoff is written on clear and injected on the next session", (t) => {
  const repo = tmpRepo();
  if (!repo) return t.skip("git missing");
  const file = lib.writeAutoHandoff({ cwd: repo, transcript_path: transcript(repo), reason: "clear" });
  assert.ok(file && fs.existsSync(file));
  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /\.claude\/handoff\*\.md/);
  const ctx = lib.sessionContext({ cwd: repo, source: "clear" });
  assert.match(ctx, /ajoute un endpoint/);
  assert.match(ctx, /branch main/);
  const startup = lib.sessionContext({ cwd: repo, source: "startup" });
  assert.doesNotMatch(startup, /ajoute un endpoint/);
  assert.match(startup, /resume skill/);
});

test("worktree is reported", (t) => {
  const repo = tmpRepo();
  if (!repo) return t.skip("git missing");
  const wt = repo + "-wt";
  execFileSync("git", ["worktree", "add", "-q", wt, "-b", "feat"], { cwd: repo });
  const ctx = lib.sessionContext({ cwd: wt, source: "startup" });
  assert.match(ctx, /WORKTREE/);
  assert.match(ctx, /branch feat/);
});

test("outside a repo nothing breaks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-norepo-"));
  assert.strictEqual(lib.sessionContext({ cwd: dir, source: "startup" }), "");
});
