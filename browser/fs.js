// Tiny synchronous fs stand-in backed by the browser store.
import { files, writeFile } from './store.js';
const norm = (p) => String(p).replace(/\/+/g, '/');
export function writeFileSync(p, data) {
  writeFile(norm(p), data);
}
export function readFileSync(p) {
  const v = files.get(norm(p));
  if (!v) throw new Error(`File not found: ${p}`);
  return globalThis.Buffer.from(v);
}
export function existsSync(p) {
  return files.has(norm(p));
}
export function mkdirSync() {}
export function rmSync() {}
export function unlinkSync() {}
export default { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, unlinkSync };
