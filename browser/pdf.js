// Browser copy of server/extract/pdf.js. PDF extraction with pdf.js: per-page text, printed page labels, outline (chapters).
// Pages with no text layer are flagged for OCR.
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { PDFDocument } from 'pdf-lib';
import { cleanText } from '../server/extract/text.js';

// Run pdf.js on the page's main thread (works when the file is opened directly from disk).
globalThis.pdfjsWorker = pdfjsWorker;

const MIN_TEXT_CHARS = 25; // below this a page is treated as scanned / image-only

function pageTextFromContent(content) {
  // Group text items into lines by their y-coordinate so columns and tables keep their order.
  const lines = [];
  let current = [];
  let lastY = null;
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform ? Math.round(item.transform[5]) : lastY;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && current.length) {
      lines.push(current.join(''));
      current = [];
    }
    current.push(item.str);
    if (item.hasEOL) {
      lines.push(current.join(''));
      current = [];
      lastY = null;
      continue;
    }
    lastY = y;
  }
  if (current.length) lines.push(current.join(''));
  return cleanText(lines.join('\n'));
}

async function resolveOutline(doc) {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!outline?.length) return [];
  const flat = [];
  const walk = async (items, depth) => {
    for (const it of items) {
      let pageIndex = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          pageIndex = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
        }
      } catch {
        /* unresolvable destination */
      }
      if (pageIndex !== null && it.title) flat.push({ title: it.title.trim(), depth, start: pageIndex + 1 });
      if (it.items?.length && depth < 2) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
  // Derive end pages from the next entry at the same or shallower depth.
  flat.sort((a, b) => a.start - b.start);
  return flat;
}

export async function extractPdf(buffer, { fileName }) {
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  let labels = null;
  try {
    labels = await doc.getPageLabels();
  } catch {
    labels = null;
  }

  const units = [];
  for (let i = 1; i <= doc.numPages; i++) {
    let text = '';
    try {
      const page = await doc.getPage(i);
      text = pageTextFromContent(await page.getTextContent());
      page.cleanup();
    } catch (err) {
      text = '';
    }
    const label = labels?.[i - 1] ? String(labels[i - 1]).trim() : null;
    const needsOcr = text.replace(/\s/g, '').length < MIN_TEXT_CHARS;
    units.push({
      n: i,
      label,
      labelSource: label ? 'pdf' : null,
      title: null,
      text: needsOcr ? '' : text,
      status: needsOcr ? 'needs_ocr' : 'ok',
      origin: { kind: 'file', file: fileName, index: i },
    });
  }
  const outline = await resolveOutline(doc);
  const numPages = doc.numPages;
  await loadingTask.destroy();

  const chapters = outline
    .filter((o) => o.depth <= 1)
    .map((o, idx, arr) => {
      const next = arr.slice(idx + 1).find((x) => x.depth <= o.depth);
      return { title: o.title, depth: o.depth, start: o.start, end: next ? Math.max(o.start, next.start - 1) : numPages };
    });

  return { unitType: 'page', units, chapters };
}

/** Build a smaller PDF containing only the given 1-based pages (for OCR batches). */
export async function subsetPdf(buffer, pageNumbers) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageNumbers.map((n) => n - 1));
  copied.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}
