// HTTP API + static front end.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { marked } from 'marked';
import { config, ROOT, aiConfigured } from './config.js';
import * as store from './store.js';
import { startJob, getJob, activeJobFor } from './jobs.js';
import { aiAvailable, UserFacingError, translateError, setClientForTests } from './ai.js';
import { extractFile, SUPPORTED_EXTENSIONS, ocrPdfPages } from './extract/index.js';
import { extractPlainText } from './extract/text.js';
import { analyseNumbering } from './extract/numbering.js';
import { resolveSelection, computeStatus, normalizeSelection, STATUS_LABELS, UNIT_NAMES, refOf } from './selection.js';
import { buildMaterial, materialMeta, verifyCitations, compressKeys, describeSelection } from './material.js';
import { identifyBook, researchBook, mergeUnits } from './research/index.js';
import { generateDocument } from './modes/generate.js';
import { DETAIL_LEVELS, MODE_LABELS, levelOf } from './prompts.js';
import { generateQuiz, analyseTopics, publicQuiz, quickMark, markWithAI, streamExplanation, computeResults } from './modes/quiz.js';
import { tutorReply, openingMessage, QUICK_ACTIONS, TUTOR_LEVELS } from './modes/tutor.js';
import { offlineSummary, offlineQuiz } from './modes/offline.js';

if (process.env.TEST_FAKE_AI_MODULE) {
  // Automated tests only: swap in a scripted fake of the Anthropic client.
  const mod = await import(path.resolve(process.env.TEST_FAKE_AI_MODULE));
  setClientForTests(mod.default);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

// ------------------------------------------------------------------ helpers

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    next(err);
  }
};
const notFound = (what) => new UserFacingError(`${what} not found`, { status: 404, code: 'not_found' });
const bad = (msg) => new UserFacingError(msg, { status: 400, code: 'bad_request' });

function getWorkspace(id) {
  const ws = store.workspaces.get(id);
  if (!ws) throw notFound('Workspace');
  return ws;
}
function getSource(id) {
  const s = store.sources.get(id);
  if (!s) throw notFound('Source');
  return s;
}

function orderedSources(ws) {
  const all = store.sources.all().filter((s) => s.workspaceId === ws.id);
  const order = ws.sourceOrder || [];
  return all.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.createdAt.localeCompare(b.createdAt);
  });
}

function sourceStats(units) {
  return {
    units: units.length,
    readable: units.filter((u) => u.text && (u.status === 'ok' || u.status === 'ocr')).length,
    ocr: units.filter((u) => u.status === 'ocr').length,
    unreadable: units.filter((u) => u.status === 'unreadable' || u.status === 'needs_ocr').length,
    ocrPending: units.filter((u) => u.ocrPending).length,
    labelled: units.filter((u) => u.label).length,
    chars: units.reduce((s, u) => s + (u.text?.length || 0), 0),
  };
}

function publicSource(s, { withUnits = false } = {}) {
  const units = store.getUnits(s.id);
  const job = activeJobFor(s.id);
  const resolved = resolveSelection(s, units);
  const status = computeStatus(s, units, resolved, { busy: Boolean(job) });
  const names = UNIT_NAMES[s.unitType || 'page'];
  const out = {
    id: s.id,
    workspaceId: s.workspaceId,
    kind: s.kind,
    title: s.title,
    query: s.query || null,
    identity: s.identity || null,
    candidates: s.identity ? undefined : s.candidates || [],
    unitType: s.unitType || 'page',
    unitNames: names,
    numbering: s.numbering || null,
    chapters: s.chapters || [],
    selection: normalizeSelection(s, s.selection),
    included: s.included !== false,
    status,
    statusLabel: STATUS_LABELS[status],
    research: s.research || null,
    files: s.files || [],
    completeText: Boolean(s.completeText),
    report: s.report || null,
    stats: sourceStats(units),
    resolved: {
      requested: resolved.requested,
      included: resolved.included.length,
      missing: compressKeys(resolved.missing),
      missingCount: resolved.missing.length,
      unreadable: compressKeys(resolved.unreadable),
      unreadableCount: resolved.unreadable.length,
      excluded: compressKeys(resolved.excluded),
      excludedCount: resolved.excluded.length,
      errors: resolved.errors,
      description: describeSelection(s, resolved),
    },
    job: job ? { id: job.id, type: job.type } : null,
    error: s.error || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (withUnits) {
    out.units = units.map((u) => ({
      n: u.n,
      label: u.label,
      labelSource: u.labelSource || null,
      title: u.title,
      status: u.status,
      chars: u.text?.length || 0,
      note: u.note || null,
      origin: u.origin ? { kind: u.origin.kind, name: u.origin.name || u.origin.file || null, url: u.origin.url || null } : null,
    }));
  }
  return out;
}

function workspaceSummary(ws) {
  const srcs = orderedSources(ws);
  return {
    id: ws.id,
    title: ws.title,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    sourceCount: srcs.length,
    sources: srcs.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
    outputCount: store.outputs.all().filter((o) => o.workspaceId === ws.id).length,
    quizCount: store.quizzes.all().filter((q) => q.workspaceId === ws.id).length,
  };
}

/** Resolve the sources for a task (explicit ids or the workspace's included ones), in workspace order. */
function taskSources(ws, sourceIds) {
  const all = orderedSources(ws);
  const chosen = Array.isArray(sourceIds) && sourceIds.length ? all.filter((s) => sourceIds.includes(s.id)) : all.filter((s) => s.included !== false);
  if (!chosen.length) throw bad('Select at least one book or document for this task.');
  for (const s of chosen) if (activeJobFor(s.id)) throw bad(`"${s.title}" is still being processed. Wait for it to finish.`);
  const material = buildMaterial(chosen);
  if (!material.totalBlocks) {
    throw bad('None of the selected pages have readable content yet. Check the page selection, research the book, or upload the material.');
  }
  return { chosen, material };
}

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const timer = setInterval(() => res.write(': ping\n\n'), 15000);
  let closed = false;
  res.on('close', () => {
    closed = true;
    clearInterval(timer);
  });
  return {
    send: (obj) => {
      if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    end: () => {
      clearInterval(timer);
      if (!closed) res.end();
    },
  };
}

async function sseRun(res, fn) {
  const stream = sseStart(res);
  try {
    await fn(stream.send);
  } catch (err) {
    const e = translateError(err);
    console.error('[sse]', err);
    stream.send({ type: 'error', message: e.userMessage, code: e.code });
  } finally {
    stream.end();
  }
}

// ------------------------------------------------------------------ status

app.get('/api/status', (req, res) => {
  res.json({
    ai: aiAvailable(),
    aiKeyConfigured: aiConfigured(),
    model: config.model,
    refusalFallback: config.refusalFallback,
    webResearch: aiAvailable(),
    ocr: aiAvailable(),
    catalogs: ['Open Library', 'Google Books', 'Project Gutenberg'],
    googleBooksKey: Boolean(config.googleBooksKey),
    supportedExtensions: SUPPORTED_EXTENSIONS,
    maxUploadMB: Math.round(config.maxUploadBytes / 1024 / 1024),
    singlePassMaxChars: config.singlePassMaxChars,
    detailLevels: Object.values(DETAIL_LEVELS).map((l) => ({ key: l.key, name: l.name, short: l.short })),
    modes: MODE_LABELS,
    tutorLevels: Object.keys(TUTOR_LEVELS),
    quickActions: Object.keys(QUICK_ACTIONS),
  });
});

// ------------------------------------------------------------------ workspaces

app.get('/api/workspaces', (req, res) => {
  res.json(store.workspaces.all().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(workspaceSummary));
});

app.post('/api/workspaces', (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 120) || 'My study session';
  const ws = store.workspaces.put({ id: store.newId('ws'), title, sourceOrder: [], createdAt: store.now() });
  res.status(201).json(workspaceSummary(ws));
});

