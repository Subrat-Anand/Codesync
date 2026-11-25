import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor } from '../../server/executor.mjs';
import { loadConfig } from '../../server/config.mjs';

const limits = { ...loadConfig({}).limits, maxOutputChars: 100 };

const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function exec(fetchImpl, opts = {}) {
  return createExecutor({ url: 'http://piston.test/api/v2/piston', limits, fetchImpl, ...opts });
}

test('successful run returns stdout and timing', async () => {
  let request;
  const ex = exec(async (url, init) => {
    request = { url, body: JSON.parse(init.body), headers: init.headers };
    return { ok: true, status: 200, json: async () => ({ run: { stdout: 'hi\n', stderr: '', code: 0, signal: null, wall_time: 12.4 } }) };
  }, { apiKey: 'k' });
  const r = await ex.execute({ language: 'python', code: 'print("hi")', stdin: 'in' });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hi\n');
  assert.equal(r.timeMs, 12);
  assert.equal(request.url, 'http://piston.test/api/v2/piston/execute');
  assert.equal(request.body.language, 'python');
  assert.equal(request.body.stdin, 'in');
  assert.equal(request.body.run_timeout, limits.runTimeoutMs);
  assert.equal(request.headers.authorization, 'k');
});

test('c++ and java map to the right sandbox names and file names', async () => {
  const bodies = [];
  const ex = exec(async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ run: { stdout: '', stderr: '', code: 0 } }) };
  });
  await ex.execute({ language: 'cpp', code: 'int main(){}' });
  await ex.execute({ language: 'java', code: 'class Main{}' });
  assert.equal(bodies[0].language, 'c++');
  assert.equal(bodies[1].files[0].name, 'Main.java');
});

test('compile errors are reported separately from runtime errors', async () => {
  const ex = exec(respond(200, { compile: { code: 1, output: 'main.c:1: error: nope' }, run: { code: 0 } }));
  const r = await ex.execute({ language: 'c', code: 'oops' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'compile');
  assert.match(r.compileOutput, /error: nope/);
});

test('runtime errors surface stderr and exit code', async () => {
  const ex = exec(respond(200, { run: { stdout: '', stderr: 'Traceback…', code: 1, signal: null } }));
  const r = await ex.execute({ language: 'python', code: 'raise Exception()' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'run');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /Traceback/);
});

test('killed processes are flagged as limit exceeded', async () => {
  const ex = exec(respond(200, { run: { stdout: '', stderr: '', code: null, signal: 'SIGKILL' } }));
  const r = await ex.execute({ language: 'python', code: 'while True: pass' });
  assert.equal(r.ok, false);
  assert.equal(r.limitExceeded, true);
  assert.equal(r.signal, 'SIGKILL');
});

test('huge output is truncated', async () => {
  const ex = exec(respond(200, { run: { stdout: 'a'.repeat(5000), stderr: '', code: 0 } }));
  const r = await ex.execute({ language: 'python', code: 'x' });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 300);
});

test('refuses unsupported languages, empty and oversized code, without calling the sandbox', async () => {
  let calls = 0;
  const ex = exec(async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; });
  assert.equal((await ex.execute({ language: 'cobol', code: 'x' })).ok, false);
  assert.equal((await ex.execute({ language: 'python', code: '   ' })).ok, false);
  assert.equal((await ex.execute({ language: 'python', code: 'x'.repeat(limits.maxCodeChars + 1) })).ok, false);
  assert.equal(calls, 0);
});

test('sandbox outages produce a clear internal error', async () => {
  const down = exec(async () => { throw new TypeError('fetch failed'); });
  const r1 = await down.execute({ language: 'python', code: 'x' });
  assert.equal(r1.stage, 'internal');
  assert.match(r1.error, /Could not reach/);

  const bad = exec(respond(401, { message: 'API key required' }));
  const r2 = await bad.execute({ language: 'python', code: 'x' });
  assert.equal(r2.stage, 'internal');
  assert.match(r2.error, /HTTP 401/);
});

test('limits concurrent executions', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ex = exec(async () => { await gate; return { ok: true, status: 200, json: async () => ({ run: { code: 0, stdout: '' } }) }; });
  const pending = Array.from({ length: limits.maxConcurrentRuns }, () => ex.execute({ language: 'python', code: 'x' }));
  const rejected = await ex.execute({ language: 'python', code: 'x' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /busy/);
  release();
  await Promise.all(pending);
  assert.equal(ex.active, 0);
});
