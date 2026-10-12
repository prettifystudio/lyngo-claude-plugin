// End-to-end tests for bin/lyngo against a fake Lyngo server that implements
// the CLI contract. Run: node --test test/
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lyngo');
const TOKEN = 'lyn_' + 'Z'.repeat(40);
const REMOTE = 'git@github.com:acme/shop.git';
const PKG = '{\n  "name": "shop"\n}\n';

let server;
let base;
let state;
let calls;
let scratch;

const project = (over = {}) => ({ id: 'p1', name: 'shop', full_name: 'acme/shop', branch: 'main', url: base + '/projects/p1', primary_language: 'en', languages: ['en'], i18n: null, github_connected: true, ...over });

function reset(over = {}) {
  calls = [];
  state = {
    tokenSeq: [[400, { error: 'authorization_pending' }], [400, { error: 'slow_down' }], [200, { token: TOKEN, prefix: TOKEN.slice(0, 8), user: { name: 'Dev', email: 'dev@example.com' } }]],
    logoutStatus: 204,
    projectsSeq: [[200, { status: 'found', project: project(), workspace: { id: 'w1', name: 'Acme' } }]],
    statusSeq: [[200, { github_connected: true, project: null }]],
    languages: ['en'],
    scaffold: (body) => {
      const paths = body.files.map((f) => f.path);
      if (!paths.includes('resources/js/app.ts')) return [409, { needs: ['resources/js/app.ts'] }];
      return [200, { patch: SCAFFOLD_PATCH, files: ['package.json', 'resources/js/i18n.ts'], install_command: 'npm install', notes: ['The entry point imports ./i18n.'] }];
    },
    ...over,
  };
}

const SCAFFOLD_PATCH = [
  'diff --git a/package.json b/package.json',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1,3 +1,6 @@',
  ' {',
  '-  "name": "shop"',
  '+  "name": "shop",',
  '+  "dependencies": {',
  '+    "i18next": "^23.0.0"',
  '+  }',
  ' }',
  'diff --git a/resources/js/i18n.ts b/resources/js/i18n.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/resources/js/i18n.ts',
  '@@ -0,0 +1 @@',
  '+export default {};',
  '',
].join('\n');

function next(seq) { return seq.length > 1 ? seq.shift() : seq[0]; }

function handle(req, body) {
  const url = new URL(req.url, base);
  const authed = req.headers.authorization === 'Bearer ' + TOKEN;
  const key = `${req.method} ${url.pathname}`;
  if (key === 'POST /cli/device') {
    if (state.deviceBroken) return [200, { message: 'not a login answer' }];
    return [200, { device_code: 'dev-1', user_code: 'BCDF-GHJK', verification_url: base + '/cli/activate', verification_url_complete: base + '/cli/activate?code=BCDF-GHJK', interval: 1, expires_in: 900 }];
  }
  if (key === 'POST /cli/token') return next(state.tokenSeq);
  if (!authed) return [401, { error: 'unauthorized', message: 'Bad token.' }];
  if (key === 'GET /cli/me') {
    return [200, { user: { name: 'Dev', email: 'dev@example.com' }, token: { prefix: TOKEN.slice(0, 8), kind: 'personal' }, workspaces: [{ id: 'w1', name: 'Acme', role: 'owner', current: true }, { id: 'w2', name: 'Side', role: 'developer', current: false }] }];
  }
  if (key === 'DELETE /cli/token') return [state.logoutStatus, state.logoutStatus === 204 ? null : { message: 'boom' }];
  if (key === 'POST /cli/projects') {
    const [status, b] = next(state.projectsSeq);
    if (b.project) b.project.languages = state.languages;
    return [status, b];
  }
  if (key === 'GET /cli/projects/status') return next(state.statusSeq);
  if (key === 'POST /cli/projects/p1/detect') return [200, { i18n: { framework: 'react', library: 'react-i18next' }, summary: 'react, react-i18next, catalogs in lang' }];
  if (key === 'PATCH /cli/projects/p1') {
    state.languages = body.languages;
    return [200, { project: project({ languages: body.languages, primary_language: body.primary_language }) }];
  }
  if (key === 'POST /cli/projects/p1/scaffold') return state.scaffold(body);
  if (key === 'POST /mcp/admin' && body.params.name === 'localize') {
    const text = JSON.stringify({
      patch: ['diff --git a/resources/js/Hello.tsx b/resources/js/Hello.tsx', '--- a/resources/js/Hello.tsx', '+++ b/resources/js/Hello.tsx', '@@ -1 +1 @@', "-export const Hello = () => <p>Hello</p>;", "+export const Hello = () => <p>{t('Hello')}</p>;", ''].join('\n'),
      report: { files: [{ path: 'resources/js/Hello.tsx', wrapped: ['Hello'] }], primary: { added: ['Hello'], already_there: [] }, languages: { fr: { translated: 1, from_memory: 0, flagged: [] } } },
      deferred: [],
    });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'translate') {
    // Fills every requested key with "[code] key"; keeps what the caller sent.
    const a = body.params.arguments;
    const code = a.languages[0];
    const target = a.catalogs.find((c) => c.path.endsWith('/' + code + '.json'));
    const current = JSON.parse(target.content || '{}');
    for (const k of a.keys) current[k] = `[${code}] ${k}`;
    const text = JSON.stringify({ catalogs: [{ path: target.path, content: JSON.stringify(current, null, 2) + '\n' }], report: { languages: { [code]: { translated: a.keys.length, from_memory: 0, flagged: [] } } } });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin') {
    const text = JSON.stringify({ project: 'shop', primary_language: 'en', languages: ['fr'], i18n: { framework: 'react', library: 'react-i18next', function: 't', catalog_folder: 'lang' }, refused_strings: [] });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  return [404, { message: 'no route ' + key }];
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: new URL(req.url, 'http://x').pathname, url: req.url, headers: req.headers, body });
      const [status, payload] = handle(req, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload === null ? '' : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lyngo-cli-'));
  reset();
});

