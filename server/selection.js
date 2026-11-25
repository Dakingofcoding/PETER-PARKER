// Page / slide / chapter selection, exclusions, numbering systems and the
// honest access-status of each source.

const MAX_KEYS = 10000;

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function romanToInt(s) {
  const t = s.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(t)) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = ROMAN[t[i]];
    const next = ROMAN[t[i + 1]] || 0;
    total += v < next ? -v : v;
  }
  return total;
}
function intToRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, r] of map) while (n >= v) { out += r; n -= v; }
  return out;
}

export const normKey = (k) => String(k ?? '').trim().toLowerCase();

/**
 * Parse "4-67, 70, 72–75, iv-vi" into tokens. Returns { keys: string[], errors: string[] }.
 */
export function parseList(input) {
  const keys = [];
  const errors = [];
  const text = String(input || '').trim();
  if (!text) return { keys, errors };
  for (const raw of text.split(/[,;]+/)) {
    const tok = raw.trim().replace(/^(pages?|pp?\.?|slides?|chapters?|ch\.?)\s*/i, '');
    if (!tok) continue;
    const range = /^([0-9]+|[ivxlcdm]+)\s*(?:-|–|—|to)\s*([0-9]+|[ivxlcdm]+)$/i.exec(tok);
    if (range) {
      const romanMode = !/^\d/.test(range[1]);
      const a = romanMode ? romanToInt(range[1]) : Number(range[1]);
      const b = romanMode ? romanToInt(range[2]) : Number(range[2]);
      if (a === null || b === null) {
        errors.push(`Could not read "${tok}"`);
        continue;
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      if (hi - lo > MAX_KEYS) {
        errors.push(`Range "${tok}" is too large`);
        continue;
      }
      for (let k = lo; k <= hi; k++) keys.push(romanMode ? intToRoman(k) : String(k));
      continue;
    }
    if (/^[0-9]+$/.test(tok) || /^[ivxlcdm]+$/i.test(tok) || /^[a-z]?\d+[a-z]?$/i.test(tok)) {
      keys.push(tok.toLowerCase().replace(/^0+(?=\d)/, ''));
      continue;
    }
    errors.push(`Could not read "${tok}"`);
  }
  return { keys: keys.slice(0, MAX_KEYS), errors };
}

export const UNIT_NAMES = {
  page: { one: 'page', many: 'pages', ref: 'p.' },
  slide: { one: 'slide', many: 'slides', ref: 'slide ' },
  chapter: { one: 'chapter', many: 'chapters', ref: 'ch.' },
  section: { one: 'section', many: 'sections', ref: 'sec.' },
  part: { one: 'part', many: 'parts', ref: 'part ' },
};

/** Default numbering for a source: printed when the user's book numbering is known. */
export function defaultNumbering(source) {
  if (source.unitType !== 'page') return 'index';
  if (source.kind === 'book') return 'printed';
  return source.numbering?.differs ? 'printed' : 'index';
}

export function normalizeSelection(source, sel = {}) {
  const numbering = sel.numbering === 'printed' || sel.numbering === 'index' ? sel.numbering : defaultNumbering(source);
  return {
    mode: sel.mode === 'custom' ? 'custom' : 'all',
    numbering: source.unitType === 'page' ? numbering : 'index',
    ranges: String(sel.ranges ?? '').slice(0, 2000),
    exclude: String(sel.exclude ?? '').slice(0, 2000),
    chapters: Array.isArray(sel.chapters) ? sel.chapters.filter((c) => Number.isInteger(c)).slice(0, 500) : [],
  };
}

/** Reference string for a unit as shown to the AI and in citations, e.g. "p.12", "slide 4". */
export function refOf(unit, unitType, numbering) {
  if (unitType === 'page') {
    if (numbering === 'printed') return unit.label ? `p.${unit.label}` : `pdf-p.${unit.n}`;
    return `p.${unit.n}`;
  }
  return `${UNIT_NAMES[unitType]?.ref || 'part '}${unit.n}`;
}

/** Human label for a key in the given numbering ("printed page 12", "PDF page 14", "slide 3"). */
export function describeKey(key, unitType, numbering) {
  if (unitType === 'page') return numbering === 'printed' ? `p.${key}` : `PDF p.${key}`;
  return `${UNIT_NAMES[unitType]?.one || 'part'} ${key}`;
}

const numericOrder = (a, b) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const ra = romanToInt(a);
  const rb = romanToInt(b);
  if (ra !== null && rb !== null) return ra - rb;
  return String(a).localeCompare(String(b));
};

/**
 * Resolve a source's selection against its units.
 * Returns {
 *   included: units with readable text in the selection (in order),
 *   missing: keys requested but not available,
 *   unreadable: keys present but with no readable text,
 *   excluded: keys removed by exclusion,
 *   requested: count, numbering, unitType, errors
 * }
 */
