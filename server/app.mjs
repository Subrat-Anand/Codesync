// Assembles store + services + REST + WebSocket hub into one http.Server.
// Kept free of any Next.js import so it can be started in tests.
import http from 'node:http';
import { openStore } from './store.mjs';
import { loadSecret } from './auth.mjs';
import { RoomService } from './rooms.mjs';
import { Hub } from './hub.mjs';
import { createExecutor } from './executor.mjs';
import { createLocalExecutor } from './localExecutor.mjs';
import { createApiHandler } from './api.mjs';

/**
 * @param {{config: ReturnType<import('./config.mjs').loadConfig>,
 *          executor?: {execute: Function},
 *          fallback?: (req, res) => void}} options
 */
export function createApp({ config, executor, fallback }) {
  const store = openStore(config.dbFile);
  const secret = loadSecret(store, config.secret);
  const rooms = new RoomService(store, { secret, limits: config.limits });
  const exec = executor
    ?? (config.executorMode === 'local'
      ? createLocalExecutor({ limits: config.limits })
      : createExecutor({ url: config.piston.url, apiKey: config.piston.apiKey, limits: config.limits }));
  const hub = new Hub({
    store,
    rooms,
    executor: exec,
    limits: config.limits,
    allowedOrigins: config.allowedOrigins,
    log: (...args) => console.error('[hub]', ...args),
  });
  const api = createApiHandler({ rooms, hub, trustProxy: config.trustProxy });

  const server = http.createServer((req, res) => {
    api(req, res)
      .then((handled) => {
        if (handled) return;
        if (fallback) fallback(req, res);
        else {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
        }
      })
      .catch((err) => {
        console.error('[http] unhandled', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  // Intercept only our own WebSocket path. Everything else (e.g. Next.js dev
  // HMR) keeps flowing to whatever other 'upgrade' listeners exist, and Next
  // never sees — and therefore cannot close — CodeSync sockets.
  // Node only treats a request as an upgrade when at least one real 'upgrade'
  // listener exists (otherwise it is served as a normal HTTP request, which
  // is what produced 404s). This listener only fires for non-/ws/ paths, and
  // closes the socket unless another listener (Next.js HMR) is registered.
  server.on('upgrade', (req, socket) => {
    if (server.listenerCount('upgrade') <= 1) socket.destroy();
  });

  const originalEmit = server.emit.bind(server);
  server.emit = (event, ...args) => {
    if (event === 'upgrade') {
      const [req, socket, head] = args;
      if ((req.url || '').startsWith('/ws/')) {
        hub.handleUpgrade(req, socket, head);
        return true;
      }
    }
    return originalEmit(event, ...args);
  };

  return {
    server,
    store,
    rooms,
    hub,
    listen: (port = config.port, host = config.host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    async close() {
      await hub.shutdown();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
