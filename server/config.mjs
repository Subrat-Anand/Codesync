import path from 'node:path';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// CODESYNC_EXECUTOR=piston|local. Default: 'local' in development (so Run works
// out of the box on your own machine, see server/localExecutor.mjs for the
// safety caveats) and 'piston' (sandboxed) in production.
export function loadConfig(env = process.env) {
  const defaultMode = env.NODE_ENV === 'production' ? 'piston' : 'local';
  const mode = ['piston', 'local'].includes(env.CODESYNC_EXECUTOR) ? env.CODESYNC_EXECUTOR : defaultMode;
  return {
    executorMode: mode,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dbFile: env.CODESYNC_DB || path.join(process.cwd(), 'data', 'codesync.db'),
    secret: env.CODESYNC_SECRET || null,
    trustProxy: env.TRUST_PROXY === '1',
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    piston: {
      url: (env.PISTON_URL || 'http://localhost:2000/api/v2/piston').replace(/\/+$/, ''),
      apiKey: env.PISTON_API_KEY || '',
    },
    limits: {
      maxParticipantsPerRoom: 50,
      maxPendingPerRoom: 25,
      maxCodeChars: 200_000,
      maxStdinChars: 16_384,
      maxOutputChars: 65_536,
      runTimeoutMs: 3_000,
      compileTimeoutMs: 10_000,
      memoryBytes: 256 * 1024 * 1024,
      runCooldownMs: 2_000,
      maxConcurrentRuns: 4,
      wsMaxPayload: 1024 * 1024,
      wsMessagesPerSecond: 300,
      tokenTtlSeconds: 7 * 24 * 3600,
    },
  };
}
