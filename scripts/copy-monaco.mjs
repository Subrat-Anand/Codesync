// Copies Monaco's prebuilt AMD bundle into /public so the editor loads from
// the same origin (no CDN dependency, works offline / behind firewalls).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(root, 'public', 'monaco', 'vs');

if (!fs.existsSync(src)) {
  console.warn('[copy-monaco] monaco-editor not installed yet, skipping');
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log('[copy-monaco] copied Monaco to public/monaco/vs');
