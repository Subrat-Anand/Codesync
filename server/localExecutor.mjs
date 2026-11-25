// LOCAL code runner for development on your own machine (CODESYNC_EXECUTOR=local).
//
// !! NOT A SANDBOX !! Code runs as a normal child process with the same
// permissions as this server: it can read your files and use your network.
// We add a hard timeout (process tree is killed), an output cap, a scrubbed
// environment (no CODESYNC_SECRET etc.), a private temp directory and a
// concurrency limit — but nothing stops hostile code. Only use it for rooms
// with people you trust; use the Piston executor for anything public.
//
// It needs the language tools installed on this computer (node, python, gcc,
// g++, java/javac, go, ruby, php). Missing tools give a clear message.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLanguage } from '../shared/languages.mjs';

const isWin = process.platform === 'win32';
const outFile = (dir) => path.join(dir, isWin ? 'program.exe' : 'program');

const PLANS = {
  javascript: { run: { cmds: ['node'], args: ({ file }) => [file] } },
  typescript: { run: { cmds: ['node'], args: ({ file }) => ['--experimental-strip-types', '--no-warnings', file] } },
  python: {
    run: { cmds: isWin ? ['python', 'py'] : ['python3', 'python'], args: ({ file }) => [file] },
  },
  java: {
    compile: { cmds: ['javac'], args: ({ file }) => [file] },
    run: { cmds: ['java'], args: ({ dir }) => ['-cp', dir, 'Main'] },
  },
  c: {
    compile: { cmds: ['gcc', 'cc', 'clang'], args: ({ file, dir }) => [file, '-o', outFile(dir), '-lm'] },
    run: { cmds: [], args: () => [], binary: true },
  },
  cpp: {
    compile: { cmds: ['g++', 'clang++'], args: ({ file, dir }) => [file, '-o', outFile(dir)] },
    run: { cmds: [], args: () => [], binary: true },
  },
  go: { run: { cmds: ['go'], args: ({ file }) => ['run', file] } },
  ruby: { run: { cmds: ['ruby'], args: ({ file }) => [file] } },
  php: { run: { cmds: ['php'], args: ({ file }) => [file] } },
};

const ENV_KEEP = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOCACHE',
];

function scrubbedEnv() {
  const env = {};
  for (const key of ENV_KEEP) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function killTree(child) {
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Runs the first command that exists. Resolves, never rejects. */
function runProcess(cmds, args, { cwd, stdin = '', timeoutMs, maxChars }) {
  return new Promise((resolve) => {
    const attempt = (index) => {
      const cmd = cmds[index];
      let child;
      try {
        child = spawn(cmd, args, {
          cwd, env: scrubbedEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWin,
        });
      } catch (err) {
        resolve({ missing: true, cmd, error: err.message });
        return;
      }

      let settled = false;
      let timedOut = false;
      let truncated = false;
      let stdout = '';
      let stderr = '';
      const started = Date.now();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, stdout, stderr, truncated, timedOut, wallMs: Date.now() - started });
      };
      const collect = (which) => (chunk) => {
        const room = maxChars - (which === 'out' ? stdout.length : stderr.length);
        const text = chunk.toString('utf8');
        if (text.length > room) {
          truncated = true;
          if (which === 'out') stdout += text.slice(0, Math.max(room, 0));
          else stderr += text.slice(0, Math.max(room, 0));
          killTree(child);
        } else if (which === 'out') stdout += text;
        else stderr += text;
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);

      child.stdout.on('data', collect('out'));
      child.stderr.on('data', collect('err'));
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      child.on('error', (err) => {
        if (err.code === 'ENOENT' && index + 1 < cmds.length) {
          settled = true;
          clearTimeout(timer);
          attempt(index + 1);
          return;
        }
        finish({ missing: err.code === 'ENOENT', cmd, error: err.message, code: null, signal: null });
      });
      child.on('close', (code, signal) => finish({ code, signal }));
    };
    attempt(0);
  });
}

const notInstalled = (spec, cmds) =>
  `${spec.label} is not installed on this computer (looked for: ${cmds.join(', ')}). Install it and restart CodeSync, or use the Piston executor.`;

export function createLocalExecutor({ limits }) {
  let active = 0;
  const fail = (error, timeMs = 0) => ({ ok: false, stage: 'internal', error, stdout: '', stderr: '', timeMs });

  return {
    mode: 'local',
    get active() {
      return active;
    },

    async execute({ language, code, stdin = '' }) {
      const spec = getLanguage(language);
      if (!spec) return fail('Unsupported language');
      const plan = PLANS[spec.id];
      if (!plan) return fail(`${spec.label} cannot be run by the local executor. Use the Piston executor for it.`);
      if (typeof code !== 'string' || code.trim() === '') return fail('There is no code to run');
      if (code.length > limits.maxCodeChars) return fail('Code is too large to run');
      if (active >= limits.maxConcurrentRuns) return fail('The execution service is busy, try again in a moment');

      active += 1;
      const started = Date.now();
      let dir;
      try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesync-run-'));
        const file = path.join(dir, spec.file);
        await fs.writeFile(file, code, 'utf8');
        const ctx = { file, dir };
        const maxChars = limits.maxOutputChars;

        if (plan.compile) {
          const c = await runProcess(plan.compile.cmds, plan.compile.args(ctx), {
            cwd: dir, timeoutMs: limits.compileTimeoutMs, maxChars,
          });
          if (c.missing) return fail(notInstalled(spec, plan.compile.cmds), Date.now() - started);
          if (c.timedOut) {
            return { ok: false, stage: 'compile', stdout: '', stderr: '', compileOutput: 'Compilation timed out', exitCode: null, timeMs: Date.now() - started };
          }
          if (c.code !== 0) {
            return {
              ok: false, stage: 'compile', stdout: '', stderr: '',
              compileOutput: (c.stderr || c.stdout || 'Compilation failed').trim(),
              exitCode: c.code, timeMs: Date.now() - started, truncated: c.truncated,
            };
          }
        }

        const cmds = plan.run.binary ? [outFile(dir)] : plan.run.cmds;
        const r = await runProcess(cmds, plan.run.args(ctx), {
          cwd: dir, stdin: String(stdin ?? '').slice(0, limits.maxStdinChars),
          timeoutMs: limits.runTimeoutMs, maxChars,
        });
        if (r.missing) return fail(notInstalled(spec, cmds), Date.now() - started);

        const limitExceeded = r.timedOut || r.truncated;
        let stderr = r.stderr;
        if (r.timedOut) stderr += `${stderr ? '\n' : ''}Time limit exceeded (${Math.round(limits.runTimeoutMs / 1000)}s)`;
        else if (r.truncated) stderr += `${stderr ? '\n' : ''}Output limit exceeded, program stopped`;
        return {
          ok: r.code === 0 && !limitExceeded,
          stage: 'run',
          stdout: r.stdout,
          stderr,
          exitCode: r.code,
          signal: limitExceeded ? 'SIGKILL' : r.signal,
          limitExceeded,
          timeMs: r.wallMs,
          truncated: r.truncated,
        };
      } catch (err) {
        return fail(`Local execution failed: ${err.message}`, Date.now() - started);
      } finally {
        active -= 1;
        if (dir) fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
