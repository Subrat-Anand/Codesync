import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createLocalExecutor } from '../../server/localExecutor.mjs';

const limits = {
  maxCodeChars: 10_000, maxStdinChars: 1000, maxOutputChars: 2000,
  runTimeoutMs: 1500, compileTimeoutMs: 10_000, maxConcurrentRuns: 4,
};
const has = (cmd) => !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;
const ex = createLocalExecutor({ limits });

test('runs JavaScript with stdin and reports timing', async () => {
  const r = await ex.execute({
    language: 'javascript',
    code: "process.stdin.on('data', d => console.log('got ' + d.toString().trim()));",
    stdin: 'hello',
  });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), 'got hello');
  assert.equal(typeof r.timeMs, 'number');
});

test('runtime errors surface stderr and a non-zero exit code', async () => {
  const r = await ex.execute({ language: 'javascript', code: "throw new Error('boom')" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /boom/);
  assert.notEqual(r.exitCode, 0);
});

test('infinite loops are killed at the time limit', async () => {
  const r = await ex.execute({ language: 'javascript', code: 'while (true) {}' });
  assert.equal(r.ok, false);
  assert.equal(r.limitExceeded, true);
  assert.match(r.stderr, /Time limit/);
});

test('runaway output is capped and the process stopped', async () => {
  const r = await ex.execute({ language: 'javascript', code: "while (true) console.log('x'.repeat(500))" });
  assert.equal(r.limitExceeded, true);
  assert.ok(r.stdout.length <= limits.maxOutputChars);
});

test('the server environment is not visible to user code', async () => {
  process.env.CODESYNC_SECRET = 'top-secret-value';
  const r = await ex.execute({ language: 'javascript', code: 'console.log(process.env.CODESYNC_SECRET ?? "hidden")' });
  assert.equal(r.stdout.trim(), 'hidden');
});

test('C compile errors are reported as compile errors', { skip: !has('gcc') }, async () => {
  const r = await ex.execute({ language: 'c', code: 'int main( { return 0 }' });
  assert.equal(r.stage, 'compile');
  assert.ok(r.compileOutput.length > 0);
});

test('C programs compile and run', { skip: !has('gcc') }, async () => {
  const r = await ex.execute({ language: 'c', code: '#include <stdio.h>\nint main(){puts("hi");return 0;}' });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.trim(), 'hi');
});

test('Python runs when installed', { skip: !(has('python3') || has('python')) }, async () => {
  const r = await ex.execute({ language: 'python', code: 'print(1+2)' });
  assert.equal(r.stdout.trim(), '3');
});

test('missing tools and unsupported languages give clear messages', async () => {
  const r = await ex.execute({ language: 'rust', code: 'fn main(){}' });
  assert.equal(r.stage, 'internal');
  assert.match(r.error, /cannot be run/);
  const empty = await ex.execute({ language: 'javascript', code: '   ' });
  assert.match(empty.error, /no code/);
});
