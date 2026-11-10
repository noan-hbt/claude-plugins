'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { decide, RULES, DEFAULT_CONFIG } = require('../hooks/lib');

const baseDeps = {
  gitInfo: () => null,
  branch: () => 'feature',
  status: () => '',
  configDir: '/home/alice/.claude',
  home: '/home/alice',
  tmpdir: '/tmp',
};

function command(command, tool = 'Bash', cwd = '/repo') {
  return { tool_name: tool, tool_input: { command }, cwd };
}

function file(file_path, content, tool = 'Write', cwd = '/repo') {
  const tool_input = { file_path };
  if (tool === 'Edit') tool_input.new_string = content;
  else if (tool === 'MultiEdit') tool_input.edits = [{ new_string: content }];
  else tool_input.content = content;
  return { tool_name: tool, tool_input, cwd };
}

function check(input, expected, config = {}, deps = {}) {
  const result = decide(input, config, { ...baseDeps, ...deps });
  if (expected === null) {
    assert.equal(result, null);
    return;
  }
  assert.ok(result && typeof result === 'object', 'expected a guard decision');
  assert.equal(result.decision, expected[0]);
  assert.equal(result.rule, expected[1]);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.trim(), 'decision must explain the rule');
}

test('exports complete rule IDs and protected-branch defaults', () => {
  assert.deepEqual(new Set(RULES), new Set([
    'worktree-fence', 'force-push', 'no-verify', 'destructive',
    'secrets-staging', 'secrets-content', 'safe-allow',
  ]));
  assert.deepEqual(DEFAULT_CONFIG.protectedBranches, ['main', 'master', 'develop']);
});

const shellCases = [
  ['safe pipeline', 'git log | head', ['allow', 'safe-allow']],
  ['safe conjunction', 'git status && git diff --stat', ['allow', 'safe-allow']],
  ['safe fallback', 'git status || pwd', ['allow', 'safe-allow']],
  ['safe newline', 'pwd\nrg needle src', ['allow', 'safe-allow']],
  ['unsafe tail', 'git status && rm -rf build', ['ask', 'destructive']],
  ['unknown tail', 'git status && custom-command', null],
  ['output redirection', 'echo x > file', null],
  ['append redirection', 'git log >> history.txt', null],
  ['stderr file redirection', 'git status 2> errors.txt', null],
  ['merged stderr', 'git status 2>&1', ['allow', 'safe-allow']],
  ['discard stdout', 'git status >/dev/null', ['allow', 'safe-allow']],
  ['discard stderr', 'git status 2>/dev/null', ['allow', 'safe-allow']],
  ['powershell null stdout', 'Get-ChildItem >$null', ['allow', 'safe-allow']],
  ['powershell null stderr', 'Get-ChildItem 2>$null', ['allow', 'safe-allow']],
  ['subshell', 'echo $(whoami)', null],
  ['backticks', 'echo `whoami`', null],
  ['eval', 'eval echo safe', null],
  ['iex', 'iex "Get-ChildItem"', null],
  ['Invoke-Expression', 'Invoke-Expression "Get-ChildItem"', null],
  ['encoded powershell', 'powershell -EncodedCommand AAAA', null],
  ['rtk prefix', 'rtk git status', ['allow', 'safe-allow']],
  ['environment prefix', 'GIT_PAGER=cat git log -1', ['allow', 'safe-allow']],
  ['multiple environment assignments', 'A=one B="two words" git status', ['allow', 'safe-allow']],
  ['unknown executable', 'deploy-production', null],
  ['safe word executable prefix', 'git status-malicious', null],
  ['find delete', 'find . -delete', null],
  ['find exec', 'find . -exec rm {} \\;', null],
  ['branch delete', 'git branch -d old', null],
  ['branch move', 'git branch -m old new', null],
  ['git fetch', 'git fetch origin', ['allow', 'safe-allow']],
  ['plain git push', 'git push origin feature', null],
  ['plain git add', 'git add src/index.js', null],
];