app.get('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  res.json({
    ...workspaceSummary(ws),
    sources: orderedSources(ws).map((s) => publicSource(s)),
    outputs: store.outputs.all().filter((o) => o.workspaceId === ws.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    quizzes: store.quizzes.all().filter((q) => q.workspaceId === ws.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((q) => ({ id: q.id, title: q.title, status: q.status, createdAt: q.createdAt, results: q.results ? { percent: q.results.percent, score: q.results.score, total: q.results.total } : null, count: q.questions.length })),
    chats: store.chats.all().filter((c) => c.workspaceId === ws.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => ({ id: c.id, kind: c.kind, title: c.title, updatedAt: c.updatedAt, messages: c.messages.length })),
    lastSettings: ws.lastSettings || null,
  });
}));

app.patch('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const patch = {};
  if (typeof req.body.title === 'string') patch.title = req.body.title.trim().slice(0, 120) || ws.title;
  if (Array.isArray(req.body.sourceOrder)) patch.sourceOrder = req.body.sourceOrder.filter((id) => store.sources.get(id)?.workspaceId === ws.id);
  if (req.body.lastSettings && typeof req.body.lastSettings === 'object') patch.lastSettings = req.body.lastSettings;
  store.workspaces.patch(ws.id, patch);
  res.json(workspaceSummary(store.workspaces.get(ws.id)));
}));

app.delete('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  for (const s of store.sources.all().filter((x) => x.workspaceId === ws.id)) {
    store.deleteBlob('units', s.id);
    store.removeSourceFiles(s.id);
    store.sources.remove(s.id);
  }
  for (const o of store.outputs.all().filter((x) => x.workspaceId === ws.id)) {
    store.deleteBlob('outputs', o.id);
    store.outputs.remove(o.id);
  }
  for (const q of store.quizzes.all().filter((x) => x.workspaceId === ws.id)) store.quizzes.remove(q.id);
  for (const c of store.chats.all().filter((x) => x.workspaceId === ws.id)) store.chats.remove(c.id);
  store.workspaces.remove(ws.id);
  res.json({ ok: true });
}));

function addToOrder(ws, sourceId) {
  store.workspaces.patch(ws.id, { sourceOrder: [...(ws.sourceOrder || []), sourceId] });
}

// ------------------------------------------------------------------ books & research

function startIdentify(sourceId) {
  return startJob('identify', { sourceId }, (ctx) => identifyBook(sourceId, ctx));
}
function startResearch(sourceId) {
  return startJob('research', { sourceId }, async (ctx) => {
    try {
      return await researchBook(sourceId, ctx);
    } catch (err) {
      store.sources.patch(sourceId, { research: { ...(store.sources.get(sourceId)?.research || {}), error: err.userMessage || err.message } });
      throw err;
    }
  });
}

