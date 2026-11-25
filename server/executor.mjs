// Code execution through a Piston-compatible sandbox API. User code is NEVER
// run inside this process: it is sent to an isolated execution service which
// enforces time, memory and process limits. We add our own limits on top
// (code/stdin size, output size, concurrency, per-room cooldown).
import { getLanguage } from '../shared/languages.mjs';

function truncate(text, max) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n… output truncated (${s.length - max} more characters)`, truncated: true };
}

/**
 * @param {{url: string, apiKey?: string, limits: object, fetchImpl?: typeof fetch, now?: () => number}} opts
 */
export function createExecutor({ url, apiKey = '', limits, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  let active = 0;

  return {
    get active() {
      return active;
    },

    async execute({ language, code, stdin = '' }) {
      const spec = getLanguage(language);
      if (!spec) return { ok: false, stage: 'internal', error: 'Unsupported language', stdout: '', stderr: '', timeMs: 0 };
      if (typeof code !== 'string' || code.trim() === '') {
        return { ok: false, stage: 'internal', error: 'There is no code to run', stdout: '', stderr: '', timeMs: 0 };
      }
      if (code.length > limits.maxCodeChars) {
        return { ok: false, stage: 'internal', error: 'Code is too large to run', stdout: '', stderr: '', timeMs: 0 };
      }
      if (active >= limits.maxConcurrentRuns) {
        return { ok: false, stage: 'internal', error: 'The execution service is busy, try again in a moment', stdout: '', stderr: '', timeMs: 0 };
      }

      const input = String(stdin ?? '').slice(0, limits.maxStdinChars);
      const started = now();
      active += 1;
      try {
        const headers = { 'content-type': 'application/json' };
        if (apiKey) headers.authorization = apiKey;
        const res = await fetchImpl(`${url}/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            language: spec.piston,
            version: '*',
            files: [{ name: spec.file, content: code }],
            stdin: input,
            compile_timeout: limits.compileTimeoutMs,
            run_timeout: limits.runTimeoutMs,
            compile_memory_limit: limits.memoryBytes,
            run_memory_limit: limits.memoryBytes,
          }),
          signal: AbortSignal.timeout(limits.compileTimeoutMs + limits.runTimeoutMs + 5_000),
        });

        let data = null;
        try {
          data = await res.json();
        } catch {
          /* handled below */
        }
        const elapsed = now() - started;

        if (!res.ok || !data) {
          const detail = data?.message ? `: ${data.message}` : '';
          return {
            ok: false, stage: 'internal', stdout: '', stderr: '', timeMs: elapsed,
            error: `Execution service error (HTTP ${res.status})${detail}`,
          };
        }

        const compile = data.compile;
        if (compile && compile.code !== 0 && compile.code !== undefined && compile.code !== null) {
          const out = truncate(compile.output || compile.stderr || compile.stdout || 'Compilation failed', limits.maxOutputChars);
          return {
            ok: false, stage: 'compile', stdout: '', stderr: '', compileOutput: out.text,
            exitCode: compile.code, timeMs: elapsed, truncated: out.truncated,
          };
        }

        const run = data.run || {};
        const stdout = truncate(run.stdout, limits.maxOutputChars);
        const stderr = truncate(run.stderr, limits.maxOutputChars);
        const killed = typeof run.signal === 'string' && run.signal.length > 0;
        const wall = typeof run.wall_time === 'number' ? Math.round(run.wall_time) : elapsed;
        return {
          ok: run.code === 0 && !killed,
          stage: 'run',
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: run.code ?? null,
          signal: killed ? run.signal : null,
          limitExceeded: killed,
          timeMs: wall,
          truncated: stdout.truncated || stderr.truncated,
        };
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return {
          ok: false, stage: 'internal', stdout: '', stderr: '', timeMs: now() - started,
          error: timedOut
            ? 'The execution service did not respond in time'
            : 'Could not reach the execution service. Check PISTON_URL.',
        };
      } finally {
        active -= 1;
      }
    },
  };
}