for (const [name, value, expected] of shellCases) {
  test(`shell: ${name}`, () => check(command(value), expected));
}

const safeCommands = [
  'git status --short', 'git diff HEAD', 'git log -5', 'git show HEAD',
  'git branch --show-current', 'git rev-parse --show-toplevel', 'git remote -v',
  'git stash list', 'git worktree list', 'git ls-files', 'git blame file.js',
  'gh pr view 123', 'gh pr list', 'gh pr checks', 'gh pr status', 'gh pr diff',
  'gh issue view 123', 'gh issue list', 'gh run view', 'gh run list', 'gh repo view',
  'ls -la', 'dir', 'pwd', 'cat README.md', 'head file', 'tail file', 'wc -l file',
  'grep needle file', 'rg needle .', 'find . -name file', 'which node', 'where node',
  'echo hello', 'type README.md', 'Get-ChildItem -Force', 'Get-Content README.md',
  'Test-Path package.json', 'Select-String needle file', 'Get-Location',
  'node --version', 'python --version', 'npm ls', 'pip list', 'pytest -q',
  'python -m pytest tests', 'npm test', 'npm run test', 'npm run lint',
  'npm run typecheck', 'npm run build', 'node --test', 'cargo check',
  'cargo test', 'cargo build', 'go test ./...', 'go build ./...', 'go vet ./...',
  'tsc --noEmit', 'ruff check .', 'eslint src',
];

for (const value of safeCommands) {
  test(`safe list: ${value}`, () => check(command(value), ['allow', 'safe-allow']));
}

test('PowerShell whole-command handling', () => {
  check(command('Get-ChildItem; Get-Content README.md', 'PowerShell'), ['allow', 'safe-allow']);
  check(command('Get-Location; Remove-Item -Recurse -Force build', 'PowerShell'), ['ask', 'destructive']);
  check(command('Get-Content README.md | Select-String guard', 'PowerShell'), ['allow', 'safe-allow']);
});

const forceCases = [
  ['long force main', 'git push --force origin main', {}, ['deny', 'force-push']],
  ['short force master', 'git push -f origin master', {}, ['deny', 'force-push']],
  ['lease develop', 'git push --force-with-lease origin develop', {}, ['deny', 'force-push']],
  ['lease expected ref', 'git push --force-with-lease=refs/heads/main:abc origin main', {}, ['deny', 'force-push']],
  ['forced refspec', 'git push origin +feature:main', {}, ['deny', 'force-push']],
  ['forced full refspec', 'git push origin +HEAD:refs/heads/master', {}, ['deny', 'force-push']],
  ['protected source into feature', 'git push -f origin main:feature', {}, null],
  ['feature into protected', 'git push -f origin feature:develop', {}, ['deny', 'force-push']],
  ['multiple refspecs', 'git push -f origin feature other:main', {}, ['deny', 'force-push']],
  ['feature force', 'git push -f origin feature', {}, null],
  ['feature lease', 'git push --force-with-lease origin feature', {}, null],
  ['feature plus refspec', 'git push origin +feature', {}, null],
  ['current main', 'git push --force', { branch: () => 'main' }, ['deny', 'force-push']],
  ['current master with remote', 'git push -f origin', { branch: () => 'master' }, ['deny', 'force-push']],
  ['current develop with remote', 'git push --force-with-lease origin', { branch: () => 'develop' }, ['deny', 'force-push']],
  ['explicit feature on main', 'git push -f origin feature', { branch: () => 'main' }, null],
  ['unknown current branch', 'git push -f', { branch: () => null }, null],
  ['ordinary main push', 'git push origin main', {}, null],
  ['quoted protected ref', 'git push -f origin "HEAD:main"', {}, ['deny', 'force-push']],
  ['chained force push', 'git status && git push -f origin main', {}, ['deny', 'force-push']],
];

for (const [name, value, deps, expected] of forceCases) {
  test(`force push: ${name}`, () => check(command(value), expected, {}, deps));
}