app.post('/api/workspaces/:id/books', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const q = {};
  for (const k of ['title', 'author', 'isbn', 'edition', 'subject', 'level']) q[k] = String(req.body?.[k] || '').trim().slice(0, 200);
  if (!q.title && !q.isbn) throw bad('Enter a book title or an ISBN.');
  const source = store.sources.put({
    id: store.newId('src'),
    workspaceId: ws.id,
    kind: 'book',
    title: q.title || `ISBN ${q.isbn}`,
    query: q,
    identity: null,
    candidates: [],
    unitType: 'page',
    selection: { mode: 'all', numbering: 'printed' },
    included: true,
    createdAt: store.now(),
  });
  store.setUnits(source.id, []);
  addToOrder(ws, source.id);
  const job = startIdentify(source.id);
  res.status(201).json({ source: publicSource(store.sources.get(source.id)), jobId: job.id });
}));

app.post('/api/sources/:id/identify', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  if (s.kind !== 'book') throw bad('Only books can be identified.');
  if (activeJobFor(s.id)) throw bad('This book is already being researched.');
  const q = { ...s.query };
  for (const k of ['title', 'author', 'isbn', 'edition', 'subject', 'level']) if (typeof req.body?.[k] === 'string') q[k] = req.body[k].trim().slice(0, 200);
  store.sources.patch(s.id, { query: q, identity: null, candidates: [], title: q.title || s.title });
  const job = startIdentify(s.id);
  res.json({ jobId: job.id });
}));

app.post('/api/sources/:id/choose', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  if (s.kind !== 'book') throw bad('Only books have editions to choose.');
  let identity;
  if (req.body?.candidateId) {
    identity = (s.candidates || []).find((c) => c.id === req.body.candidateId);
    if (!identity) throw bad('That candidate no longer exists. Search again.');
  } else if (req.body?.manual) {
    const m = req.body.manual;
    identity = {
      id: store.newId('cand'),
      title: String(m.title || s.query?.title || '').slice(0, 200),
      subtitle: '',
      authors: String(m.author || s.query?.author || '').split(/,\s*/).filter(Boolean),
      publisher: String(m.publisher || '').slice(0, 120),
      edition: String(m.edition || s.query?.edition || '').slice(0, 120),
      year: Number(m.year) || null,
      isbn13s: m.isbn ? [String(m.isbn).replace(/[^0-9X]/gi, '')] : [],
      level: s.query?.level || '',
      subject: s.query?.subject || '',
      confidence: 'low',
      origin: 'manual',
      access: {},
      links: [],
    };
  } else throw bad('Choose a candidate.');
  const title = [identity.title, identity.subtitle].filter(Boolean).join(': ');
  store.sources.patch(s.id, { identity, title: title || s.title });
  const job = req.body?.research === false ? null : startResearch(s.id);
  res.json({ source: publicSource(store.sources.get(s.id)), jobId: job?.id || null });
}));

app.post('/api/sources/:id/research', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  if (s.kind !== 'book' || !s.identity) throw bad('Choose the correct edition first.');
  if (activeJobFor(s.id)) throw bad('Research is already running for this book.');
  const job = startResearch(s.id);
  res.json({ jobId: job.id });
}));

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have finished a long time ago).' });
  res.json({ id: job.id, type: job.type, status: job.status, log: job.log, progress: job.progress, error: job.error, result: job.result, meta: job.meta });
});

// ------------------------------------------------------------------ uploads & pasted text

function safeName(name) {
  return path.basename(String(name || 'file')).replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';
}

function runExtraction(sourceId, { buffer, fileName, mime, mergeIntoBook, startLabel }) {
  return startJob('extract', { sourceId }, async (ctx) => {
    try {
      const res = await extractFile({ buffer, fileName, mime, log: ctx.log });
      const src = store.sources.get(sourceId);
      if (!src) return null;
      if (mergeIntoBook) {
        const start = Number.parseInt(startLabel, 10);
        if (Number.isFinite(start)) {
          res.units.forEach((u, i) => {
            u.label = String(start + i);
            u.labelSource = 'user';
          });
        }
        const existing = store.getUnits(sourceId);
        const merged = mergeUnits(existing, res.units.map((u) => ({ ...u, origin: { kind: 'file', file: fileName, index: u.n } })));
        store.setUnits(sourceId, merged);
        store.sources.patch(sourceId, {
          unitType: existing.length ? src.unitType : res.unitType === 'slide' ? 'page' : res.unitType,
          files: [...(src.files || []), { name: fileName, size: buffer.length, type: res.kind, units: res.units.length, startLabel: Number.isFinite(start) ? start : null, addedAt: store.now() }],
        });
        ctx.log(`Added ${res.units.length} ${res.unitType}(s) to the book${Number.isFinite(start) ? ` as printed pages ${start}–${start + res.units.length - 1}` : ''}.`);
      } else {
        store.setUnits(sourceId, res.units);
        store.sources.patch(sourceId, {
          unitType: res.unitType,
          numbering: { ...res.numbering, docNote: res.numberingNote || null },
          chapters: res.chapters || [],
          report: res.report,
          selection: { ...normalizeSelection({ ...src, unitType: res.unitType, numbering: res.numbering }, { mode: 'all' }) },
          title: src.title === fileName && res.meta?.title ? `${res.meta.title}` : src.title,
          author: res.meta?.author || src.author || null,
          error: null,
        });
      }
      return res.report;
    } catch (err) {
      store.sources.patch(sourceId, { error: err.message });
      throw err;
    }
  });
}

