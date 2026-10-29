import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../bin/402mob.js', import.meta.url));
const ticket = '12345678-1234-4123-8123-123456789abc';
const key = 'test-merchant-secret';

async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    if (handler) return handler(req, res, calls.at(-1));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ticket: {}, items: [], nextCursor: null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

function run(args, { url, input = '', env = {} }) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    for (const name of ['MOB402_API_KEY', 'MOB402_BASE_URL', '402MOB_API_KEY', '402MOB_BASE_URL']) delete environment[name];
    const child = spawn(process.execPath, [executable, ...args], {
      env: { ...environment, MOB402_BASE_URL: url, MOB402_API_KEY: key, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI hung')); }, 5000);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function resultFile(t, contents) {
  const dir = await mkdtemp(join(tmpdir(), '402mob-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'result');
  await writeFile(path, contents);
  return path;
}

test('shell-compatible credentials reach seller calls and never public reads', async t => {
  const f = await fixture(t);
  assert.equal((await run(['work', 'show', ticket], f)).code, 0);
  assert.equal(f.calls[0].auth, `Bearer ${key}`);
  assert.equal((await run(['work', 'status', ticket], f)).code, 0);
  assert.equal(f.calls[1].auth, undefined);
  const result = await run(['merchant', 'show'], { ...f, env: { MOB402_API_KEY: '   ' } });
  assert.equal(result.code, 2);
  assert.equal(f.calls.length, 2);
});

test('duplicate options and prototype names fail before making a request', async t => {
  const f = await fixture(t);
  for (const args of [
    ['resources', 'search', '--query', 'first', '--query=second'],
    ['resources', 'search', '--__proto__=x'],
    ['resources', 'search', '--constructor=x'],
    ['work', 'quote', ticket, '--price-usdc', '0.05', '--deliverable', 'report', '--content-type', 'constructor'],
    ['work', 'list', '--states', 'open,'],
    ['sales', 'list', '--limit', '101'],
  ]) {
    const result = await run(args, f);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error);
  }
  assert.equal(f.calls.length, 0);
});

test('help-like option values remain data', async t => {
  const f = await fixture(t);
  const result = await run(['resources', 'search', '--query', '-h'], f);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).items, []);
  assert.equal(new URL(f.calls[0].url, f.url).searchParams.get('q'), '-h');
  const help = await run(['work', 'quote', '--help'], f);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(f.calls.length, 1);
});

test('malformed private JSON never leaks its content in errors', async t => {
  const f = await fixture(t);
  const path = await resultFile(t, 'PRIVATE_RESULT_SECRET is not JSON');
  const result = await run(['work', 'deliver', ticket, '--content-type', 'json', '--result-file', path], f);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RESULT_SECRET/);
  assert.equal(f.calls.length, 0);
});

test('invalid UTF-8, nonfinite JSON, and oversized results are rejected', async t => {
  const f = await fixture(t);
  for (const [contents, type] of [[Buffer.from([0xff]), 'text'], ['{"n":1e400}', 'json'], ['x'.repeat(48 * 1024 + 1), 'text']]) {
    const path = await resultFile(t, contents);
    const result = await run(['work', 'deliver', ticket, '--content-type', type, '--result-file', path], f);
    assert.equal(result.code, 2);
  }
  assert.equal(f.calls.length, 0);
});

test('valid result is submitted once with matching content type and credentials', async t => {
  const f = await fixture(t);
  const path = await resultFile(t, '{"summary":"done"}\n');
  const result = await run(['work', 'deliver', ticket, '--content-type', 'json', '--result-file', path], f);
  assert.equal(result.code, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { contentType: 'application/json', result: { summary: 'done' } });
  assert.equal(f.calls[0].auth, `Bearer ${key}`);
});

test('signature stdin is validated and bounded before submission', async t => {
  const f = await fixture(t);
  const args = ['enrollment', 'complete-signature', '--wallet', '0x' + 'a'.repeat(40), '--name', 'Agent', '--challenge-id', ticket, '--signature-stdin'];
  for (const input of ['', 'private-key-or-junk', 'x'.repeat(5000)]) {
    const result = await run(args, { ...f, input });
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /private-key-or-junk/);
  }
  assert.equal(f.calls.length, 0);
});

test('HTTP failure has a stable exit code and JSON HTTP status', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden', message: 'Denied' }));
  });
  const result = await run(['work', 'show', ticket], f);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).status, 403);
  assert.doesNotMatch(result.stderr, new RegExp(key));
});

test('dropped mutation response is reported as uncertain without retrying', async t => {
  const f = await fixture(t, (req) => req.socket.destroy());
  const result = await run(['work', 'claim', ticket], f);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).message, /may have completed/);
  assert.equal(f.calls.length, 1);
});


test('a named pipe result fails without waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), '402mob-cli-fifo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pipe');
  execFileSync('mkfifo', [path]);
  const result = await run(['work', 'deliver', ticket, '--content-type', 'text', '--result-file', path], f);
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stderr).message, /regular file/);
  assert.equal(f.calls.length, 0);
});