test('protectedBranches replaces default branch list', () => {
  check(command('git push -f origin release'), ['deny', 'force-push'], { protectedBranches: ['release'] });
  check(command('git push -f origin main'), null, { protectedBranches: ['release'] });
});

const verifyCases = [
  'git commit --no-verify -m "change"',
  'git commit -m "change" --no-verify',
  'git commit -n -m "change"',
  'git push --no-verify origin feature',
  'git status; git commit -n -m "change"',
];
for (const value of verifyCases) {
  test(`no verify: ${value}`, () => check(command(value), ['deny', 'no-verify']));
}

test('no-verify applies to git options, not commit message text', () => {
  check(command('git commit -m "document --no-verify"'), null);
  check(command('git push -n origin feature'), null);
});

const destructiveCases = [
  ['hard reset', 'git reset --hard HEAD~1', ['ask', 'destructive']],
  ['git clean force', 'git clean -fd', ['ask', 'destructive']],
  ['git clean force ignored', 'git clean -ffdx', ['ask', 'destructive']],
  ['checkout all', 'git checkout -- .', ['ask', 'destructive']],
  ['restore all', 'git restore .', ['ask', 'destructive']],
  ['branch delete', 'git branch -D feature', ['ask', 'destructive']],
  ['recursive rm', 'rm -rf build', ['ask', 'destructive']],
  ['split rm options', 'rm -r -f "build output"', ['ask', 'destructive']],
  ['rm root', 'rm -rf /', ['deny', 'destructive']],
  ['rm home', 'rm -rf ~', ['deny', 'destructive']],
  ['rm HOME variable', 'rm -rf $HOME', ['deny', 'destructive']],
  ['rm absolute home', 'rm -rf /home/alice', ['deny', 'destructive']],
  ['rm config', 'rm -rf /home/alice/.claude', ['deny', 'destructive']],
  ['rm quoted config', 'rm -rf "/home/alice/.claude"', ['deny', 'destructive']],
  ['rm relative root', 'rm -rf /repo/..', ['deny', 'destructive']],
  ['rm multiple with root', 'rm -rf build /', ['deny', 'destructive']],
  ['nonrecursive rm', 'rm file.txt', null],
  ['safe reset', 'git reset --soft HEAD~1', null],
  ['git clean dry run', 'git clean -n', null],
];
for (const [name, value, expected] of destructiveCases) {
  test(`destructive: ${name}`, () => check(command(value), expected));
}

const winDeps = {
  home: 'C:\\Users\\bob', configDir: 'C:\\Users\\bob\\.claude', tmpdir: 'C:\\Temp',
};
const powershellCases = [
  ['Remove-Item -Recurse -Force build', ['ask', 'destructive']],
  ['Remove-Item -Force -Recurse "build output"', ['ask', 'destructive']],
  ['Remove-Item -Recurse -Force C:\\Users\\bob', ['deny', 'destructive']],
  ['Remove-Item -Recurse C:\\Users\\alice', ['deny', 'destructive']],
  ['Remove-Item -Recurse -Force C:\\', ['deny', 'destructive']],
  ['Remove-Item -Recurse $env:USERPROFILE', ['deny', 'destructive']],
  ['Remove-Item -Recurse ~', ['deny', 'destructive']],
  ['Remove-Item -Recurse "C:\\Users\\bob\\.claude"', ['deny', 'destructive']],
  ['Remove-Item -Recurse -Force C:\\Users\\bob\\project\\build', ['ask', 'destructive']],
  ['Remove-Item file.txt', null],
];
for (const [value, expected] of powershellCases) {
  test(`PowerShell destructive: ${value}`, () => check(command(value, 'PowerShell', 'C:\\repo'), expected, {}, winDeps));
}