app.post('/api/workspaces/:id/uploads', upload.single('file'), wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!req.file) throw bad('No file received.');
  const fileName = safeName(req.file.originalname);
  const source = store.sources.put({
    id: store.newId('src'),
    workspaceId: ws.id,
    kind: 'upload',
    title: fileName,
    unitType: 'page',
    selection: { mode: 'all' },
    included: true,
    files: [{ name: fileName, size: req.file.size, type: path.extname(fileName).slice(1).toLowerCase(), mime: req.file.mimetype, addedAt: store.now() }],
    createdAt: store.now(),
  });
  store.setUnits(source.id, []);
  fs.writeFileSync(path.join(store.sourceFileDir(source.id), fileName), req.file.buffer);
  addToOrder(ws, source.id);
  const job = runExtraction(source.id, { buffer: req.file.buffer, fileName, mime: req.file.mimetype });
  res.status(201).json({ source: publicSource(store.sources.get(source.id)), jobId: job.id });
}));

app.post('/api/sources/:id/files', upload.single('file'), wrap(async (req, res) => {
  const s = getSource(req.params.id);
  if (!req.file) throw bad('No file received.');
  if (activeJobFor(s.id)) throw bad('This source is busy. Try again when it has finished.');
  const fileName = safeName(req.file.originalname);
  fs.writeFileSync(path.join(store.sourceFileDir(s.id), fileName), req.file.buffer);
  const job = runExtraction(s.id, { buffer: req.file.buffer, fileName, mime: req.file.mimetype, mergeIntoBook: true, startLabel: req.body?.startLabel });
  res.json({ jobId: job.id });
}));

app.post('/api/workspaces/:id/paste', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const text = String(req.body?.text || '');
  if (text.trim().length < 20) throw bad('Paste at least a few sentences of text.');
  if (text.length > 3_000_000) throw bad('That is too much text to paste. Upload it as a file instead.');
  const title = String(req.body?.title || '').trim().slice(0, 120) || 'Pasted text';
  const res2 = extractPlainText(text, { origin: { kind: 'pasted', name: title } });
  res2.units.forEach((u) => (u.origin = { kind: 'pasted', name: title, index: u.n }));
  const source = store.sources.put({
    id: store.newId('src'),
    workspaceId: ws.id,
    kind: 'pasted',
    title,
    unitType: res2.unitType,
    numbering: analyseNumbering(res2.units, res2.unitType),
    selection: { mode: 'all' },
    included: true,
    report: { kind: 'text', unitCount: res2.units.length, chars: text.length },
    createdAt: store.now(),
  });
  store.setUnits(source.id, res2.units);
  addToOrder(ws, source.id);
  res.status(201).json({ source: publicSource(source) });
}));

// ------------------------------------------------------------------ sources

app.get('/api/sources/:id', wrap(async (req, res) => {
  res.json(publicSource(getSource(req.params.id), { withUnits: true }));
}));

app.get('/api/sources/:id/units', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  const units = store.getUnits(s.id);
  const sel = normalizeSelection(s, s.selection);
  let picked = [];
  if (req.query.n) {
    const ns = String(req.query.n).split(',').map(Number).filter(Number.isFinite).slice(0, 20);
    picked = units.filter((u) => ns.includes(u.n));
  } else if (req.query.ref) {
    const refs = String(req.query.ref).toLowerCase().split(',').map((r) => r.trim()).slice(0, 20);
    picked = units.filter((u) => refs.includes(refOf(u, s.unitType || 'page', sel.numbering).toLowerCase()));
  }
  res.json({
    source: { id: s.id, title: s.title, unitType: s.unitType, numbering: sel.numbering },
    units: picked.map((u) => ({ n: u.n, label: u.label, ref: refOf(u, s.unitType || 'page', sel.numbering), title: u.title, text: u.text, status: u.status, note: u.note || null, origin: u.origin || null })),
  });
}));

app.patch('/api/sources/:id', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  const patch = {};
  if (req.body.selection) patch.selection = normalizeSelection(s, req.body.selection);
  if (typeof req.body.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 200);
  if (typeof req.body.included === 'boolean') patch.included = req.body.included;
  store.sources.patch(s.id, patch);
  res.json(publicSource(store.sources.get(s.id)));
}));

app.post('/api/sources/:id/preview-selection', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  const units = store.getUnits(s.id);
  const resolved = resolveSelection(s, units, req.body?.selection || s.selection);
  const status = computeStatus({ ...s, selection: resolved.selection }, units, resolved);
  res.json({
    status,
    statusLabel: STATUS_LABELS[status],
    requested: resolved.requested,
    included: resolved.included.length,
    includedRefs: compressKeys(resolved.included.map((u) => (resolved.numbering === 'printed' && resolved.unitType === 'page' ? u.label || `pdf-${u.n}` : String(u.n)))),
    missing: compressKeys(resolved.missing),
    missingCount: resolved.missing.length,
    unreadable: compressKeys(resolved.unreadable),
    unreadableCount: resolved.unreadable.length,
    excluded: compressKeys(resolved.excluded),
    excludedCount: resolved.excluded.length,
    errors: resolved.errors,
    description: describeSelection(s, resolved),
    chars: resolved.included.reduce((n, u) => n + u.text.length, 0),
    unitStates: unitStates(units, resolved),
  });
}));