function home() { const h = path.join(scratch, 'home'); fs.mkdirSync(h, { recursive: true }); return h; }
function loggedIn() {
  const dir = path.join(home(), '.config', 'lyngo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token'), TOKEN + '\n', { mode: 0o600 });
}

function stubClaude() {
  const dir = path.join(scratch, 'stub');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(scratch, 'claude.log');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf -- '---\\n' >> "${log}"\n`, { mode: 0o755 });
  return { dir, log };
}

function safePath(extra = []) {
  const dirs = [...extra, path.dirname(process.execPath), path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim()), '/usr/bin', '/bin'];
  for (const d of dirs.slice(extra.length)) assert.ok(!fs.existsSync(path.join(d, 'claude')), `a real claude sits in ${d}; the test PATH must not reach it`);
  return [...new Set(dirs)].join(path.delimiter);
}

function run(args, { cwd = scratch, pathDirs = [] } = {}) {
  const env = { ...process.env, HOME: home(), LYNGO_HOST: base, LYNGO_NO_BROWSER: '1', LYNGO_TICK_MS: '1', PATH: safePath(pathDirs), GIT_TERMINAL_PROMPT: '0' };
  delete env.LYNGO_TOKEN;
  delete env.LYNGO_URL;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

function g(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); }
function makeRepo(remote = REMOTE) {
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'resources', 'js'), { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), PKG);
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'app.ts'), "import './bootstrap';\n");
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', remote);
  return repo;
}

test('help and version', async () => {
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /lyngo init \[--languages fr,de\] \[--primary en\] \[--workspace <name>\] \[--yes\] \[--github\]/);
  const v = await run(['--version']);
  assert.equal(v.stdout.trim(), '0.1.0');
});

test('login polls through pending and slow_down, then saves the token with mode 600', async () => {
  const r = await run(['login']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, new RegExp(`Open ${base}/cli/activate and enter BCDF-GHJK`));
  assert.match(r.stdout, /Logged in as dev@example\.com/);
  assert.ok(!r.out.includes(TOKEN), 'the full token never reaches the terminal');
  const dir = path.join(home(), '.config', 'lyngo');
  assert.equal(fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(), TOKEN);
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(calls.filter((c) => c.path === '/cli/token').length, 3);
  assert.equal(calls[0].body.hostname, os.hostname());
});

test('login stops when the person cancels in the browser', async () => {
  reset({ tokenSeq: [[400, { error: 'access_denied' }]] });
  const r = await run(['login']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the login was cancelled in the browser/);
  assert.ok(!fs.existsSync(path.join(home(), '.config', 'lyngo', 'token')));
});

test('whoami prints the account, the token prefix and the current workspace, never the token', async () => {
  loggedIn();
  const r = await run(['whoami']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Dev <dev@example\.com>/);
  assert.match(r.stdout, /token: lyn_ZZZZ \(personal\)/);
  assert.match(r.stdout, /\* Acme \(owner\)/);
  assert.match(r.stdout, / {3}Side \(developer\)/);
  assert.ok(!r.out.includes(TOKEN));
});

test('logout revokes the token and deletes the file', async () => {
  loggedIn();
  const r = await run(['logout']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /is revoked/);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/cli/token' && c.headers.authorization === 'Bearer ' + TOKEN));
  assert.ok(!fs.existsSync(path.join(home(), '.config', 'lyngo', 'token')));
});

test('logout deletes the file even when the server fails', async () => {
  loggedIn();
  reset({ logoutStatus: 500 });
  const r = await run(['logout']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /did not confirm/);
  assert.ok(!fs.existsSync(path.join(home(), '.config', 'lyngo', 'token')));
});

test('init on a found project sets everything up, and a second run changes nothing', async () => {
  loggedIn();
  const repo = makeRepo();
  const claude = stubClaude();
  const r = await run(['init', '--languages', 'en,fr'], { cwd: repo, pathDirs: [claude.dir] });
  assert.equal(r.code, 0, r.out);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], 'Workspace: Acme');
  assert.match(r.stdout, /Set up on shop \(workspace Acme\)\./);
  assert.match(r.stdout, /Detection reads main on GitHub\. Push first for an exact result\./);
  assert.match(r.stdout, /Detected: react, react-i18next, catalogs in lang/);
  assert.match(r.stdout, /Languages: en -> fr/);
  assert.match(r.stdout, /Scaffolding applied:\n {2}package\.json\n {2}resources\/js\/i18n\.ts/);
  assert.match(r.stdout, /Run npm install/);
  assert.match(r.stdout, /Done\. Build as usual; lyngo localize runs when your agent finishes, or run it yourself before committing\./);
  assert.ok(!r.out.includes(TOKEN), 'the token never reaches the terminal');

  // Every call inside the repository names it.
  for (const c of calls) assert.equal(c.headers['x-lyngo-remote'], REMOTE, c.path);
  assert.deepEqual(calls.find((c) => c.path === '/cli/projects').body, { remote: REMOTE, branch: 'main' });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { languages: ['en', 'fr'], primary_language: 'en' });

  // Scaffold: one needs round, the tree, then the patch applied on disk.
  const scaffolds = calls.filter((c) => c.path === '/cli/projects/p1/scaffold');
  assert.equal(scaffolds.length, 2);
  assert.deepEqual(scaffolds[0].body.files.map((f) => f.path), ['package.json']);
  assert.ok(scaffolds[0].body.tree.includes('resources/js/app.ts'));
  assert.deepEqual(scaffolds[1].body.files.map((f) => f.path), ['package.json', 'resources/js/app.ts']);
  assert.match(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'), /"i18next": "\^23\.0\.0"/);
  assert.equal(fs.readFileSync(path.join(repo, 'resources/js/i18n.ts'), 'utf8'), 'export default {};\n');

  // Claude Code: local-scope MCP entry with fixed headers, one Stop hook, excluded from git.
  const claudeCalls = fs.readFileSync(claude.log, 'utf8').split('---\n').filter(Boolean).map((b) => b.trim().split('\n'));
  assert.deepEqual(claudeCalls[0], ['mcp', 'remove', 'lyngo', '-s', 'local']);
  assert.deepEqual(claudeCalls[1], ['mcp', 'add', '--transport', 'http', '--scope', 'local', 'lyngo', base + '/mcp', '-H', 'Authorization: Bearer ' + TOKEN, '-H', 'X-Lyngo-Remote: ' + REMOTE]);
  assert.ok(!fs.existsSync(path.join(repo, '.mcp.json')), 'never a .mcp.json');
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'lyngo localize 2>&1 | tail -20' }] }]);
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
  assert.equal(g(repo, 'status', '--porcelain', '--', '.claude'), '');

  // Second run: same project, nothing to scaffold, no second hook, no second PATCH.
  reset({ languages: ['en', 'fr'], scaffold: () => [200, { patch: '', files: [] }] });
  const again = await run(['init'], { cwd: repo, pathDirs: [claude.dir] });
  assert.equal(again.code, 0, again.out);
  assert.match(again.stdout, /Set up on shop/);
  assert.match(again.stdout, /Languages: en -> fr/);
  assert.match(again.stdout, /Scaffolding: nothing to add\./);
  assert.match(again.stdout, /Stop hook was already in/);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  const settings2 = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings2.hooks.Stop.length, 1);
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
});

test('init keeps an existing settings file and adds the hook beside it', async () => {
  loggedIn();
  const repo = makeRepo();
  const claude = stubClaude();
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
  reset({ scaffold: () => [200, { patch: '', files: [] }] });
  const r = await run(['init', '--yes'], { cwd: repo, pathDirs: [claude.dir] });
  assert.equal(r.code, 0, r.out);
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[1].hooks[0].command, 'lyngo localize 2>&1 | tail -20');
});

test('init does not warn when the branch is pushed and package.json is clean', async () => {
  loggedIn();
  const bare = path.join(scratch, 'origin.git');
  g(scratch, 'init', '-q', '--bare', bare);
  const repo = makeRepo(bare);
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  reset({ scaffold: () => [200, { patch: '', files: [] }] });
  const r = await run(['init', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.stdout, /Push first/);
});

test('init waits for the GitHub App when the owner connects it, then creates the project', async () => {
  loggedIn();
  const repo = makeRepo();
  reset({
    projectsSeq: [
      [409, { status: 'needs_github_app', owner: true, connect_url: base + '/source-control', message: 'Connect GitHub for acme/shop:' }],
      [201, { status: 'created', project: project(), workspace: { id: 'w1', name: 'Acme' } }],
    ],
    statusSeq: [[200, { github_connected: false, project: null }], [200, { github_connected: true, project: null }]],
    scaffold: () => [200, { patch: '', files: [] }],
  });
  const r = await run(['init', '--github', '--languages', 'en,de'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, new RegExp(`Connect GitHub for acme/shop:\\n {2}${base}/source-control`));
  assert.match(r.stdout, /Waiting for GitHub/);
  assert.match(r.stdout, /Created shop in workspace Acme\./);
  const st = calls.filter((c) => c.path === '/cli/projects/status');
  assert.equal(st.length, 2);
  assert.equal(new URL(st[0].url, base).searchParams.get('remote'), REMOTE);
  assert.equal(calls.filter((c) => c.path === '/cli/projects').length, 2);
});

test('init stops a member when GitHub is not connected', async () => {
  loggedIn();
  const repo = makeRepo();
  reset({ projectsSeq: [[409, { status: 'needs_github_app', owner: false, connect_url: base + '/source-control', message: 'GitHub is not connected; Owner Name can connect it at ' + base + '/source-control' }]] });
  const r = await run(['init', '--yes'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Owner Name can connect it/);
  assert.equal(calls.filter((c) => c.path === '/cli/projects/status').length, 0);
  assert.equal(calls.filter((c) => c.path.endsWith('/detect')).length, 0);
});

test('init stops on the free plan limit and prints the billing link', async () => {
  loggedIn();
  const repo = makeRepo();
  reset({ projectsSeq: [[402, { status: 'plan_limit', message: 'The free plan includes one project.', billing_url: base + '/settings/billing' }]] });
  const r = await run(['init', '--yes'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /The free plan includes one project\./);
  assert.match(r.stderr, new RegExp(`${base}/settings/billing`));
});

test('init stops a member with no project and names the owner', async () => {
  loggedIn();
  const repo = makeRepo();
  reset({ projectsSeq: [[403, { status: 'not_allowed', message: 'No Lyngo project for this repository. Ask Owner Name to run lyngo init.' }]] });
  const r = await run(['init', '--yes'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Ask Owner Name to run lyngo init\./);
});

test('init without Claude Code skips the agent setup', async () => {
  loggedIn();
  const repo = makeRepo();
  reset({ scaffold: () => [200, { patch: '', files: [] }] });
  const r = await run(['init', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Claude Code not found/);
  assert.ok(!fs.existsSync(path.join(repo, '.claude')));
});

test('init needs a login first', async () => {
  const repo = makeRepo();
  const r = await run(['init'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not logged in\. Run lyngo login first\./);
  assert.equal(calls.length, 0);
});

test('status goes to the admin MCP endpoint with the token and the remote', async () => {
  loggedIn();
  const repo = makeRepo();
  const r = await run(['status'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /shop: react \/ react-i18next \/ t\(\), catalogs in lang/);
  const c = calls.find((x) => x.path === '/mcp/admin');
  assert.equal(c.headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(c.headers['x-lyngo-remote'], REMOTE);
  assert.equal(c.body.params.name, 'status');
});

test('localize sends the changed files to the admin MCP endpoint and applies the patch', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>;\n');
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /1 string localized in 1 file; 1 new key, 0 reused\./);
  assert.match(r.stdout, /fr: 1 translated, 0 from memory/);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), "export const Hello = () => <p>{t('Hello')}</p>;\n");
  const loc = calls.find((c) => c.path === '/mcp/admin' && c.body.params.name === 'localize');
  assert.deepEqual(loc.body.params.arguments.files.map((f) => f.path), ['resources/js/Hello.tsx']);
  assert.equal(loc.body.params.arguments.format, 'patch');
  assert.equal(loc.headers['x-lyngo-remote'], REMOTE);
});

test('init treats --languages as targets: a new project keeps English as its source unless --primary says otherwise', async () => {
  loggedIn();
  reset({ projectsSeq: [[201, { status: 'created', project: project({ primary_language: null, languages: [] }), workspace: { id: 'w1', name: 'Acme' } }]], languages: [] });
  const repo = makeRepo();
  const r = await run(['init', '--yes', '--languages', 'fr,de'], { cwd: repo, pathDirs: [stubClaude().dir] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { languages: ['en', 'fr', 'de'], primary_language: 'en' });
});

test('init --primary sets another source language', async () => {
  loggedIn();
  reset({ projectsSeq: [[201, { status: 'created', project: project({ primary_language: null, languages: [] }), workspace: { id: 'w1', name: 'Acme' } }]], languages: [] });
  const r2 = await run(['init', '--yes', '--languages', 'en', '--primary', 'de'], { cwd: makeRepo(), pathDirs: [stubClaude().dir] });
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, { languages: ['de', 'en'], primary_language: 'de' });
});

test('login stops with a plain message when the server does not answer with a code', async () => {
  reset({ deviceBroken: true });
  const r = await run(['login']);
  assert.notEqual(r.code, 0);
  assert.ok(!r.out.includes('undefined'), r.out);
  assert.match(r.out, /did not answer with a login code/);
});

test('translate fills a missing catalog from the primary one, in chunks of 100', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'lang'), { recursive: true });
  const en = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`Key ${i}`, `Key ${i}`]));
  fs.writeFileSync(path.join(repo, 'lang', 'en.json'), JSON.stringify(en, null, 2) + '\n');
  const r = await run(['translate', 'fr'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /fr: 130 translated, 0 from memory -> lang\/fr\.json/);
  const fr = JSON.parse(fs.readFileSync(path.join(repo, 'lang', 'fr.json'), 'utf8'));
  assert.equal(Object.keys(fr).length, 130);
  assert.equal(fr['Key 7'], '[fr] Key 7');
  const chunks = calls.filter((c) => c.path === '/mcp/admin' && c.body.params.name === 'translate');
  assert.deepEqual(chunks.map((c) => c.body.params.arguments.keys.length), [100, 30]);
  // A second run has nothing left to do.
  const again = await run(['translate', 'fr'], { cwd: repo });
  assert.match(again.stdout, /fr: complete, 130 keys\./);
});

test('translate refuses a language the project does not have', async () => {
  loggedIn();
  const repo = makeRepo();
  const r = await run(['translate', 'xx'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.out, /xx is not one of the project's languages/);
});

test('init names the languages that have no catalog yet and says how to fill them', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lang', 'en.json'), JSON.stringify({ Hello: 'Hello', Save: 'Save' }) + '\n');
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'app.ts'), "import './bootstrap';\n");
  const r = await run(['init', '--languages', 'fr,de', '--yes'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /No catalog yet for fr, de: lang\/<code>\.json is missing, and en\.json holds 2 keys/);
  // --yes fills them right away.
  assert.match(r.stdout, /fr: 2 translated/);
  assert.match(r.stdout, /de: 2 translated/);
  assert.ok(fs.existsSync(path.join(repo, 'lang', 'de.json')));
});