const stagingCases = [
  ['git add .env', ['deny', 'secrets-staging']],
  ['git add .env.local', ['deny', 'secrets-staging']],
  ['git add config/.env.production', ['deny', 'secrets-staging']],
  ['git add keys/server.pem', ['deny', 'secrets-staging']],
  ['git add server.key', ['deny', 'secrets-staging']],
  ['git add id_rsa', ['deny', 'secrets-staging']],
  ['git add id_rsa.pub', ['deny', 'secrets-staging']],
  ['git add credentials.json', ['deny', 'secrets-staging']],
  ['git add "config with spaces/.env"', ['deny', 'secrets-staging']],
  ['git add -- .env', ['deny', 'secrets-staging']],
  ['git add .env.example', null],
  ['git add .env.sample', null],
  ['git add config/.env.example', null],
  ['git add environment.js', null],
];
for (const [value, expected] of stagingCases) {
  test(`staging: ${value}`, () => check(command(value), expected));
}

const statusCases = [
  ['untracked environment', '?? .env\n', ['deny', 'secrets-staging']],
  ['modified environment', ' M .env.local\n', ['deny', 'secrets-staging']],
  ['modified in index', 'M  credentials.json\n', ['deny', 'secrets-staging']],
  ['quoted space path', '?? "a folder/.env"\n', ['deny', 'secrets-staging']],
  ['renamed into secret', 'R  old.txt -> credentials.json\n', ['deny', 'secrets-staging']],
  ['renamed safe destination', 'R  credentials.json -> safe.txt\n', null],
  ['deleted secret', ' D .env\n', null],
  ['safe modified file', ' M src/index.js\n', null],
  ['example environment', '?? .env.example\n?? .env.sample\n', null],
  ['clean or ignored secrets', '', null],
  ['git unavailable', null, null],
];
for (const [name, status, expected] of statusCases) {
  for (const value of ['git add .', 'git add -A']) {
    test(`bulk staging: ${name}: ${value}`, () => check(command(value), expected, {}, { status: () => status }));
  }
}

const secretContents = [
  ['AWS access key', 'const key = "AK' + 'IA1234567890ABCDEF";'],
  ['GitHub personal token', 'const token = "gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789";'],
  ['GitHub OAuth token', 'const token = "gh' + 'o_abcdefghijklmnopqrstuvwxyz0123456789";'],
  ['GitHub fine-grained token', 'const token = "github' + '_pat_11AABBCCDDEEFF00112233_abcdefghijklmnopqrstuvwxyz0123456789";'],
  ['Anthropic key', 'const key = "sk-' + 'ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";'],
  ['OpenAI key', 'const key = "sk' + '-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";'],
  ['Slack bot token', 'const token = "xo' + 'xb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWxY";'],
  ['Slack user token', 'const token = "xo' + 'xp-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWxY";'],
  ['PKCS8 private key', '-----BEG' + 'IN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----'],
  ['RSA private key', '-----BEG' + 'IN RSA PRIVATE KEY-----\nABC'],
  ['EC private key', '-----BEGIN EC PRIVATE KEY-----\nABC'],
  ['OpenSSH private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nABC'],
  ['high entropy secret', 'const SERVICE_SECRET = "w7Yq9Kz2Pb6Nm4Rf8Va3Dc0Gh5Lj1Su7Xn9Te2Wi6Ao4Ep8Zb3Qf5Vr0Lc";'],
  ['high entropy token', 'SERVICE_TOKEN="aZ9kR4mT7pV2xC6qH8nB3wD5fL1sJ0uE9gN4yA7rQ2dW6hP8cF3vK5zX1"'],
  ['high entropy password', 'DB_PASSWORD = "rT8vQ3yK6nC9wX2mH5sL7dB0fJ4pV1zA8gE3uN6qR9cW2xF5hP7kD0jS4"'],
  ['high entropy API key', 'MY_API_KEY="pQ8mW3rT6vN9xA2kF5hL7sD0jC4uZ1yE8gR3bV6nK9wX2cH5fP7qS0dJ4"'],
];
for (const [name, content] of secretContents) {
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    test(`secret content: ${name} through ${tool}`, () => check(file('/repo/config.js', content, tool), ['deny', 'secrets-content']));
  }
}

test('secret detection checks every MultiEdit replacement', () => {
  check({ tool_name: 'MultiEdit', cwd: '/repo', tool_input: {
    file_path: 'config.js', edits: [{ new_string: 'safe' }, { new_string: secretContents[0][1] }],
  } }, ['deny', 'secrets-content']);
});