/** Per-unit state for the page map: in | ex (excluded) | unread | out (not selected). */
function unitStates(units, resolved) {
  const inSet = new Set(resolved.included.map((u) => u.n));
  const keyOf = (u) => (resolved.numbering === 'printed' && resolved.unitType === 'page' ? (u.label ? String(u.label).toLowerCase() : `pdf-${u.n}`) : String(u.n));
  const ex = new Set(resolved.excluded.map((k) => String(k).toLowerCase()));
  const unread = new Set(resolved.unreadable.map((k) => String(k).toLowerCase()));
  return units.map((u) => {
    const k = keyOf(u);
    return inSet.has(u.n) ? 'in' : ex.has(k) ? 'ex' : unread.has(k) ? 'unread' : 'out';
  });
}

app.post('/api/sources/:id/ocr', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  if (!aiAvailable()) throw new UserFacingError('OCR needs the AI connection. Add ANTHROPIC_API_KEY and restart the server.', { status: 503, code: 'ai_not_configured' });
  if (activeJobFor(s.id)) throw bad('This source is busy.');
  const units = store.getUnits(s.id);
  const pending = units.filter((u) => u.ocrPending || u.status === 'unreadable');
  const pdfFile = (s.files || []).find((f) => /pdf/i.test(f.type || f.name));
  if (!pending.length || !pdfFile) throw bad('There are no scanned PDF pages waiting for OCR.');
  const buffer = fs.readFileSync(path.join(store.sourceFileDir(s.id), pdfFile.name));
  const job = startJob('ocr', { sourceId: s.id }, async (ctx) => {
    pending.forEach((u) => (u.status = 'needs_ocr'));
    const r = await ocrPdfPages(buffer, units, ctx.log);
    store.setUnits(s.id, units);
    return r;
  });
  res.json({ jobId: job.id });
}));

