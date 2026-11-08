// End-to-end tests for bin/lyngo against a fake Lyngo server that implements
// the CLI contract. Run: node --test test/
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = `if command -v lyngo >/dev/null 2>&1; then lyngo localize --hook; else echo '{"systemMessage":"Lyngo: the CLI is not on PATH. Install it: npm i -g @prettifystudio/lyngo-cli"}'; fi`;
const HOOK_024 = 'if command -v lyngo >/dev/null 2>&1; then lyngo localize 2>&1 | tail -20; else echo "lyngo: the CLI is not on PATH. Install it: npm i -g @prettifystudio/lyngo-cli"; fi';
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
    runSteps: [],
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
  if (/^POST \/cli\/runs\/[^/]+\/step$/.test(key)) { state.runSteps.push({ ...body, authed }); return [200, { ok: true }]; }
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
  if (key === 'POST /mcp/admin' && state.mcpFail) return state.mcpFail;
  // Jobs (async: true), when the test turns them on: the call answers with an id, and
  // job_status answers "running" state.jobRunning times, then the payload the call returns without async.
  if (key === 'POST /mcp/admin' && state.jobs && body.params.arguments?.async === true) {
    const { async: _async, ...args } = body.params.arguments;
    const [, sync] = handle(req, { ...body, params: { ...body.params, arguments: args } });
    const id = 'job-' + (Object.keys(state.jobs).length + 1);
    state.jobs[id] = { polls: 0, payload: JSON.parse(sync.result.content[0].text) };
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ job: id, status: 'queued' }) }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'job_status') {
    const id = body.params.arguments.job;
    const job = state.jobs[id];
    job.polls++;
    const st = state.jobFail ? { status: 'failed', error: state.jobFail } : job.polls <= (state.jobRunning ?? 1) ? { status: 'running' } : { status: 'done', result: job.payload };
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ job: id, ...st }) }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'localize' && state.localizeNothing) {
    const text = JSON.stringify({ patch: '', report: { files: body.params.arguments.files.map((f) => ({ path: f.path, wrapped: [] })), primary: { added: [], already_there: [] }, languages: { fr: { translated: 0, from_memory: 0, flagged: [] } } }, deferred: [] });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'localize' && state.localizeOneAtATime) {
    // One file a call, the rest deferred, whatever the client applied: the loop must still end.
    const [first, ...rest] = body.params.arguments.files;
    const text = JSON.stringify({ patch: '', report: { files: [{ path: first.path, wrapped: [] }], primary: { added: [], already_there: [] }, languages: {} }, deferred: rest.map((f) => f.path) });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'localize' && state.localizeTwoBatches) {
    // First call: a catalog is created and one file is deferred. Second call: that catalog must come back.
    const sent = body.params.arguments.catalogs.map((c) => c.path);
    const first = !sent.includes('lang/fr.json');
    const text = JSON.stringify(first
      ? { patch: ['diff --git a/lang/fr.json b/lang/fr.json', 'new file mode 100644', '--- /dev/null', '+++ b/lang/fr.json', '@@ -0,0 +1,3 @@', '+{', '+    "Hello": "Bonjour"', '+}', ''].join('\n'), report: { files: [{ path: body.params.arguments.files[0].path, wrapped: ['Hello'] }], primary: { added: ['Hello'], already_there: [] }, languages: { fr: { translated: 1, from_memory: 0, flagged: [] } } }, deferred: ['resources/js/app.ts'] }
      : { patch: '', report: { files: [], primary: { added: [], already_there: [] }, languages: {}, catalogs_seen: sent }, deferred: [] });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'localize' && state.localizeNeeds) {
    // "needs": the first answer names files the server read from GitHub, with a patch
    // that must not be applied; the call with "context" gets the real patch (and "needs" again when state.needsAgain).
    const retry = Array.isArray(body.params.arguments.context);
    const said = retry ? "{t('Hello')}" : "{t('first answer')}";
    const text = JSON.stringify({
      patch: ['diff --git a/resources/js/Hello.tsx b/resources/js/Hello.tsx', '--- a/resources/js/Hello.tsx', '+++ b/resources/js/Hello.tsx', '@@ -1 +1 @@', '-export const Hello = () => <p>Hello</p>;', `+export const Hello = () => <p>${said}</p>;`, ''].join('\n'),
      report: { files: [{ path: 'resources/js/Hello.tsx', wrapped: ['Hello'] }], primary: { added: ['Hello'], already_there: [] }, languages: {} },
      deferred: [],
      ...(retry && !state.needsAgain ? {} : { needs: state.localizeNeeds }),
    });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'localize') {
    const text = JSON.stringify({
      patch: ['diff --git a/resources/js/Hello.tsx b/resources/js/Hello.tsx', '--- a/resources/js/Hello.tsx', '+++ b/resources/js/Hello.tsx', '@@ -1 +1 @@', "-export const Hello = () => <p>Hello</p>;", "+export const Hello = () => <p>{t('Hello')}</p>;", ''].join('\n'),
      report: { files: [{ path: 'resources/js/Hello.tsx', wrapped: ['Hello'] }], primary: { added: ['Hello'], already_there: [] }, languages: { fr: { translated: 1, from_memory: 0, flagged: [] } }, dot_keys: ['auth.missing'], ...(state.localizeReport || {}) },
      deferred: [],
      next: state.localizeNext || 'Apply the patch with git apply, then show the user the report.',
    });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'select_files') {
    const paths = body.params.arguments.paths.filter((p) => !p.endsWith('.d.ts'));
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ paths, count: paths.length, of: body.params.arguments.paths.length }) }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'check') {
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(state.check) }] } }];
  }
  if (key === 'POST /mcp/admin' && body.params.name === 'translate') {
    // Fills every requested key with "[code] key"; keeps what the caller sent.
    const a = body.params.arguments;
    const code = a.languages[0];
    const target = a.catalogs.find((c) => c.path.endsWith('/' + code + '.json'));
    const current = JSON.parse(target.content || '{}');
    for (const k of a.keys) current[k] = `[${code}] ${k}`;
    const text = JSON.stringify({ catalogs: [{ path: target.path, content: JSON.stringify(current, null, 2) + '\n' }], report: { languages: { [code]: { translated: a.keys.length, from_memory: 0, flagged: [] } }, ...(state.translateReport || {}) } });
    return [200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }];
  }
  if (key === 'POST /mcp/admin') {
    const text = JSON.stringify({ project: 'shop', primary_language: 'en', languages: ['fr'], i18n: { framework: 'react', library: 'react-i18next', function: 't', catalog_folder: 'lang', js_catalog_folder: state.jsCatalogFolder || null }, refused_strings: [] });
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
      // state.faults: one entry per request ('reset' drops the connection, a number is that status), the last one repeats.
      const fault = state.faults && next(state.faults);
      if (fault === 'reset') { req.socket.resetAndDestroy(); return; }
      if (fault) { res.writeHead(fault, { 'Content-Type': 'text/html' }); res.end(`<html>error ${fault}</html>`); return; }
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

// Fake package managers, first on every test PATH after the test's own stubs:
// init runs the install the scaffold names, and a test never runs a real one.
// Each logs its arguments, its folder and the package.json it saw, then exits with `code`.
function fakeInstallers(code = 0) {
  const dir = path.join(scratch, code ? 'pm-fail' : 'pm');
  const log = path.join(scratch, 'install.log');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s %s in %s\\n' "${name}" "$*" "$(pwd -P)" >> "${log}"\ncat package.json >> "${log}"\necho "${name}: installed"\nexit ${code}\n`, { mode: 0o755 });
  }
  return { dir, log };
}