export function resolveSelection(source, units, selInput) {
  const sel = normalizeSelection(source, selInput ?? source.selection);
  const unitType = source.unitType || 'page';
  const keyOf = (u) => (sel.numbering === 'printed' && unitType === 'page' ? (u.label ? normKey(u.label) : null) : String(u.n));
  const byKey = new Map();
  for (const u of units) {
    const k = keyOf(u);
    if (k !== null && !byKey.has(k)) byKey.set(k, u);
  }
  const errors = [];
  const entries = []; // { key, unit|null }
  const seen = new Set();
  const push = (key, unit) => {
    const id = unit ? `u${unit.n}` : `k${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ key: unit ? keyOf(unit) ?? `pdf-${unit.n}` : key, unit });
  };

  if (sel.mode === 'all') {
    for (const u of units) push(keyOf(u) ?? `pdf-${u.n}`, u);
  } else {
    const parsed = parseList(sel.ranges);
    errors.push(...parsed.errors);
    for (const k of parsed.keys) push(normKey(k), byKey.get(normKey(k)) || null);
    for (const ci of sel.chapters) {
      const ch = source.chapters?.[ci];
      if (!ch) continue;
      const chNumbering = ch.numbering || 'index';
      for (let k = Number(ch.start); k <= Number(ch.end) && k - ch.start < MAX_KEYS; k++) {
        if (chNumbering === 'index') {
          const u = units.find((x) => x.n === k);
          if (u) push(keyOf(u) ?? `pdf-${u.n}`, u);
        } else {
          const u = units.find((x) => normKey(x.label) === String(k));
          if (u) push(keyOf(u) ?? `pdf-${u.n}`, u);
          else if (sel.numbering === 'printed') push(String(k), null);
        }
      }
    }
  }

  const ex = parseList(sel.exclude);
  errors.push(...ex.errors.map((e) => `Exclusions: ${e}`));
  const excludeSet = new Set(ex.keys.map(normKey));
  const excluded = [];
  const kept = [];
  for (const e of entries) {
    if (excludeSet.has(normKey(e.key))) excluded.push(e.key);
    else kept.push(e);
  }

  const included = [];
  const missing = [];
  const unreadable = [];
  for (const e of kept) {
    if (!e.unit || e.unit.status === 'missing') missing.push(e.key);
    else if (!e.unit.text || e.unit.status === 'unreadable' || e.unit.status === 'needs_ocr') unreadable.push(e.key);
    else included.push(e.unit);
  }
  included.sort((a, b) => a.n - b.n);
  missing.sort(numericOrder);

  return {
    selection: sel,
    unitType,
    numbering: sel.numbering,
    requested: kept.length,
    included,
    missing,
    unreadable,
    excluded: [...new Set(excluded)],
    errors,
  };
}

export const STATUS_LABELS = {
  unidentified: 'Choose the correct book',
  identified: 'Book Identified',
  researching: 'Researching',
  processing: 'Processing',
  content_found: 'Content Found',
  partial: 'Partially Accessible',
  full_selected: 'Full Selected Content Accessible',
  limited: 'Access Limited',
  needs_upload: 'Needs User Upload',
  error: 'Error',
};

/**
 * Honest status of a source given its units and current selection.
 * "full_selected" is only returned when every unit in the selection was
 * retrieved and has readable text.
 */
export function computeStatus(source, units, resolved, { busy = false } = {}) {
  if (busy) return source.kind === 'book' ? 'researching' : 'processing';
  if (source.kind === 'book') {
    if (!source.identity) return source.candidates?.length ? 'unidentified' : source.research?.error ? 'error' : 'unidentified';
    if (!source.research?.researchedAt && !units.length) return 'identified';
    const readable = units.filter((u) => u.text && (u.status === 'ok' || u.status === 'ocr'));
    if (!readable.length) {
      const hasLeads = (source.research?.sources || []).some((s) => s.access && s.access !== 'none');
      return hasLeads || source.chapters?.length ? 'limited' : 'needs_upload';
    }
    if (resolved.selection.mode === 'all') return source.completeText ? 'full_selected' : 'content_found';
    if (!resolved.included.length) return 'needs_upload';
    if (resolved.missing.length || resolved.unreadable.length) return 'partial';
    return 'full_selected';
  }
  // Uploaded files / pasted text
  const readable = units.filter((u) => u.text && (u.status === 'ok' || u.status === 'ocr'));
  if (!readable.length) return 'needs_upload';
  if (!resolved.included.length) return 'needs_upload';
  if (resolved.missing.length || resolved.unreadable.length) return 'partial';
  return 'full_selected';
}