app.delete('/api/sources/:id', wrap(async (req, res) => {
  const s = getSource(req.params.id);
  store.deleteBlob('units', s.id);
  store.removeSourceFiles(s.id);
  store.sources.remove(s.id);
  const ws = store.workspaces.get(s.workspaceId);
  if (ws) store.workspaces.patch(ws.id, { sourceOrder: (ws.sourceOrder || []).filter((id) => id !== s.id) });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ documents (summaries etc.)

const DOC_MODES = ['summarize', 'combined', 'compare', 'revision'];

app.post('/api/workspaces/:id/generate', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const mode = req.body?.mode;
  if (!DOC_MODES.includes(mode)) throw bad('Unknown mode.');
  const level = levelOf(req.body?.level).key;
  const { chosen, material } = taskSources(ws, req.body?.sourceIds);
  if ((mode === 'compare' || mode === 'combined') && chosen.length < 2) throw bad(`${MODE_LABELS[mode]} needs at least two sources. Select another book or document.`);
  const extraInstruction = String(req.body?.extraInstruction || '').slice(0, 1000);
  const meta = materialMeta(material);
  store.workspaces.patch(ws.id, { lastSettings: { ...(ws.lastSettings || {}), mode, level } });

  await sseRun(res, async (send) => {
    send({ type: 'meta', material: meta, mode, level, levelName: DETAIL_LEVELS[level].name });
    let text;
    let pipeline;
    let truncated = false;
    let offline = false;
    if (!aiAvailable()) {
      offline = true;
      send({ type: 'stage', text: 'AI is not connected — building an offline extractive version from your material…' });
      text = offlineSummary(material, level, mode);
      send({ type: 'delta', text });
      pipeline = { strategy: 'offline-extractive' };
    } else {
      const r = await generateDocument({ mode, level, material, emit: send, extraInstruction });
      ({ text, pipeline, truncated } = r);
    }
    send({ type: 'stage', text: 'Checking citations against the selected pages…' });
    const citationCheck = verifyCitations(text, material);
    const output = store.outputs.put({
      id: store.newId('out'),
      workspaceId: ws.id,
      workspaceTitle: ws.title,
      mode,
      modeLabel: MODE_LABELS[mode],
      level,
      levelName: DETAIL_LEVELS[level].name,
      title: `${MODE_LABELS[mode]}: ${chosen.map((s) => s.title).join(' + ').slice(0, 140)}`,
      sourceIds: chosen.map((s) => s.id),
      materialMeta: meta,
      pipeline,
      citationCheck,
      truncated,
      offline,
      extraInstruction,
      chars: text.length,
      createdAt: store.now(),
    });
    store.writeBlob('outputs', output.id, { content: text });
    send({ type: 'done', output: { ...output, content: text } });
  });
}));

app.get('/api/outputs', (req, res) => {
  res.json(store.outputs.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/api/outputs/:id', wrap(async (req, res) => {
  const o = store.outputs.get(req.params.id);
  if (!o) throw notFound('Document');
  const blob = store.readBlob('outputs', o.id, { content: '' });
  res.json({ ...o, content: blob.content });
}));

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeMarked = marked.use({ renderer: { html: (token) => escapeHtml(token.text ?? token.raw ?? '') } });

app.get('/api/outputs/:id/download', wrap(async (req, res) => {
  const o = store.outputs.get(req.params.id);
  if (!o) throw notFound('Document');
  const { content } = store.readBlob('outputs', o.id, { content: '' });
  const base = o.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'study-document';
  const header = `# ${o.title}\n\n_${o.modeLabel} · ${o.levelName} · ${new Date(o.createdAt).toLocaleString('en-GB')}_\n\n${o.materialMeta.map((m) => `- **${m.key}: ${m.title}** — ${m.selection}${m.gaps.length ? ` (${m.gaps.join('; ')})` : ''} — ${m.statusLabel}`).join('\n')}\n\n---\n\n`;
  if (req.query.format === 'html') {
    const body = safeMarked.parse(header + content);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.html"`);
    return res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(o.title)}</title><style>body{font:16px/1.65 Georgia,'Times New Roman',serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d2433}h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.25}h2{margin-top:2em;border-bottom:1px solid #e3e6ee;padding-bottom:.3em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d5d9e3;padding:6px 10px;text-align:left}blockquote{margin:1em 0;padding:.6em 1em;background:#f4f6fb;border-left:4px solid #8a97b8}code{background:#f1f3f8;padding:1px 4px;border-radius:4px}</style></head><body>${body}</body></html>`);
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.md"`);
  res.send(header + content);
}));

app.delete('/api/outputs/:id', wrap(async (req, res) => {
  store.deleteBlob('outputs', req.params.id);
  store.outputs.remove(req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ quizzes

app.post('/api/workspaces/:id/topics', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const { material } = taskSources(ws, req.body?.sourceIds);
  if (!aiAvailable()) {
    // Offline: use unit titles as topics.
    const topics = [];
    for (const e of material.sources) for (const b of e.blocks) if (b.title && !topics.some((t) => t.name === b.title)) topics.push({ name: b.title, description: `${e.key} ${b.ref}`, refs: [`${e.key} ${b.ref}`] });
    return res.json({ subject: '', contentType: '', topics: topics.slice(0, 30), offline: true });
  }
  res.json(await analyseTopics(material));
}));

function quizTitle(chosen, settings) {
  const names = chosen.map((s) => s.title).join(' + ');
  return `${settings.mode === 'learning' ? 'Practice' : 'Test'}: ${names}`.slice(0, 160);
}

app.post('/api/workspaces/:id/quizzes', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const { chosen, material } = taskSources(ws, req.body?.sourceIds);
  const s = req.body?.settings || {};
  const settings = {
    count: Math.max(1, Math.min(Number(s.count) || 10, 40)),
    difficulty: ['easy', 'normal', 'hard', 'mixed'].includes(s.difficulty) ? s.difficulty : 'normal',
    types: ['mcq', 'true_false', 'written', 'mixed'].includes(s.types) ? s.types : 'mixed',
    topics: Array.isArray(s.topics) ? s.topics.map(String).slice(0, 20) : [],
    focus: String(s.focus || '').slice(0, 500),
    mode: s.mode === 'learning' ? 'learning' : 'test',
  };
  store.workspaces.patch(ws.id, { lastSettings: { ...(ws.lastSettings || {}), quiz: settings } });
  const prior = req.body?.avoidQuizId ? (store.quizzes.get(req.body.avoidQuizId)?.questions || []).map((q) => q.question.slice(0, 160)) : [];

  await sseRun(res, async (send) => {
    let result;
    let offline = false;
    if (!aiAvailable()) {
      offline = true;
      send({ type: 'stage', text: 'AI is not connected — building a basic fill-in-the-blank quiz from your material…' });
      result = offlineQuiz(material, settings);
      if (!result.questions.length) throw bad('Not enough text in the selection to build an offline quiz.');
    } else {
      result = await generateQuiz({ material, settings, emit: send, priorQuestions: prior });
    }
    const quiz = store.quizzes.put({
      id: store.newId('quiz'),
      workspaceId: ws.id,
      title: quizTitle(chosen, settings),
      settings,
      subject: result.subject,
      contentType: result.contentType,
      isMaths: result.isMaths,
      questions: result.questions,
      answers: result.questions.map(() => ({})),
      sourceIds: chosen.map((x) => x.id),
      materialMeta: materialMeta(material),
      status: 'in_progress',
      offline,
      createdAt: store.now(),
    });
    send({ type: 'done', quizId: quiz.id });
  });
}));

function getQuiz(id) {
  const q = store.quizzes.get(id);
  if (!q) throw notFound('Quiz');
  return q;
}
function questionAt(quiz, index) {
  const i = Number(index);
  const q = quiz.questions[i];
  if (!q) throw bad('No such question.');
  quiz.answers[i] = quiz.answers[i] || {};
  return { q, i, a: quiz.answers[i] };
}
function quizMaterial(quiz) {
  try {
    const ws = store.workspaces.get(quiz.workspaceId);
    const srcs = orderedSources(ws).filter((s) => quiz.sourceIds.includes(s.id));
    return srcs.length ? buildMaterial(srcs) : null;
  } catch {
    return null;
  }
}

app.get('/api/quizzes', (req, res) => {
  res.json(store.quizzes.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((q) => ({ id: q.id, workspaceId: q.workspaceId, title: q.title, status: q.status, createdAt: q.createdAt, count: q.questions.length, subject: q.subject, results: q.results ? { percent: q.results.percent } : null })));
});

app.get('/api/quizzes/:id', wrap(async (req, res) => res.json(publicQuiz(getQuiz(req.params.id)))));

app.post('/api/quizzes/:id/answer', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const { q, i, a } = questionAt(quiz, req.body?.index);
  if (a.final) throw bad('This question has already been answered.');
  const response = req.body?.response;
  if (response === undefined || response === null || String(response).trim() === '') throw bad('Enter an answer first.');
  const learning = quiz.settings.mode === 'learning';
  a.attempts = (a.attempts || 0) + 1;
  a.response = String(response).slice(0, 4000);

  let verdict;
  let score;
  let feedback = null;
  const quick = quickMark(q, response);
  if (quick?.verdict === 'invalid') throw bad('Choose one of the options.');
  if (quick && !quick.needsFeedback) {
    verdict = quick.verdict;
    score = verdict === 'correct' ? 1 : 0;
    if (q.type === 'mcq' || q.type === 'true_false') {
      const fb = q.optionFeedback?.[quick.chosen];
      feedback = { feedback: fb || (verdict === 'correct' ? 'Correct!' : 'Not quite.'), whatWasRight: '', whatWentWrong: verdict === 'correct' ? '' : fb || '' };
    } else if (verdict === 'correct') {
      feedback = { feedback: '', whatWasRight: '', whatWentWrong: '' };
    }
  }
  const willReveal = !learning || verdict === 'correct';
  if (!verdict || (verdict !== 'correct' && (q.type === 'written' || q.type === 'numeric'))) {
    if (aiAvailable() && !quiz.offline) {
      const m = await markWithAI({ q, response: a.response, reveal: !learning, attempt: a.attempts });
      verdict = m.verdict;
      score = m.verdict === 'correct' ? 1 : m.verdict === 'partially_correct' ? 0.5 : 0;
      feedback = { feedback: m.feedback, whatWasRight: m.whatWasRight, whatWentWrong: m.whatWentWrong };
    } else if (!verdict) {
      verdict = 'incorrect';
      score = 0;
      feedback = { feedback: 'Offline marking only accepts the exact answer. Compare your answer with the model answer below.', whatWasRight: '', whatWentWrong: '' };
    }
  }
  a.verdict = verdict;
  a.score = score;
  a.feedback = feedback;
  // In test mode every submission is final. In learning mode the student may retry until correct (or reveal).
  if (!learning || verdict === 'correct' || (verdict === 'partially_correct' && a.attempts >= 3)) a.final = true;
  store.quizzes.patch(quiz.id, { answers: quiz.answers });
  res.json({ quiz: publicQuiz(quiz), canRetry: !a.final, revealed: willReveal && a.final });
}));

