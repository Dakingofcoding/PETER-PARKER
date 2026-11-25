// Dispatches a file to the right extractor, then runs OCR for image-only pages
// and analyses page numbering.
import path from 'node:path';
import { extractPdf, subsetPdf } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractPptx } from './pptx.js';
import { extractEpub } from './epub.js';
import { extractPlainText, htmlToText, htmlTitle } from './text.js';
import { analyseNumbering } from './numbering.js';
import { aiAvailable, transcribeVisual } from '../ai.js';

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.epub', '.txt', '.md', '.markdown', '.html', '.htm', ...Object.keys(IMAGE_TYPES)];

export function detectKind(fileName, mime = '') {
  const ext = path.extname(fileName || '').toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.epub' || mime === 'application/epub+zip') return 'epub';
  if (['.txt', '.md', '.markdown'].includes(ext) || mime.startsWith('text/plain')) return 'text';
  if (['.html', '.htm'].includes(ext) || mime.startsWith('text/html')) return 'html';
  if (IMAGE_TYPES[ext] || mime.startsWith('image/')) return 'image';
  if (ext === '.doc') throw new Error('Old .doc Word files are not supported. Open the file in Word or LibreOffice and save it as .docx.');
  if (ext === '.ppt') throw new Error('Old .ppt PowerPoint files are not supported. Save the presentation as .pptx first.');
  throw new Error(`Unsupported file type "${ext || mime}". Supported: PDF, DOCX, PPTX, EPUB, TXT, Markdown, HTML and images.`);
}

const OCR_BATCH = 6;

async function ocrPdfPages(buffer, units, log) {
  const pending = units.filter((u) => u.status === 'needs_ocr');
  if (!pending.length) return { ocrd: 0, failed: 0 };
  if (!aiAvailable()) {
    for (const u of pending) {
      u.status = 'unreadable';
      u.ocrPending = true;
      u.note = 'Scanned page with no text layer. OCR needs the AI connection (add ANTHROPIC_API_KEY), then press "Retry OCR".';
    }
    log?.(`${pending.length} scanned page(s) need OCR, but the AI connection is not configured.`);
    return { ocrd: 0, failed: pending.length };
  }
  let ocrd = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += OCR_BATCH) {
    const batch = pending.slice(i, i + OCR_BATCH);
    log?.(`OCR: reading scanned page(s) ${batch.map((u) => u.n).join(', ')}…`);
    try {
      const pdf = await subsetPdf(buffer, batch.map((u) => u.n));
      const pages = await transcribeVisual({
        block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
        count: batch.length,
        unitName: 'page',
      });
      batch.forEach((u, idx) => {
        const r = pages.find((p) => p.n === idx + 1);
        if (r && r.legible && r.text.trim()) {
          u.text = r.text.trim();
          u.status = 'ocr';
          u.note = r.note || null;
          u.ocrPending = false;
          ocrd++;
        } else {
          u.status = 'unreadable';
          u.ocrPending = false;
          u.note = `OCR could not read this page${r?.note ? `: ${r.note}` : '.'}`;
          failed++;
        }
      });
    } catch (err) {
      for (const u of batch) {
        u.status = 'unreadable';
        u.ocrPending = true;
        u.note = `OCR failed: ${err.userMessage || err.message}`;
        failed++;
      }
      log?.(`OCR failed for pages ${batch.map((u) => u.n).join(', ')}: ${err.userMessage || err.message}`);
    }
  }
  return { ocrd, failed };
}

/**
 * Extract a file into units. Returns
 * { unitType, units, chapters, numbering, meta, report }.
 */
export async function extractFile({ buffer, fileName, mime, log }) {
  const kind = detectKind(fileName, mime);
  let result;
  log?.(`Extracting ${fileName} (${kind.toUpperCase()})…`);
  switch (kind) {
    case 'pdf':
      result = await extractPdf(buffer, { fileName });
      break;
    case 'docx':
      result = await extractDocx(buffer, { fileName });
      break;
    case 'pptx':
      result = await extractPptx(buffer, { fileName });
      break;
    case 'epub':
      result = await extractEpub(buffer, { fileName });
      break;
    case 'text':
      result = extractPlainText(buffer.toString('utf8'), { fileName });
      break;
    case 'html': {
      const html = buffer.toString('utf8');
      result = extractPlainText(htmlToText(html), { fileName });
      result.meta = { title: htmlTitle(html) };
      break;
    }
    case 'image': {
      result = { unitType: 'page', chapters: [], units: [{ n: 1, label: null, title: null, text: '', status: 'needs_ocr', origin: { kind: 'file', file: fileName, index: 1 } }] };
      if (aiAvailable()) {
        try {
          const ext = path.extname(fileName).toLowerCase();
          const pages = await transcribeVisual({
            block: { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext] || mime, data: buffer.toString('base64') } },
            count: 1,
            unitName: 'image',
          });
          const r = pages[0];
          Object.assign(result.units[0], r?.legible && r.text.trim() ? { text: r.text.trim(), status: 'ocr', note: r.note || null } : { status: 'unreadable', note: 'OCR could not read text in this image.' });
        } catch (err) {
          Object.assign(result.units[0], { status: 'unreadable', ocrPending: true, note: `OCR failed: ${err.userMessage || err.message}` });
        }
      } else {
        Object.assign(result.units[0], { status: 'unreadable', ocrPending: true, note: 'Images need OCR, which requires the AI connection (ANTHROPIC_API_KEY).' });
      }
      break;
    }
    default:
      throw new Error('Unsupported file');
  }

  let ocr = { ocrd: 0, failed: 0 };
  if (kind === 'pdf') ocr = await ocrPdfPages(buffer, result.units, log);

  const numbering = analyseNumbering(result.units, result.unitType);
  const unreadable = result.units.filter((u) => u.status === 'unreadable').map((u) => u.n);
  const report = {
    kind,
    unitCount: result.units.length,
    textUnits: result.units.filter((u) => u.status === 'ok').length,
    ocrUnits: result.units.filter((u) => u.status === 'ocr').length,
    unreadable,
    ocrFailed: ocr.failed,
    chars: result.units.reduce((s, u) => s + (u.text?.length || 0), 0),
  };
  log?.(`Extracted ${report.unitCount} ${result.unitType}(s); ${report.ocrUnits} via OCR; ${unreadable.length} unreadable.`);
  return { ...result, numbering, report, kind };
}

export { ocrPdfPages };
