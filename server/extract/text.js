// Plain text, Markdown, pasted text and HTML helpers.

export function cleanText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', times: '×', divide: '÷', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', minus: '−', le: '≤', ge: '≥', ne: '≠', pi: 'π' };

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Convert HTML/XHTML to readable text, keeping headings, lists and paragraphs. */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|section|article|blockquote|tr|table|ul|ol|li|h\d)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<t[dh][^>]*>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, '');
  return cleanText(decodeEntities(s));
}

/** Pull a <title> from HTML if present. */
export function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? decodeEntities(m[1]).trim() : null;
}

/**
 * Split long text into "parts" at paragraph boundaries. If the text contains
 * form-feed characters (page breaks from many converters) we split there and
 * call the units pages instead.
 */
export function splitText(text, { targetChars = 3500 } = {}) {
  const clean = String(text || '').replace(/\r\n?/g, '\n');
  if (clean.includes('\f')) {
    const pages = clean.split('\f').map(cleanText);
    // Drop a trailing empty page caused by a final form feed.
    while (pages.length > 1 && !pages[pages.length - 1]) pages.pop();
    return { unitType: 'page', parts: pages };
  }
  const paras = cleanText(clean).split(/\n{2,}/);
  const parts = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > targetChars) {
      parts.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) parts.push(cur);
  return { unitType: 'part', parts: parts.length ? parts : [''] };
}

/** Find a heading-like first line to use as a title. */
export function guessTitle(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const t = first.replace(/^#+\s*/, '');
  return t.length > 2 && t.length < 90 ? t : null;
}

export function extractPlainText(text, { fileName, origin }) {
  const { unitType, parts } = splitText(text);
  const units = parts.map((t, i) => ({
    n: i + 1,
    label: null,
    labelSource: null,
    title: unitType === 'part' ? guessTitle(t) : null,
    text: t,
    status: t ? 'ok' : 'unreadable',
    origin: origin || { kind: 'file', file: fileName, index: i + 1 },
  }));
  return { unitType, units, chapters: [] };
}