app.post('/api/quizzes/:id/hint', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const { q, a } = questionAt(quiz, req.body?.index);
  if (quiz.settings.mode === 'test' && !a.final) throw new UserFacingError('Hints are turned off in Test mode until you submit your answer. Switch to Learning mode for guided practice.', { status: 403, code: 'test_mode' });
  if ((a.hintsUsed || 0) >= (q.hints?.length || 0)) throw bad('No more hints for this question. Try "Show working".');
  a.hintsUsed = (a.hintsUsed || 0) + 1;
  store.quizzes.patch(quiz.id, { answers: quiz.answers });
  res.json({ quiz: publicQuiz(quiz) });
}));

app.post('/api/quizzes/:id/working', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const { q, a } = questionAt(quiz, req.body?.index);
  if (quiz.settings.mode === 'test' && !a.final) throw new UserFacingError('In Test mode the working is shown after you submit.', { status: 403, code: 'test_mode' });
  if (!q.working?.length) throw bad('This question has no worked solution.');
  a.workingShown = true;
  store.quizzes.patch(quiz.id, { answers: quiz.answers });
  res.json({ quiz: publicQuiz(quiz) });
}));

app.post('/api/quizzes/:id/reveal', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const { a } = questionAt(quiz, req.body?.index);
  if (quiz.settings.mode === 'test' && !a.final) throw new UserFacingError('In Test mode the answer is shown after you submit.', { status: 403, code: 'test_mode' });
  a.revealed = true;
  if (!a.final) {
    a.final = true;
    a.verdict = a.verdict === 'partially_correct' ? 'partially_correct' : 'incorrect';
    a.score = a.verdict === 'partially_correct' ? 0.5 : 0;
  }
  store.quizzes.patch(quiz.id, { answers: quiz.answers });
  res.json({ quiz: publicQuiz(quiz) });
}));

app.post('/api/quizzes/:id/explain', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const { q, a } = questionAt(quiz, req.body?.index);
  const kind = req.body?.kind;
  if (!['step', 'another_method', 'teacher', 'hint_more'].includes(kind)) throw bad('Unknown explanation type.');
  if (quiz.settings.mode === 'test' && !a.final) throw new UserFacingError('In Test mode, explanations are available after you submit.', { status: 403, code: 'test_mode' });
  if (kind !== 'hint_more' && !a.final && !a.workingShown && !a.revealed) throw bad('Show the working or submit your answer first.');
  if (!aiAvailable() || quiz.offline) throw new UserFacingError('Extra explanations need the AI connection.', { status: 503, code: 'ai_not_configured' });
  await sseRun(res, async (send) => {
    const r = await streamExplanation({ q, kind, step: Number(req.body?.step) || 0, response: a.response, emit: send, material: quizMaterial(quiz) });
    send({ type: 'done', text: r.text });
  });
}));

app.post('/api/quizzes/:id/finish', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const results = computeResults(quiz);
  store.quizzes.patch(quiz.id, { status: 'finished', results });
  res.json(publicQuiz(store.quizzes.get(quiz.id)));
}));

app.post('/api/quizzes/:id/retry', wrap(async (req, res) => {
  const quiz = getQuiz(req.params.id);
  const copy = store.quizzes.put({
    ...structuredClone(quiz),
    id: store.newId('quiz'),
    title: `${quiz.title} (retry)`,
    answers: quiz.questions.map(() => ({})),
    status: 'in_progress',
    results: null,
    createdAt: store.now(),
  });
  res.json({ quizId: copy.id });
}));

