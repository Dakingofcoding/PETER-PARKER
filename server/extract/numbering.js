// Printed page numbers vs. PDF page index.
// PDFs may carry explicit page labels; otherwise we look for the page number
// printed in the header/footer of each page and infer a consistent offset.

const PATTERNS = [
  /^(\d{1,4})$/,
  /^page\s+(\d{1,4})(?:\s+of\s+\d+)?$/i,
  /^[-–—]\s*(\d{1,4})\s*[-–—]$/,
  /^(\d{1,4})\s*[|•·]\s*\S.*$/,
  /^\S.*\s*[|•·]\s*(\d{1,4})$/,
];

function printedCandidates(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const edge = [...lines.slice(0, 3), ...lines.slice(-3)];
  const found = new Set();
  for (const line of edge) {
    if (line.length > 60) continue;
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (m) found.add(Number(m[1]));
    }
  }
  return [...found];
}

/**
 * Returns { offset, matches, sampled, confidence } where printed = index - offset,
 * or null when no consistent pattern exists.
 */
export function inferPrintedOffset(units) {
  const tally = new Map();
  let sampled = 0;
  for (const u of units) {
    if (!u.text) continue;
    const cands = printedCandidates(u.text);
    if (!cands.length) continue;
    sampled++;
    for (const num of cands) {
      const offset = u.n - num;
      if (offset < -5 || offset > 200) continue;
      tally.set(offset, (tally.get(offset) || 0) + 1);
    }
  }
  if (!tally.size) return null;
  const [offset, matches] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const withText = units.filter((u) => u.text).length || 1;
  if (matches < 3 || matches < withText * 0.35) return null;
  return { offset, matches, sampled, confidence: matches / withText };
}

/**
 * Decide the numbering situation for a page-based source and, when needed,
 * attach inferred printed labels to units (labelSource: 'inferred').
 */
export function analyseNumbering(units, unitType) {
  if (unitType !== 'page') {
    return { hasPrinted: false, differs: false, source: null, note: null };
  }
  const pdfLabelled = units.filter((u) => u.label && u.labelSource === 'pdf');
  const meaningfulPdfLabels = pdfLabelled.some((u) => u.label !== String(u.n));
  if (pdfLabelled.length && meaningfulPdfLabels) {
    const first = units.find((u) => u.label);
    return {
      hasPrinted: true,
      differs: true,
      source: 'pdf',
      note: `This PDF has its own page labels. For example, PDF page ${first.n} is labelled "${first.label}".`,
    };
  }
  const inferred = inferPrintedOffset(units);
  if (inferred && inferred.offset !== 0) {
    for (const u of units) {
      const printed = u.n - inferred.offset;
      u.label = printed >= 1 ? String(printed) : null;
      u.labelSource = printed >= 1 ? 'inferred' : null;
    }
    return {
      hasPrinted: true,
      differs: true,
      source: 'inferred',
      offset: inferred.offset,
      note: `The printed page numbers seem to be ${inferred.offset} behind the PDF page index (PDF page ${inferred.offset + 1} shows "1"). This was detected on ${inferred.matches} pages. Check it against your book before choosing.`,
    };
  }
  if (inferred && inferred.offset === 0) {
    for (const u of units) {
      u.label = String(u.n);
      u.labelSource = 'inferred';
    }
    return { hasPrinted: true, differs: false, source: 'inferred', note: 'Printed page numbers match the PDF page index.' };
  }
  return { hasPrinted: false, differs: false, source: null, note: null };
}
