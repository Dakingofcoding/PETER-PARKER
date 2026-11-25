import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pps-unit-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const fixtures = path.join(process.env.DATA_DIR, 'fixtures');
let extractFile, parseList, resolveSelection, computeStatus, buildMaterial, verifyCitations, store, quickMark, offlineQuiz, offlineSummary;

before(async () => {
  execFileSync(process.execPath, [path.join(root, 'tests/fixtures/make-fixtures.mjs'), fixtures]);
  ({ extractFile } = await import('../../server/extract/index.js'));
  ({ parseList, resolveSelection, computeStatus } = await import('../../server/selection.js'));
  ({ buildMaterial, verifyCitations } = await import('../../server/material.js'));
  store = await import('../../server/store.js');
  ({ quickMark } = await import('../../server/modes/quiz.js'));
  ({ offlineQuiz, offlineSummary } = await import('../../server/modes/offline.js'));
});

const read = (f) => fs.readFileSync(path.join(fixtures, f));

test('parseList handles ranges, singles, en-dashes and roman numerals', () => {
  assert.deepEqual(parseList('4-6, 9, 11–12').keys, ['4', '5', '6', '9', '11', '12']);
  assert.deepEqual(parseList('ii-iv').keys, ['ii', 'iii', 'iv']);
  assert.deepEqual(parseList('pages 3 to 5').keys, ['3', '4', '5']);
  assert.equal(parseList('abc-').errors.length, 1);
});

test('PDF: text per page, printed numbering inferred, scanned page flagged', async () => {
  const r = await extractFile({ buffer: read('sample-maths-book.pdf'), fileName: 'sample-maths-book.pdf' });
  assert.equal(r.unitType, 'page');
  assert.equal(r.units.length, 9);
  assert.match(r.units[3].text, /Long multiplication/);
  // Printed "1" is on PDF page 3 → offset 2
  assert.equal(r.numbering.source, 'inferred');
  assert.equal(r.numbering.offset, 2);
  assert.equal(r.units[2].label, '1');
  assert.equal(r.units[0].label, null);
  // Last page has no text layer and no AI → unreadable with OCR pending
  assert.equal(r.units[8].status, 'unreadable');
  assert.equal(r.units[8].ocrPending, true);
  assert.deepEqual(r.report.unreadable, [9]);
});

test('Selection: printed vs PDF numbering, exclusions, missing and unreadable pages', async () => {
  const r = await extractFile({ buffer: read('sample-maths-book.pdf'), fileName: 'x.pdf' });
  const src = { id: 'src_aaaaaa', kind: 'upload', unitType: 'page', numbering: r.numbering };
  const printed = resolveSelection(src, r.units, { mode: 'custom', numbering: 'printed', ranges: '1-8', exclude: '3' });
  assert.deepEqual(printed.included.map((u) => u.label), ['1', '2', '4', '5', '6']);
  assert.deepEqual(printed.excluded, ['3']);
  assert.deepEqual(printed.unreadable, ['7']); // printed 7 = PDF page 9 (scanned)
  assert.deepEqual(printed.missing, ['8']);
  assert.equal(computeStatus(src, r.units, printed), 'partial');

  const pdfIdx = resolveSelection(src, r.units, { mode: 'custom', numbering: 'index', ranges: '3-4' });
  assert.deepEqual(pdfIdx.included.map((u) => u.n), [3, 4]);
  assert.equal(computeStatus(src, r.units, pdfIdx), 'full_selected');
});

test('DOCX sections, PPTX slides, EPUB chapters, TXT parts', async () => {
  const d = await extractFile({ buffer: read('water-cycle.docx'), fileName: 'water-cycle.docx' });
  assert.equal(d.unitType, 'section');
  assert.ok(d.units.some((u) => u.title === 'Condensation' && /droplets/.test(u.text)));

  const p = await extractFile({ buffer: read('ww1-history.pptx'), fileName: 'ww1.pptx' });
  assert.equal(p.unitType, 'slide');
  assert.equal(p.units.length, 3);
  assert.equal(p.units[1].title, 'The spark');
  assert.match(p.units[1].text, /Sarajevo/);

  const e = await extractFile({ buffer: read('mara-island.epub'), fileName: 'mara.epub' });
  assert.equal(e.unitType, 'chapter');
  assert.equal(e.units[1].title, 'Chapter 2: The Island');
  assert.equal(e.meta.title, 'Mara and the Island');

  const t = await extractFile({ buffer: read('notes.txt'), fileName: 'notes.txt' });
  assert.equal(t.units.length, 1);
  assert.match(t.units[0].text, /Chlorophyll/);
});

test('Material keeps sources separate and citation check catches bad refs', async () => {
  const r = await extractFile({ buffer: read('sample-maths-book.pdf'), fileName: 'x.pdf' });
  const p = await extractFile({ buffer: read('ww1-history.pptx'), fileName: 'ww1.pptx' });
  const a = store.sources.put({ id: 'src_111111', workspaceId: 'ws_1', kind: 'upload', title: 'Maths', unitType: 'page', numbering: r.numbering, selection: { mode: 'custom', numbering: 'printed', ranges: '1-3', exclude: '2' }, createdAt: store.now() });
  const b = store.sources.put({ id: 'src_222222', workspaceId: 'ws_1', kind: 'upload', title: 'WW1', unitType: 'slide', selection: { mode: 'all' }, createdAt: store.now() });
  store.setUnits(a.id, r.units);
  store.setUnits(b.id, p.units);
  const m = buildMaterial([a, b]);
  assert.deepEqual(m.sources[0].blocks.map((x) => x.ref), ['p.1', 'p.3']);
  assert.deepEqual(m.sources[1].blocks.map((x) => x.ref), ['slide 1', 'slide 2', 'slide 3']);
  const check = verifyCitations('Fact [S1 p.1]. Other [S1 p.2]. Slide [S2 slide 2]. Range [S1 p.1–3]. Bad [S3 p.1]', m);
  assert.equal(check.total, 5);
  assert.equal(check.valid, 3);
  assert.equal(check.invalid.length, 2);

  const quiz = offlineQuiz(m, { count: 4, types: 'mixed' });
  assert.ok(quiz.questions.length >= 2);
  for (const q of quiz.questions) assert.ok(['S1', 'S2'].includes(q.sourceRefs[0].source));
  const md = offlineSummary(m, 3, 'summarize');
  assert.match(md, /Offline extractive summary/);
  assert.doesNotMatch(md, /\[S1 p\.2\]/); // excluded page never cited
});

test('quickMark accepts equivalent numeric answers', () => {
  const q = { type: 'numeric', answer: '10,368', acceptableAnswers: [] };
  assert.equal(quickMark(q, '10368').verdict, 'correct');
  assert.equal(quickMark(q, '10 368').verdict, 'correct');
  assert.equal(quickMark(q, '10367').verdict, 'incorrect');
  const f = { type: 'numeric', answer: '0.5', acceptableAnswers: ['1/2'] };
  assert.equal(quickMark(f, '1/2').verdict, 'correct');
  assert.equal(quickMark(f, '50%').verdict, 'correct');
  const mc = { type: 'mcq', options: ['a', 'b', 'c', 'd'], correctOption: 2 };
  assert.equal(quickMark(mc, 2).verdict, 'correct');
  assert.equal(quickMark(mc, 1).verdict, 'incorrect');
});