test('secret content only examines newly written text', () => {
  check({ tool_name: 'Edit', cwd: '/repo', tool_input: {
    file_path: 'config.js', old_string: secretContents[0][1], new_string: 'process.env.API_KEY',
  } }, null);
  check(file('/repo/config.js', 'const PUBLIC_TEXT = "w7Yq9Kz2Pb6Nm4Rf8Va3Dc0Gh5Lj1Su7Xn9Te2Wi6Ao4Ep8Zb3Qf5Vr0Lc";'), null);
  check(file('/repo/config.js', 'const API_KEY = "your-api-key-here";'), null);
  check(file('/repo/config.js', 'const API_SECRET = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";'), null);
});

for (const target of ['/repo/tests/fixtures/secrets.js', '/repo/config.example', '/repo/config.sample', 'C:\\repo\\tests\\fixtures\\keys.js']) {
  test(`secret fixture exemption: ${target}`, () => check(file(target, secretContents[0][1]), null));
}

const treeDeps = {
  gitInfo: () => ({ root: '/repo/worktree', gitDir: '/repo/.git/worktrees/feature', commonDir: '/repo/.git' }),
};
for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
  test(`worktree fence: ${tool} outside root`, () => {
    const input = file('/repo/main/src/index.js', 'safe', tool, '/repo/worktree');
    check(input, ['deny', 'worktree-fence'], {}, treeDeps);
    assert.match(decide(input, {}, { ...baseDeps, ...treeDeps }).reason, /\/repo\/worktree/);
  });
}

const fenceCases = [
  ['inside root', '/repo/worktree/src/index.js', null],
  ['relative inside', 'src/index.js', null],
  ['root itself', '/repo/worktree', null],
  ['parent traversal', '../main/file.js', ['deny', 'worktree-fence']],
  ['prefix sibling', '/repo/worktree-other/file.js', ['deny', 'worktree-fence']],
  ['config directory', '/home/alice/.claude/settings.json', null],
  ['secondary config directory', '/home/alice/.claude-2/settings.json', null],
  ['temporary directory', '/tmp/guard-test/file.js', null],
  ['scratchpad directory', '/another/scratchpad/note.txt', null],
  ['scratchpad substring', '/another/my-scratchpad-note.txt', null],
  ['config prefix sibling', '/home/alice/.claude-other/file.js', ['deny', 'worktree-fence']],
  ['temp prefix sibling', '/tmp-other/file.js', ['deny', 'worktree-fence']],
];
for (const [name, target, expected] of fenceCases) {
  test(`worktree fence: ${name}`, () => check(file(target, 'safe', 'Write', '/repo/worktree'), expected, {}, treeDeps));
}

test('worktree fence handles custom config directory and ordinary repositories', () => {
  check(file('/custom/config/settings.json', 'safe', 'Write', '/repo/worktree'), null, {}, { ...treeDeps, configDir: '/custom/config' });
  check(file('/outside/file.js', 'safe'), null, {}, {
    gitInfo: () => ({ root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }),
  });
  check(file('/outside/file.js', 'safe'), null);
});

test('worktree fence compares resolved absolute git directories', () => {
  check(file('/outside/file.js', 'safe', 'Write', '/repo'), null, {}, {
    gitInfo: () => ({ root: '/repo', gitDir: '.git', commonDir: '/repo/.git' }),
  });
});

test('Windows worktree paths support mixed case, slashes, and drive boundaries', () => {
  const deps = { ...winDeps, gitInfo: () => ({
    root: 'C:\\Repos\\Worktree', gitDir: 'C:\\Repos\\Main\\.git\\worktrees\\feature', commonDir: 'C:\\Repos\\Main\\.git',
  }) };
  for (const target of ['c:/repos/WORKTREE/src/index.js', '.\\src\\index.js', 'C:\\Users\\bob\\.claude\\settings.json', 'c:/users/BOB/.claude-2/settings.json', 'c:/temp/file.js']) {
    check(file(target, 'safe', 'Write', 'C:\\Repos\\Worktree'), null, {}, deps);
  }
  for (const target of ['C:\\Repos\\Worktree-old\\file.js', 'D:\\Repos\\Worktree\\file.js', '..\\Main\\file.js']) {
    check(file(target, 'safe', 'Write', 'C:\\Repos\\Worktree'), ['deny', 'worktree-fence'], {}, deps);
  }
});

