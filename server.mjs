// Production/dev entry point: Next.js UI + REST API + WebSocket on one port.
//   npm run dev     -> node server.mjs --dev
//   npm run build && npm start
import { loadConfig } from './server/config.mjs';
import { createApp } from './server/app.mjs';

const dev = process.argv.includes('--dev');
try { process.loadEnvFile('.env'); } catch { /* no .env file: use defaults */ }
process.env.NODE_ENV ||= dev ? 'development' : 'production';

const config = loadConfig();
const { default: next } = await import('next');
const nextApp = next({ dev, hostname: config.host === '0.0.0.0' ? 'localhost' : config.host, port: config.port });
const handle = nextApp.getRequestHandler();
await nextApp.prepare();

const app = createApp({ config, fallback: (req, res) => handle(req, res) });
const address = await app.listen();
console.log(`CodeSync ready on http://localhost:${address.port} (${dev ? 'development' : 'production'})`);
if (config.executorMode === 'local') {
  console.log('Code execution: LOCAL runner (runs code on this computer, not sandboxed). Needs node/python/gcc/java installed. Only use with people you trust.');
} else {
  console.log(`Code execution: Piston sandbox at ${config.piston.url}`);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received, flushing rooms and shutting down…`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