function safePath(extra = []) {
  const dirs = [...extra, path.dirname(process.execPath), path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim()), '/usr/bin', '/bin'];
  for (const d of dirs.slice(extra.length)) assert.ok(!fs.existsSync(path.join(d, 'claude')), `a real claude sits in ${d}; the test PATH must not reach it`);
  return [...new Set(dirs)].join(path.delimiter);
}

function run(args, { cwd = scratch, pathDirs = [], input, env: extra = {} } = {}) {
  const env = { ...process.env, HOME: home(), LYNGO_HOST: base, LYNGO_NO_BROWSER: '1', LYNGO_TICK_MS: '1', PATH: safePath([...pathDirs, fakeInstallers().dir]), GIT_TERMINAL_PROMPT: '0', ...extra };
  delete env.LYNGO_TOKEN;
  delete env.LYNGO_URL;
  if (!('CI' in extra)) delete env.CI; // a CI runner sets it; init sees it only where a test says so
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) child.stdin.end(input);
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
  assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync(path.resolve(path.dirname(BIN), '..', 'package.json'), 'utf8')).version);
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
  assert.match(r.stdout, /Restart your dev server so Vite picks up the new packages\./);
  assert.match(r.stdout, /Done\. Build as usual; lyngo localize runs when your agent finishes, or run it yourself before committing\./);
  assert.match(r.stdout, /Slash commands for Claude Code \(\/lyngo:localize, \/lyngo:init, \/lyngo:status\): claude plugin marketplace add prettifystudio\/lyngo-claude-plugin && claude plugin install lyngo@lyngo/);
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
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: HOOK }] }]);
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

const scaffoldWith = (install_command) => () => [200, { patch: SCAFFOLD_PATCH, files: ['package.json', 'resources/js/i18n.ts'], install_command, notes: [] }];

test('init runs the install command the server names in the repository root, after the patch', async () => {
  loggedIn();
  reset({ scaffold: scaffoldWith('pnpm install') });
  const repo = makeRepo();
  const r = await run(['init', '--yes', '--languages', 'fr'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const log = fs.readFileSync(path.join(scratch, 'install.log'), 'utf8');
  assert.ok(log.startsWith(`pnpm install in ${fs.realpathSync(repo)}\n`), log);
  assert.match(log, /"i18next": "\^23\.0\.0"/, 'the install sees the patched package.json');
  assert.match(r.stdout, /pnpm: installed/, 'the install output reaches the user');
  assert.match(r.stdout, /Restart your dev server so Vite picks up the new packages\./);
  assert.doesNotMatch(r.stdout, /Run pnpm install/);
});

test('init --no-install prints the install command and runs nothing', async () => {
  loggedIn();
  reset({ scaffold: scaffoldWith('yarn install') });
  const repo = makeRepo();
  const r = await run(['init', '--yes', '--languages', 'fr', '--no-install'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(scratch, 'install.log')), 'no install ran');
  assert.match(r.stdout, /Run yarn install/);
  assert.match(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'), /"i18next"/, 'the patch still applies');
});

test('init in --hook mode never runs an install: the command goes to the output', async () => {
  loggedIn();
  const repo = makeRepo();
  const r = await run(['init', '--yes', '--languages', 'fr', '--hook'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(scratch, 'install.log')), 'no install ran');
  assert.match(r.stdout, /Run npm install/);
});

test('init exits non-zero with the command to run when the install fails', async () => {
  loggedIn();
  const repo = makeRepo();
  const failing = fakeInstallers(1);
  const r = await run(['init', '--yes', '--languages', 'fr'], { cwd: repo, pathDirs: [failing.dir] });
  assert.equal(r.code, 1, r.out);
  assert.ok(fs.existsSync(failing.log), 'the install ran');
  assert.match(r.stderr, /lyngo: npm install failed \(exit 1\)\. Run npm install in .+ before you start the dev server\./);
  assert.doesNotMatch(r.stdout, /Restart your dev server/);
});

test('init exits non-zero with the command to run when the package manager is not installed', async (t) => {
  const dirs = [path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim()), '/usr/bin', '/bin'];
  if (dirs.some((d) => fs.existsSync(path.join(d, 'bun')))) { t.skip('bun is installed next to git'); return; }
  loggedIn();
  reset({ scaffold: scaffoldWith('bun install') });
  const repo = makeRepo();
  const r = await run(['init', '--yes', '--languages', 'fr'], { cwd: repo, env: { PATH: [...new Set(dirs)].join(path.delimiter) } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /lyngo: bun is not installed, so the new packages are not\. Run bun install in .+ before you start the dev server\./);
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
  assert.equal(settings.hooks.Stop[1].hooks[0].command, HOOK);
});

test('init writes the hook and registers the MCP server before the language question, so a run that stops there still leaves them', async () => {
  loggedIn();
  const repo = makeRepo();
  const claude = stubClaude();
  reset({ languages: [], scaffold: () => [200, { patch: '', files: [] }] });
  const r = await run(['init'], { cwd: repo, pathDirs: [claude.dir] });
  assert.notEqual(r.code, 0, 'no languages, no TTY: init stops at the question');
  assert.match(r.out, /choose the languages with --languages/);
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: HOOK }] }]);
  const claudeCalls = fs.readFileSync(claude.log, 'utf8').split('---\n').filter(Boolean).map((b) => b.trim().split('\n'));
  assert.equal(claudeCalls[1][1], 'add');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('init upgrades the old Stop hook to the one that says when the CLI is missing', async () => {
  loggedIn();
  const repo = makeRepo();
  const claude = stubClaude();
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'lyngo localize 2>&1 | tail -20' }] }] } }));
  reset({ languages: ['en', 'fr'], scaffold: () => [200, { patch: '', files: [] }] });
  const r = await run(['init'], { cwd: repo, pathDirs: [claude.dir] });
  assert.equal(r.code, 0, r.out);
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: HOOK }] }]);
});

