// Tiny JSON-file persistence layer. Metadata lives in db.json; large blobs
// (extracted page text, generated outputs, quizzes, chats) live in their own files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const DB_FILE = path.join(config.dataDir, 'db.json');
const DIRS = {
  units: path.join(config.dataDir, 'units'),
  outputs: path.join(config.dataDir, 'outputs'),
  quizzes: path.join(config.dataDir, 'quizzes'),
  chats: path.join(config.dataDir, 'chats'),
  files: path.join(config.dataDir, 'files'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const now = () => new Date().toISOString();

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

let db = { workspaces: {}, sources: {}, outputs: {}, quizzes: {}, chats: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (err) {
    console.error('[store] db.json is unreadable; starting fresh (old file kept as db.json.bak)', err.message);
    fs.copyFileSync(DB_FILE, `${DB_FILE}.bak`);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    atomicWrite(DB_FILE, JSON.stringify(db, null, 1));
  }, 50);
}
export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  atomicWrite(DB_FILE, JSON.stringify(db, null, 1));
}
process.on('exit', () => { try { flush(); } catch { /* ignore */ } });

// ---------- generic collection helpers ----------
function collection(name) {
  return {
    all: () => Object.values(db[name]),
    get: (id) => db[name][id] || null,
    put: (obj) => {
      obj.updatedAt = now();
      db[name][obj.id] = obj;
      scheduleSave();
      return obj;
    },
    patch: (id, fields) => {
      const cur = db[name][id];
      if (!cur) return null;
      Object.assign(cur, fields, { updatedAt: now() });
      scheduleSave();
      return cur;
    },
    remove: (id) => {
      delete db[name][id];
      scheduleSave();
    },
  };
}

export const workspaces = collection('workspaces');
export const sources = collection('sources');
export const outputs = collection('outputs');
export const quizzes = collection('quizzes');
export const chats = collection('chats');

// ---------- blob helpers ----------
function blobPath(kind, id) {
  if (!/^[a-z]+_[a-f0-9]+$/.test(id)) throw new Error(`Invalid id: ${id}`);
  return path.join(DIRS[kind], `${id}.json`);
}
export function readBlob(kind, id, fallback = null) {
  const p = blobPath(kind, id);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export function writeBlob(kind, id, value) {
  atomicWrite(blobPath(kind, id), JSON.stringify(value));
}
export function deleteBlob(kind, id) {
  const p = blobPath(kind, id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Units (extracted pages/slides/chapters) for a source.
export const getUnits = (sourceId) => readBlob('units', sourceId, []);
export const setUnits = (sourceId, units) => writeBlob('units', sourceId, units);

// Original uploaded files, kept so scanned pages can be OCR'd again later.
export function sourceFileDir(sourceId) {
  if (!/^[a-z]+_[a-f0-9]+$/.test(sourceId)) throw new Error('Invalid source id');
  const dir = path.join(DIRS.files, sourceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function removeSourceFiles(sourceId) {
  const dir = path.join(DIRS.files, sourceId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
