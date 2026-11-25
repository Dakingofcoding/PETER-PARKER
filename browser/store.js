// Browser replacement for server/store.js: same API, kept in memory and saved to IndexedDB.
import { getAll, putMany } from './idb.js';

export const newId = (prefix) => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
export const now = () => new Date().toISOString();

let db = { workspaces: {}, sources: {}, outputs: {}, quizzes: {}, chats: {} };
const blobs = new Map(); // 'kind/id' -> value
export const files = new Map(); // path -> Uint8Array
const dirty = new Set();
const deleted = new Set();
let timer = null;
let storageWarned = false;

function schedule(key) {
  dirty.add(key);
  deleted.delete(key);
  if (!timer) timer = setTimeout(flush, 300);
}
function scheduleDelete(key) {
  dirty.delete(key);
  deleted.add(key);
  if (!timer) timer = setTimeout(flush, 300);
}
export async function flush() {
  timer = null;
  const entries = [];
  for (const k of dirty) {
    if (k === 'db') entries.push(['db', JSON.parse(JSON.stringify(db))]);
    else if (k.startsWith('blob:')) entries.push([k, blobs.get(k.slice(5))]);
    else if (k.startsWith('file:')) entries.push([k, files.get(k.slice(5))]);
  }
  const dels = [...deleted];
  dirty.clear();
  deleted.clear();
  try {
    await putMany(entries, dels);
  } catch (err) {
    console.error('[store] could not save to browser storage', err);
    if (!storageWarned) {
      storageWarned = true;
      alert('Peter Parker Study could not save to this browser’s storage (it may be full or in private mode). Your work will be lost when you close the page.');
    }
  }
}
addEventListener('pagehide', () => flush());

export async function initStore() {
  try {
    const all = await getAll();
    for (const [k, v] of all) {
      if (k === 'db') db = { ...db, ...v };
      else if (k.startsWith('blob:')) blobs.set(k.slice(5), v);
      else if (k.startsWith('file:')) files.set(k.slice(5), v);
    }
  } catch (err) {
    console.warn('[store] IndexedDB unavailable; data will not persist', err);
  }
}

function collection(name) {
  return {
    all: () => Object.values(db[name]),
    get: (id) => db[name][id] || null,
    put: (obj) => {
      obj.updatedAt = now();
      db[name][obj.id] = obj;
      schedule('db');
      return obj;
    },
    patch: (id, fields) => {
      const cur = db[name][id];
      if (!cur) return null;
      Object.assign(cur, fields, { updatedAt: now() });
      schedule('db');
      return cur;
    },
    remove: (id) => {
      delete db[name][id];
      schedule('db');
    },
  };
}
export const workspaces = collection('workspaces');
export const sources = collection('sources');
export const outputs = collection('outputs');
export const quizzes = collection('quizzes');
export const chats = collection('chats');

const clone = (v) => (v === undefined || v === null ? v : structuredClone(v));
export function readBlob(kind, id, fallback = null) {
  const v = blobs.get(`${kind}/${id}`);
  return v === undefined ? fallback : clone(v);
}
export function writeBlob(kind, id, value) {
  blobs.set(`${kind}/${id}`, clone(value));
  schedule(`blob:${kind}/${id}`);
}
export function deleteBlob(kind, id) {
  blobs.delete(`${kind}/${id}`);
  scheduleDelete(`blob:${kind}/${id}`);
}
export const getUnits = (sourceId) => readBlob('units', sourceId, []);
export const setUnits = (sourceId, units) => writeBlob('units', sourceId, units);

export function sourceFileDir(sourceId) {
  return `/files/${sourceId}`;
}
export function writeFile(p, data) {
  files.set(p, new Uint8Array(data));
  schedule(`file:${p}`);
}
export function removeSourceFiles(sourceId) {
  for (const p of [...files.keys()]) {
    if (p.startsWith(`/files/${sourceId}/`)) {
      files.delete(p);
      scheduleDelete(`file:${p}`);
    }
  }
}