test('init upgrades the 0.2.4 Stop hook in place to the --hook one', async () => {
  loggedIn();
  const repo = makeRepo();
  const claude = stubClaude();
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_024 }] }] } }));
  reset({ languages: ['en', 'fr'], scaffold: () => [200, { patch: '', files: [] }] });
  const r = await run(['init'], { cwd: repo, pathDirs: [claude.dir] });
  assert.equal(r.code, 0, r.out);
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: HOOK }] }]);
});

test('the hook command prints valid JSON when the CLI is not on PATH, and passes stdin through when it is', () => {
  const missing = execFileSync('/bin/sh', ['-c', HOOK], { cwd: scratch, encoding: 'utf8', env: { PATH: '' } });
  assert.deepEqual(JSON.parse(missing), { systemMessage: 'Lyngo: the CLI is not on PATH. Install it: npm i -g @prettifystudio/lyngo-cli' });
  // A stand-in lyngo that echoes its stdin: nothing between Claude Code and the CLI eats the input.
  const dir = path.join(scratch, 'fake-lyngo');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'lyngo'), '#!/bin/sh\ncat\n', { mode: 0o755 });
  const through = execFileSync('/bin/sh', ['-c', HOOK], { cwd: scratch, encoding: 'utf8', input: '{"stop_hook_active":false}', env: { PATH: dir + ':/usr/bin:/bin' } });
  assert.equal(through, '{"stop_hook_active":false}');
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

// ── 0.2.9: init waits for the GitHub App like npm login, also for an agent ──