app.delete('/api/quizzes/:id', wrap(async (req, res) => {
  store.quizzes.remove(req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ study mode & Q&A

app.post('/api/workspaces/:id/chats', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const kind = req.body?.kind === 'qa' ? 'qa' : 'study';
  let sourceIds = req.body?.sourceIds;
  let contextDoc = null;
  let outputTitle = null;
  if (req.body?.outputId) {
    const o = store.outputs.get(req.body.outputId);
    if (o) {
      sourceIds = o.sourceIds;
      contextDoc = store.readBlob('outputs', o.id, { content: '' }).content;
      outputTitle = o.title;
    }
  }
  const { chosen, material } = taskSources(ws, sourceIds);
  const level = Object.keys(TUTOR_LEVELS).includes(req.body?.level) ? req.body.level : 'intermediate';
  const chat = store.chats.put({
    id: store.newId('chat'),
    workspaceId: ws.id,
    kind,
    level,
    focus: String(req.body?.focus || '').slice(0, 300),
    title: `${kind === 'qa' ? 'Questions' : 'Study'}: ${outputTitle || chosen.map((s) => s.title).join(' + ')}`.slice(0, 160),
    sourceIds: chosen.map((s) => s.id),
    materialMeta: materialMeta(material),
    contextDoc,
    messages: [],
    createdAt: store.now(),
  });
  res.status(201).json(publicChat(chat));
}));

function publicChat(c) {
  return { id: c.id, workspaceId: c.workspaceId, kind: c.kind, level: c.level, focus: c.focus, title: c.title, materialMeta: c.materialMeta, messages: c.messages.filter((m) => !m.hidden), createdAt: c.createdAt, updatedAt: c.updatedAt, hasContextDoc: Boolean(c.contextDoc) };
}

app.get('/api/chats', (req, res) => {
  res.json(store.chats.all().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => ({ id: c.id, workspaceId: c.workspaceId, kind: c.kind, title: c.title, updatedAt: c.updatedAt, messages: c.messages.length })));
});

app.get('/api/chats/:id', wrap(async (req, res) => {
  const c = store.chats.get(req.params.id);
  if (!c) throw notFound('Conversation');
  res.json(publicChat(c));
}));

app.patch('/api/chats/:id', wrap(async (req, res) => {
  const c = store.chats.get(req.params.id);
  if (!c) throw notFound('Conversation');
  if (Object.keys(TUTOR_LEVELS).includes(req.body?.level)) store.chats.patch(c.id, { level: req.body.level });
  res.json(publicChat(store.chats.get(c.id)));
}));

app.post('/api/chats/:id/messages', wrap(async (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) throw notFound('Conversation');
  if (!aiAvailable()) throw new UserFacingError('Study mode and Q&A need the AI connection. Add ANTHROPIC_API_KEY on the server (see Settings).', { status: 503, code: 'ai_not_configured' });
  const ws = getWorkspace(chat.workspaceId);
  const srcs = orderedSources(ws).filter((s) => chat.sourceIds.includes(s.id));
  if (!srcs.length) throw bad('The sources for this conversation were removed.');
  const material = buildMaterial(srcs);
  let userText;
  let hidden = false;
  if (req.body?.start) {
    userText = openingMessage(chat);
    hidden = true;
    if (!userText) throw bad('Nothing to start.');
  } else if (req.body?.action && QUICK_ACTIONS[req.body.action]) userText = QUICK_ACTIONS[req.body.action];
  else userText = String(req.body?.text || '').trim().slice(0, 6000);
  if (!userText) throw bad('Type a message first.');

  chat.messages.push({ role: 'user', content: userText, at: store.now(), hidden });
  await sseRun(res, async (send) => {
    try {
      const r = await tutorReply({ chat, material, userText, emit: send });
      chat.messages.push({ role: 'assistant', content: r.text, at: store.now() });
      store.chats.patch(chat.id, { messages: chat.messages });
      send({ type: 'done', message: { role: 'assistant', content: r.text }, citationCheck: verifyCitations(r.text, material) });
    } catch (err) {
      chat.messages.pop(); // keep the transcript valid (no dangling user turn)
      store.chats.patch(chat.id, { messages: chat.messages });
      throw err;
    }
  });
}));

app.delete('/api/chats/:id', wrap(async (req, res) => {
  store.chats.remove(req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ static front end

const pub = path.join(ROOT, 'public');
app.use('/vendor/marked.esm.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/marked/lib/marked.esm.js')));
app.use('/vendor/purify.es.mjs', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/dompurify/dist/purify.es.mjs')));
app.use(express.static(pub, { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

// ------------------------------------------------------------------ errors

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (limit ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB).` : err.message;
    return res.status(400).json({ error: msg, code: err.code });
  }
  const e = err instanceof UserFacingError ? err : translateError(err);
  if (e.status >= 500) console.error('[error]', err);
  if (res.headersSent) return res.end();
  res.status(e.status || 500).json({ error: e.userMessage || 'Something went wrong', code: e.code });
});

export { app };

if (process.env.NODE_ENV !== 'test-import') {
  app.listen(config.port, () => {
    console.log(`\n  Peter Parker Study is running at http://localhost:${config.port}`);
    console.log(`  AI: ${aiAvailable() ? `connected (model ${config.model})` : 'NOT connected. Set ANTHROPIC_API_KEY in .env to enable research, summaries, quizzes and tutoring.'}\n`);
  });
}