test('deny outranks ask, which outranks allow', () => {
  check(command('git status && rm -rf build && git commit -n -m change'), ['deny', 'no-verify']);
  check(command('git status && rm -rf build'), ['ask', 'destructive']);
  check(command('rm -rf build && git push -f origin main'), ['deny', 'force-push']);
});

test('disabled rule IDs remove only their own opinion', () => {
  check(command('git push -f origin main'), null, { disable: ['force-push'] });
  check(command('git commit -n -m change'), null, { disable: ['no-verify'] });
  check(command('rm -rf build'), null, { disable: ['destructive'] });
  check(command('git add .env'), null, { disable: ['secrets-staging'] });
  check(file('/repo/config.js', secretContents[0][1]), null, { disable: ['secrets-content'] });
  check(file('/outside/file.js', 'safe', 'Write', '/repo/worktree'), null, { disable: ['worktree-fence'] }, treeDeps);
  check(command('git status'), null, { disable: ['safe-allow'] });
  check(command('git commit -n -m change && rm -rf build'), ['ask', 'destructive'], { disable: ['no-verify'] });
});

test('extraSafe extends each segment without overriding safety decisions', () => {
  check(command('make test'), ['allow', 'safe-allow'], { extraSafe: ['^make test$'] });
  check(command('make test && git status'), ['allow', 'safe-allow'], { extraSafe: ['^make test$'] });
  check(command('make deploy'), null, { extraSafe: ['^make test$'] });
  check(command('echo data > file'), null, { extraSafe: ['.*'] });
  check(command('echo $(whoami)'), null, { extraSafe: ['.*'] });
  check(command('git push -f origin main'), ['deny', 'force-push'], { extraSafe: ['.*'] });
  check(command('rm -rf build'), ['ask', 'destructive'], { extraSafe: ['.*'] });
  check(command('git status'), ['allow', 'safe-allow'], { extraSafe: ['['] });
});

test('unrelated tools have no opinion', () => {
  check({ tool_name: 'Read', cwd: '/repo', tool_input: { file_path: '/outside/file.js' } }, null, {}, treeDeps);
});

test('real git worktree rejects writes into the main checkout', (t) => {
  const available = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (available.error || available.status !== 0) return t.skip('git is unavailable');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-worktree-test-'));
  const main = path.join(tempRoot, 'main');
  const worktree = path.join(tempRoot, 'feature');
  fs.mkdirSync(main);
  t.after(() => {
    const resolved = path.resolve(tempRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('guard-worktree-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function git(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  }
  git(main, ['init']);
  git(main, ['-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  git(main, ['worktree', 'add', '-b', 'guard-test-feature', worktree]);
  const deps = { ...baseDeps, tmpdir: path.join(tempRoot, 'allowed-temp'), gitInfo: (cwd) => ({
    root: git(cwd, ['rev-parse', '--show-toplevel']),
    gitDir: git(cwd, ['rev-parse', '--git-dir']),
    commonDir: git(cwd, ['rev-parse', '--git-common-dir']),
  }) };
  const outside = file(path.join(main, 'file.js'), 'safe', 'Write', worktree);
  const result = decide(outside, {}, deps);
  assert.equal(result.decision, 'deny');
  assert.equal(result.rule, 'worktree-fence');
  assert.ok(result.reason.toLowerCase().replaceAll('\\', '/').includes(worktree.toLowerCase().replaceAll('\\', '/')));
  assert.equal(decide(file(path.join(worktree, 'file.js'), 'safe', 'Write', worktree), {}, deps), null);
});