const APP_URL = 'https://github.com/apps/lyngo/installations/new?state=abc';
const needsApp = (statusSeq) => reset({
  projectsSeq: [
    [409, { status: 'needs_github_app', owner: true, repository: 'acme/shop', connect_url: APP_URL, message: 'The Lyngo GitHub App cannot read acme/shop yet.' }],
    [201, { status: 'created', project: project(), workspace: { id: 'w1', name: 'Acme' } }],
  ],
  statusSeq,
  scaffold: () => [200, { patch: '', files: [] }],
});
// A stand-in browser opener (LYNGO_OPENER): it logs each URL it gets.
function stubOpener() {
  const log = path.join(scratch, 'opened.log');
  const bin = path.join(scratch, 'opener');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\n`, { mode: 0o755 });
  return { env: { LYNGO_NO_BROWSER: '', LYNGO_OPENER: bin }, opened: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
const LINK = /The Lyngo GitHub App cannot read acme\/shop yet\.\n {2}https:\/\/github\.com\/apps\/lyngo\/installations\/new\?state=abc\n/;
const STOPPED = /WAITING FOR THE PERSON: open the link above, add the repository to the Lyngo GitHub App, then run lyngo init again\./;

test('init without a terminal prints the link, opens it, waits for the GitHub App and finishes in one run', async () => {
  loggedIn();
  const repo = makeRepo();
  needsApp([[200, { github_connected: false, project: null }], [200, { github_connected: true, project: null }]]);
  const opener = stubOpener();
  const r = await run(['init', '--languages', 'en,fr'], { cwd: repo, env: opener.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, LINK);
  assert.ok(r.stdout.indexOf(APP_URL) < r.stdout.indexOf('Waiting for GitHub (up to 9 minutes)...'), 'the link comes before the wait');
  assert.match(r.stdout, /GitHub is connected\.\nCreated shop in workspace Acme\./);
  assert.match(r.stdout, /Done\. Build as usual/);
  assert.doesNotMatch(r.stdout, /WAITING FOR THE PERSON/);
  assert.deepEqual(opener.opened(), [APP_URL]);
  assert.equal(calls.filter((c) => c.path === '/cli/projects/status').length, 2);
  assert.equal(calls.filter((c) => c.path === '/cli/projects').length, 2);
});

test('init with CI set stops at the missing GitHub App with exit 3, opens nothing and does not wait', async () => {
  loggedIn();
  const repo = makeRepo();
  needsApp([[200, { github_connected: true, project: null }]]);
  const opener = stubOpener();
  const r = await run(['init', '--languages', 'en,fr'], { cwd: repo, env: { ...opener.env, CI: 'true' } });
  assert.equal(r.code, 3, r.out);
  assert.match(r.stdout, LINK);
  assert.match(r.stdout, STOPPED);
  assert.doesNotMatch(r.stdout, /Waiting for GitHub/);
  assert.deepEqual(opener.opened(), []);
  assert.equal(calls.filter((c) => c.path === '/cli/projects/status').length, 0);
  assert.equal(calls.filter((c) => c.path === '/cli/projects').length, 1);
});

test('init --no-wait stops at the missing GitHub App with exit 3, opens nothing and does not wait', async () => {
  loggedIn();
  const repo = makeRepo();
  needsApp([[200, { github_connected: true, project: null }]]);
  const opener = stubOpener();
  const r = await run(['init', '--languages', 'en,fr', '--no-wait'], { cwd: repo, env: { ...opener.env, CI: 'false' } });
  assert.equal(r.code, 3, r.out);
  assert.match(r.stdout, LINK);
  assert.match(r.stdout, STOPPED);
  assert.doesNotMatch(r.stdout, /Waiting for GitHub/);
  assert.deepEqual(opener.opened(), []);
  assert.equal(calls.filter((c) => c.path === '/cli/projects/status').length, 0);
});

test('init without a terminal gives up after 9 minutes with a clear message and a line each minute', async () => {
  loggedIn();
  const repo = makeRepo();
  needsApp([[200, { github_connected: false, project: null }]]);
  const r = await run(['init', '--languages', 'en,fr'], { cwd: repo, env: { LYNGO_TICK_MS: '2' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /lyngo: GitHub is still not connected after 9 minutes\. Add the repository to the Lyngo GitHub App, then run lyngo init again\./);
  const progress = r.stdout.match(/Still waiting for GitHub \(\d of 9 minutes\)\.\.\./g) || [];
  assert.ok(progress.length >= 1 && progress.length <= 8, r.stdout);
  assert.ok(calls.filter((c) => c.path === '/cli/projects/status').length > 2);
  assert.equal(calls.filter((c) => c.path === '/cli/projects').length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/detect')).length, 0);
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

test('check prints the strings of one file: the text, path keys on a path-key project, the note when nothing changes', async () => {
  loggedIn();
  const repo = makeRepo();
  const file = 'resources/js/Hello.tsx';
  fs.writeFileSync(path.join(repo, file), 'export const Hello = () => <p>Hello</p>;\n');
  const answer = (over) => ({ file, project: 'shop', key_style: 'text', user_facing_strings: ['Hello', 'Sign in'], keys: { Hello: 'Hello', 'Sign in': 'Sign in' }, count: 2, changed: true, rewritten: 'x', existing_keys: [], note: 'Write "rewritten" back to the file.', ...over });

  state.check = answer();
  let r = await run(['check', file], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout, `${file}: 2 user-facing strings\n  "Hello"\n  "Sign in"\n`);
  const c = calls.find((x) => x.path === '/mcp/admin');
  assert.deepEqual(c.body.params, { name: 'check', arguments: { path: file, content: 'export const Hello = () => <p>Hello</p>;\n' } });

  state.check = answer({ key_style: 'path', keys: { 'hello.title': 'Hello', 'hello.sign_in': 'Sign in' } });
  r = await run(['check', file], { cwd: repo });
  assert.equal(r.stdout, `${file}: 2 user-facing strings\n  hello.title => "Hello"\n  hello.sign_in => "Sign in"\n`);

  state.check = answer({ user_facing_strings: [], keys: [], count: 0, changed: false, rewritten: null, note: 'Nothing to localize.' });
  r = await run(['check', file], { cwd: repo });
  assert.equal(r.stdout, `${file}: 0 user-facing strings\nNothing to localize.\n`);
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

test('localize --all sends every tracked source file the server selects, committed or not, in batches', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>;\n');
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'types.d.ts'), 'export {};\n');
  fs.mkdirSync(path.join(repo, 'vendor', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'vendor', 'x', 'a.php'), '<?php\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'files');
  const r = await run(['localize', '--all'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /localizing 2 files in batches; each batch applies before the next\./);
  assert.match(r.stdout, /batch 1: 2\/2 files, 1 string localized/);
  assert.match(r.stdout, /1 string localized in 1 file; 1 new key, 0 reused\./);
  const sel = calls.find((c) => c.path === '/mcp/admin' && c.body.params.name === 'select_files');
  assert.deepEqual(sel.body.params.arguments.paths, ['resources/js/Hello.tsx', 'resources/js/app.ts', 'resources/js/types.d.ts']);
  const loc = calls.find((c) => c.path === '/mcp/admin' && c.body.params.name === 'localize');
  assert.deepEqual(loc.body.params.arguments.files.map((f) => f.path), ['resources/js/Hello.tsx', 'resources/js/app.ts']);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), "export const Hello = () => <p>{t('Hello')}</p>;\n");
});

test('localize sends both catalog folders, read again before every batch', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>;\n');
  fs.mkdirSync(path.join(repo, 'resources', 'js', 'locales'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'locales', 'en.json'), '{}\n');
  fs.mkdirSync(path.join(repo, 'lang'));
  fs.writeFileSync(path.join(repo, 'lang', 'en.json'), '{}\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'files');
  reset({ jsCatalogFolder: 'resources/js/locales', localizeTwoBatches: true });
  const r = await run(['localize', '--all'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const locs = calls.filter((c) => c.path === '/mcp/admin' && c.body.params.name === 'localize');
  assert.equal(locs.length, 2);
  assert.deepEqual(locs[0].body.params.arguments.catalogs.map((c) => c.path), ['lang/en.json', 'resources/js/locales/en.json']);
  assert.deepEqual(locs[1].body.params.arguments.catalogs.map((c) => c.path), ['lang/en.json', 'lang/fr.json', 'resources/js/locales/en.json']);
  assert.equal(fs.readFileSync(path.join(repo, 'lang', 'fr.json'), 'utf8'), '{\n    "Hello": "Bonjour"\n}\n');
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

test('localize --no-translate sends translate: false and says the catalogs were left alone', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>;\n');
  const r = await run(['localize', '--no-translate'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const loc = calls.find((c) => c.path === '/mcp/admin' && c.body.params.name === 'localize');
  assert.equal(loc.body.params.arguments.translate, false);
  assert.match(r.stdout, /catalogs: not translated \(keys only\)\./);
});

test('onboard: an agent runs it four times and the person acts twice', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'composer.json'), '{ "require": { "laravel/framework": "^13.0" } }\n');
  g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'laravel');
  const id = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
  reset({ tokenSeq: [[400, { error: 'authorization_pending' }]], scaffold: () => [200, { patch: '', files: [] }] });

  // 1. No token: it starts a login and stops with the instruction.
  let r = await run(['onboard', '--run=' + id], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /\[1\/7\] Checking the repository/);
  assert.match(r.stdout, /WAITING FOR THE PERSON\n {2}Ask the person to open .*enter the code BCDF-GHJK/);
  assert.match(r.stdout, new RegExp(`Then run: lyngo onboard --run=${id}`));
  assert.deepEqual(state.runSteps.map((x) => [x.step, x.state]), [['cli', 'done'], ['login', 'waiting']]);

  // 2. The person confirmed: the pending code is approved, the project is found, languages are missing.
  state.tokenSeq = [[200, { token: TOKEN, prefix: TOKEN.slice(0, 8), user: { name: 'Dev', email: 'dev@example.com' } }]];
  state.runSteps = [];
  r = await run(['onboard', '--run=' + id], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Logged in as dev@example.com/);
  assert.match(r.stdout, /Found shop\./);
  assert.match(r.stdout, /Ask the person which languages to translate into/);
  assert.deepEqual(state.runSteps.map((x) => [x.step, x.state]), [['cli', 'done'], ['login', 'done'], ['github', 'done'], ['setup', 'running'], ['languages', 'waiting']]);
  assert.ok(state.runSteps.every((x) => x.step === 'cli' || x.authed), 'steps after the login carry the token');

  // 3. With the languages: setup, hook, and it asks for one change.
  state.runSteps = [];
  r = await run(['onboard', '--run=' + id, '--languages', 'fr'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /Languages: en -> fr/);
  assert.match(r.stdout, /Make one change a person can see/);
  const steps3 = state.runSteps.map((x) => x.step);
  assert.ok(['languages', 'setup', 'hook', 'localize'].every((k) => steps3.includes(k)), steps3.join(','));
  assert.equal(state.runSteps.find((x) => x.step === 'localize').state, 'waiting');

  // 4. One changed file: localized, done.
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>;\n');
  state.runSteps = [];
  r = await run(['onboard', '--run=' + id, '--languages', 'fr'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /DONE\. 1 strings localized in 1 files; 1 new keys, 0 reused; 1 languages filled\./);
  assert.equal(state.runSteps.find((x) => x.step === 'localize').state, 'done');
});

test('onboard refuses a folder that is not a Laravel repository', async () => {
  const repo = makeRepo();
  const r = await run(['onboard', '--run=0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.out, /not a Laravel application/);
  assert.deepEqual(state.runSteps.map((x) => [x.step, x.state]), [['cli', 'failed']]);
});

// ── lyngo localize --hook ─────────────────────────────────────────────────

const STOP = '{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false}';
const sha1 = (file) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const hookState = (repo) => path.join(repo, '.git', 'lyngo-hook.json');
const mcpCalls = () => calls.filter((c) => c.path === '/mcp/admin');
function helloRepo() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Hello = () => <p>Hello</p>;\n');
  return repo;
}

test('localize --hook prints one JSON object: a line for the person, the report for the agent; the files are patched and the state is written', async () => {
  loggedIn();
  const repo = helloRepo();
  const r = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one line on stdout');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['hookSpecificOutput', 'systemMessage']);
  assert.equal(out.systemMessage, 'Lyngo: 1 string localized in 1 file, 1 new key; fr: 1 translated');
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^lyngo: 1 string localized in 1 file; 1 new key, 0 reused\.\n {2}resources\/js\/Hello\.tsx: "Hello"\n {2}fr: 1 translated, 0 from memory\n/);
  assert.match(ctx, /\n {2}path keys no catalog holds: "auth\.missing"\n/);
  assert.match(ctx, /already updated these files and the catalogs on disk\. Tell the user in one or two sentences what Lyngo changed\. Do not edit those files or the catalogs again\./);
  const file = path.join(repo, 'resources', 'js', 'Hello.tsx');
  assert.equal(fs.readFileSync(file, 'utf8'), "export const Hello = () => <p>{t('Hello')}</p>;\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(hookState(repo), 'utf8')), { 'resources/js/Hello.tsx': sha1(file) });
  assert.doesNotMatch(g(repo, 'status', '--porcelain', '--untracked-files=all'), /lyngo-hook/);
});

test('localize --hook stays silent while Claude is already continuing for a stop hook', async () => {
  loggedIn();
  const repo = helloRepo();
  const r = await run(['localize', '--hook'], { cwd: repo, input: '{"stop_hook_active":true}' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout, '');
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), 'export const Hello = () => <p>Hello</p>;\n');
});

test('localize --hook with no changed files prints nothing and calls nobody', async () => {
  loggedIn();
  const repo = makeRepo();
  const r = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout, '');
  assert.equal(calls.length, 0);
});

test('localize --hook sends nothing when nothing changed since its last run, and sends a file again once it is edited', async () => {
  loggedIn();
  const repo = helloRepo();
  fs.writeFileSync(path.join(repo, 'resources', 'js', 'Other.tsx'), 'export const Other = 1;\n');
  const first = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(mcpCalls().find((c) => c.body.params.name === 'localize').body.params.arguments.files.map((f) => f.path), ['resources/js/Hello.tsx', 'resources/js/Other.tsx']);

  reset();
  const again = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(again.code, 0, again.out);
  assert.equal(again.stdout, '');
  assert.equal(calls.length, 0, 'no status call, no localize call');

  // Plain localize ignores the hook state: it sends every changed file.
  reset({ localizeNothing: true });
  const plain = await run(['localize'], { cwd: repo });
  assert.equal(plain.code, 0, plain.out);
  assert.equal(mcpCalls().find((c) => c.body.params.name === 'localize').body.params.arguments.files.length, 2);

  reset({ localizeNothing: true });
  fs.appendFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'export const Bye = () => <p>Bye</p>;\n');
  const edited = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(edited.code, 0, edited.out);
  assert.deepEqual(mcpCalls().find((c) => c.body.params.name === 'localize').body.params.arguments.files.map((f) => f.path), ['resources/js/Hello.tsx']);
  assert.deepEqual(JSON.parse(edited.stdout), { systemMessage: 'Lyngo: checked 1 file, nothing to localize' });
});

test('localize --hook with nothing to localize prints only the line for the person', async () => {
  loggedIn();
  const repo = helloRepo();
  reset({ localizeNothing: true });
  const r = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.stdout), { systemMessage: 'Lyngo: checked 1 file, nothing to localize' });
  assert.ok(fs.existsSync(hookState(repo)), 'a checked file is not sent again');
});

test('localize --hook turns every failure into one JSON object with the fix, exits 0 and records nothing', async () => {
  const repo = helloRepo();
  const cases = [
    [() => {}, /^Lyngo: not logged in\. Run lyngo login first$/, /Tell the user, with the fix: run \/lyngo:login/],
    [() => { loggedIn(); reset({ mcpFail: [404, { error: 'no_project', message: 'No Lyngo project for this repository. Run lyngo init.' }] }); }, /^Lyngo: No Lyngo project for this repository\. Run lyngo init$/, /with the fix: run \/lyngo:init/],
    [() => { reset({ mcpFail: [500, { message: 'Server Error' }] }); }, /^Lyngo: Server Error$/, /with the fix: run \/lyngo:localize to try again\.$/],
  ];
  for (const [setup, line, fix] of cases) {
    setup();
    const r = await run(['localize', '--hook'], { cwd: repo, input: STOP });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, line);
    assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(out.hookSpecificOutput.additionalContext, /^Lyngo could not localize the changes: /);
    assert.match(out.hookSpecificOutput.additionalContext, fix);
    assert.ok(!r.out.includes(TOKEN));
    assert.ok(!fs.existsSync(hookState(repo)));
  }
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), 'export const Hello = () => <p>Hello</p>;\n');
});

// ── 0.2.7: localize and translate run as server jobs ──────────────────────

test('localize starts a job, polls job_status until it is done, applies the result and shows progress', async () => {
  loggedIn();
  reset({ jobs: {}, jobRunning: 7 });
  const repo = helloRepo();
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const loc = mcpCalls().find((c) => c.body.params.name === 'localize');
  assert.equal(loc.body.params.arguments.async, true);
  const polls = mcpCalls().filter((c) => c.body.params.name === 'job_status');
  assert.equal(polls.length, 8);
  assert.ok(polls.every((c) => c.body.params.arguments.job === 'job-1'));
  assert.match(r.stdout, /Lyngo is still working \(running, 15 s\)/);
  assert.match(r.stdout, /1 string localized in 1 file; 1 new key, 0 reused\./);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), "export const Hello = () => <p>{t('Hello')}</p>;\n");
});

test('localize --hook waits for the job and still prints one JSON object, no progress lines', async () => {
  loggedIn();
  reset({ jobs: {}, jobRunning: 7 });
  const repo = helloRepo();
  const r = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one line on stdout');
  const out = JSON.parse(r.stdout);
  assert.equal(out.systemMessage, 'Lyngo: 1 string localized in 1 file, 1 new key; fr: 1 translated');
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /still working/);
});

test('a failed job stops localize with the server\'s message and changes nothing', async () => {
  loggedIn();
  reset({ jobs: {}, jobFail: 'Lyngo could not finish this job on the server. Run the command again; if it fails again, send us the job id job-1.' });
  const repo = helloRepo();
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /lyngo: Lyngo could not finish this job on the server\. Run the command again; if it fails again, send us the job id job-1\./);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), 'export const Hello = () => <p>Hello</p>;\n');
});

test('a job that never finishes gives up after the timeout with a clear message', async () => {
  loggedIn();
  reset({ jobs: {}, jobRunning: 1e9 });
  const r = await run(['localize'], { cwd: helloRepo(), env: { LYNGO_JOB_TIMEOUT: '60' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the server did not finish within 1 minutes \(job job-1\)\. Run the command again later\./);
});

test('localize sends Laravel\'s lang/<code>/*.php files with the catalogs', async () => {
  loggedIn();
  const repo = helloRepo();
  fs.mkdirSync(path.join(repo, 'lang', 'en'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'lang', 'fr'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lang', 'en.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'lang', 'en', 'orders.php'), "<?php\n\nreturn ['title' => 'Orders'];\n");
  fs.writeFileSync(path.join(repo, 'lang', 'en', 'auth.php'), "<?php\n\nreturn [];\n");
  fs.writeFileSync(path.join(repo, 'lang', 'fr', 'orders.php'), "<?php\n\nreturn ['title' => 'Commandes'];\n");
  fs.writeFileSync(path.join(repo, 'lang', 'fr', 'notes.txt'), 'not a lang file\n');
  reset({ jobs: {} });
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const loc = mcpCalls().find((c) => c.body.params.name === 'localize');
  assert.deepEqual(loc.body.params.arguments.catalogs.map((c) => c.path), ['lang/en.json', 'lang/en/auth.php', 'lang/en/orders.php', 'lang/fr/orders.php']);
  assert.equal(loc.body.params.arguments.catalogs.find((c) => c.path === 'lang/fr/orders.php').content, "<?php\n\nreturn ['title' => 'Commandes'];\n");
});

test('localize prints what the server skipped, the keys a language did not get and its notes', async () => {
  loggedIn();
  reset({
    jobs: {},
    localizeReport: { skipped: [{ path: 'resources/js/Data.tsx', reason: 'too large for one call: split it, or let a scan localize it' }], languages: { fr: { translated: 1, from_memory: 0, flagged: [], untranslated: ['Goodbye', 'Thanks'] } } },
    localizeNext: 'Apply the patch with git apply, then show the user the report. Some translations did not fit in this call: run `lyngo translate fr`.',
  });
  const r = await run(['localize'], { cwd: helloRepo() });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /fr: 2 keys not translated yet \("Goodbye", "Thanks"\): run lyngo translate fr/);
  assert.match(r.stdout, /skipped resources\/js\/Data\.tsx: too large for one call: split it, or let a scan localize it/);
  assert.match(r.stdout, /\n {2}Some translations did not fit in this call: run `lyngo translate fr`\.\n/);
  assert.doesNotMatch(r.stdout, /Apply the patch/);
});

test('localize --dry with jobs ends: each call sends only what the last one deferred', async () => {
  loggedIn();
  const repo = makeRepo();
  for (const name of ['A', 'B', 'C']) fs.writeFileSync(path.join(repo, 'resources', 'js', name + '.tsx'), `export const ${name} = () => <p>${name}</p>;\n`);
  reset({ jobs: {}, localizeOneAtATime: true });
  const r = await run(['localize', '--dry'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const locs = mcpCalls().filter((c) => c.body.params.name === 'localize');
  assert.deepEqual(locs.map((c) => c.body.params.arguments.files.length), [3, 2, 1]);
});

test('translate runs each chunk as a job and writes the catalog', async () => {
  loggedIn();
  reset({ jobs: {}, jobRunning: 2 });
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lang', 'en.json'), JSON.stringify({ Hello: 'Hello', Save: 'Save' }, null, 2) + '\n');
  const r = await run(['translate', 'fr'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /fr: 2 translated, 0 from memory -> lang\/fr\.json/);
  assert.equal(mcpCalls().find((c) => c.body.params.name === 'translate').body.params.arguments.async, true);
  assert.equal(mcpCalls().filter((c) => c.body.params.name === 'job_status').length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'lang', 'fr.json'), 'utf8')).Save, '[fr] Save');
});

// ── 0.2.8: a dropped connection is tried again ─────────────────────────────

const RETRY_LINE = /lyngo: connection problem \([^)]+\), trying again in \d+ s \(\d\/4\)\./g;

test('a dropped connection is tried again: the command succeeds and says so in one line', async () => {
  loggedIn();
  reset({ faults: ['reset', null] });
  const r = await run(['status'], { cwd: makeRepo() });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /shop: react \/ react-i18next \/ t\(\), catalogs in lang/);
  assert.equal(r.stderr, 'lyngo: connection problem (ECONNRESET), trying again in 2 s (1/4).\n');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body, 'the same body goes again');
});

test('a proxy error before the origin answered (524) is tried again', async () => {
  loggedIn();
  reset({ faults: [524, 524, null] });
  const r = await run(['status'], { cwd: makeRepo() });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /shop: react/);
  assert.equal(r.stderr.match(RETRY_LINE).length, 2);
  assert.match(r.stderr, /connection problem \(HTTP 524\), trying again in 5 s \(2\/4\)\./);
  assert.equal(calls.length, 3);
});

test('a connection that keeps dropping stops after 4 attempts with the could-not-reach message', async () => {
  loggedIn();
  reset({ faults: ['reset'] });
  const r = await run(['status'], { cwd: makeRepo() });
  assert.equal(r.code, 1);
  assert.equal(calls.length, 4);
  assert.equal(r.stderr.match(RETRY_LINE).length, 3);
  assert.match(r.stderr, /trying again in 10 s \(3\/4\)\.\nlyngo: could not reach http:\/\/127\.0\.0\.1:\d+ \(ECONNRESET\)\.\n$/);
});

test('a 400 or a 404 is never tried again', async () => {
  loggedIn();
  const repo = makeRepo();
  for (const status of [400, 404]) {
    reset({ faults: [status] });
    const r = await run(['status'], { cwd: repo });
    assert.equal(r.code, 1);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(r.stderr, /trying again/);
  }
});

test('localize --hook tries again without a word on the terminal', async () => {
  loggedIn();
  reset({ faults: ['reset', null] });
  const r = await run(['localize', '--hook'], { cwd: helloRepo(), input: STOP });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stderr, '');
  assert.equal(JSON.parse(r.stdout).systemMessage, 'Lyngo: 1 string localized in 1 file, 1 new key; fr: 1 translated');
});

// ── 0.2.10: the server's warnings reach the terminal and the agent ─────────

const ENUM_WARNING = 'Enum labels, left as written: app/Tables/ServerTable.php:31 ServerTable status (ServerStatus): app/Enums/ServerStatus.php is not in this change';
const warnings = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? ENUM_WARNING : `Left as written: resources/js/Page${i}.tsx "Text ${i}"`));

test('localize prints the server warnings once each, after the other report lines', async () => {
  loggedIn();
  const repo = helloRepo();
  const three = warnings(3);
  reset({ localizeReport: { warnings: [...three, three[0]] } });
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.stdout.endsWith(['  warnings (3):', ...three.map((w) => '    ' + w)].join('\n') + '\n'), r.stdout);
});

test('localize shows the first 10 warnings and counts the rest; no warnings, no header', async () => {
  loggedIn();
  const repo = helloRepo();
  const many = warnings(25);
  reset({ localizeReport: { warnings: many } });
  const r = await run(['localize', '--dry'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.stdout.endsWith(['  warnings (25):', ...many.slice(0, 10).map((w) => '    ' + w), '    … and 15 more'].join('\n') + '\n'), r.stdout);
  reset();
  const none = await run(['localize', '--dry'], { cwd: repo });
  assert.equal(none.code, 0, none.out);
  assert.doesNotMatch(none.stdout, /warnings \(/);
});

test('localize --hook passes the warnings to the agent', async () => {
  loggedIn();
  reset({ localizeReport: { warnings: warnings(3) } });
  const r = await run(['localize', '--hook'], { cwd: helloRepo(), input: STOP });
  assert.equal(r.code, 0, r.out);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(['  warnings (3):', ...warnings(3).map((w) => '    ' + w)].join('\n') + '\n\nLyngo has already updated'), ctx);
});

test('translate prints the server warnings of every chunk once each', async () => {
  loggedIn();
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lang', 'en.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`Key ${i}`, `Key ${i}`]))) + '\n');
  reset({ translateReport: { warnings: ['Machine text kept in the catalog: Key 3'] } });
  const r = await run(['translate', 'fr'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /fr: 130 translated, 0 from memory -> lang\/fr\.json\n {2}warnings \(1\):\n {4}Machine text kept in the catalog: Key 3\n$/);
});

// ── needs and context: the working tree's copy of what the server read from GitHub ──

const SERVER_STATUS = "<?php\n\nnamespace App\\Enums;\n\nenum ServerStatus: string\n{\n    case READY = 'ready';\n\n    public function getLabel(): string\n    {\n        return __('Ready');\n    }\n}\n";

// Hello.tsx changed; the enum committed, so only the server's "needs" sends it.
function needsRepo() {
  const repo = helloRepo();
  fs.mkdirSync(path.join(repo, 'app', 'Enums'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'app', 'Enums', 'ServerStatus.php'), SERVER_STATUS);
  g(repo, 'add', 'app/Enums/ServerStatus.php');
  g(repo, 'commit', '-q', '-m', 'enum');
  return repo;
}

const localizeCalls = () => mcpCalls().filter((c) => c.body.params.name === 'localize');

test('localize does not apply an answer with "needs": it sends the batch again with those files from disk as context, applies the second answer, and never loops', async () => {
  loggedIn();
  const repo = needsRepo();
  // Outside the repository, a symlink out of it, missing, absolute, or already in the batch: all left out.
  fs.writeFileSync(path.join(scratch, 'outside.php'), '<?php // secret\n');
  fs.symlinkSync(path.join(scratch, 'outside.php'), path.join(repo, 'app', 'Link.php'));
  fs.writeFileSync(path.join(repo, '.env'), 'APP_KEY=secret\n');
  fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'config', 'services.php'), "<?php return ['key' => 'secret'];\n");
  reset({ jobs: {}, localizeNeeds: ['app/Enums/ServerStatus.php', '.env', 'config/services.php', '../outside.php', 'app/Link.php', 'app/Missing.php', path.join(scratch, 'outside.php'), 'resources/js/Hello.tsx'], needsAgain: true });
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  const [first, second, ...more] = localizeCalls();
  assert.equal(more.length, 0, 'one retry, whatever the second answer says');
  assert.equal(first.body.params.arguments.context, undefined);
  assert.deepEqual(second.body.params.arguments.context, [{ path: 'app/Enums/ServerStatus.php', content: SERVER_STATUS }]);
  assert.deepEqual(second.body.params.arguments.files, first.body.params.arguments.files);
  assert.deepEqual(second.body.params.arguments.catalogs, first.body.params.arguments.catalogs);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), "export const Hello = () => <p>{t('Hello')}</p>;\n");
  assert.ok(!r.out.includes('secret'));
  assert.match(r.stdout, /sending 1 file the server reads from this working tree, and the batch again/);
  assert.match(r.stdout, /1 string localized in 1 file; 1 new key, 0 reused\./);
});

test('localize --hook retries a batch with "needs" the same way, without a word on the terminal', async () => {
  loggedIn();
  const repo = needsRepo();
  reset({ localizeNeeds: ['app/Enums/ServerStatus.php'] });
  const r = await run(['localize', '--hook'], { cwd: repo, input: STOP });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout).systemMessage, 'Lyngo: 1 string localized in 1 file, 1 new key');
  assert.deepEqual(localizeCalls().map((c) => c.body.params.arguments.context), [undefined, [{ path: 'app/Enums/ServerStatus.php', content: SERVER_STATUS }]]);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), "export const Hello = () => <p>{t('Hello')}</p>;\n");
});

test('localize applies an answer with "needs" when none of the needed files can be read from the repository', async () => {
  loggedIn();
  const repo = needsRepo();
  reset({ localizeNeeds: ['app/Missing.php', '../outside.php'] });
  const r = await run(['localize'], { cwd: repo });
  assert.equal(r.code, 0, r.out);
  assert.equal(localizeCalls().length, 1);
  assert.equal(fs.readFileSync(path.join(repo, 'resources', 'js', 'Hello.tsx'), 'utf8'), "export const Hello = () => <p>{t('first answer')}</p>;\n");
});
