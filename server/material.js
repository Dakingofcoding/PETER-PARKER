// Assembles the selected material from one or more sources into a tagged,
// source-separated text the AI can cite, chunks it for large inputs, and
// verifies citations in generated output.
import { getUnits } from './store.js';
import { resolveSelection, refOf, UNIT_NAMES, computeStatus, STATUS_LABELS } from './selection.js';

export function compressKeys(keys) {
  const nums = [];
  const other = [];
  for (const k of keys) (/^\d+$/.test(k) ? nums : other).push(k);
  nums.sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && Number(nums[j + 1]) === Number(nums[j]) + 1) j++;
    parts.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return [...parts, ...other].join(', ');
}

export function describeSelection(source, resolved) {
  const names = UNIT_NAMES[resolved.unitType] || UNIT_NAMES.part;
  const sel = resolved.selection;
  const numberingWord = resolved.unitType === 'page' ? (resolved.numbering === 'printed' ? 'printed ' : 'PDF ') : '';
  let what;
  if (sel.mode === 'all') what = `all available ${names.many}`;
  else {
    const bits = [];
    if (sel.ranges.trim()) bits.push(`${numberingWord}${names.many} ${sel.ranges.trim()}`);
    if (sel.chapters.length) bits.push(`${sel.chapters.length} chapter(s): ${sel.chapters.map((i) => source.chapters?.[i]?.title).filter(Boolean).join('; ')}`);
    what = bits.join(' + ') || 'nothing selected';
  }
  if (sel.exclude.trim()) what += `, excluding ${sel.exclude.trim()}`;
  return what;
}

const KIND_LABEL = { book: 'Researched book', upload: 'Uploaded document', pasted: 'Pasted text' };

/**
 * Build material for the given source objects (already filtered and ordered).
 * Each entry: { key, source, resolved, units, status, coverage }.
 */
export function buildMaterial(sourceObjs) {
  const entries = sourceObjs.map((source, i) => {
    const units = getUnits(source.id);
    const resolved = resolveSelection(source, units);
    const status = computeStatus(source, units, resolved);
    const names = UNIT_NAMES[resolved.unitType] || UNIT_NAMES.part;
    const blocks = resolved.included.map((u) => ({
      ref: refOf(u, resolved.unitType, resolved.numbering),
      n: u.n,
      label: u.label,
      title: u.title,
      text: u.text,
      origin: u.origin,
      ocr: u.status === 'ocr',
    }));
    const gaps = [];
    const word = (n) => (n === 1 ? names.one : names.many);
    if (resolved.missing.length) gaps.push(`${resolved.missing.length} ${word(resolved.missing.length)} not accessible: ${compressKeys(resolved.missing)}`);
    if (resolved.unreadable.length) gaps.push(`${resolved.unreadable.length} ${word(resolved.unreadable.length)} unreadable: ${compressKeys(resolved.unreadable)}`);
    return {
      key: `S${i + 1}`,
      id: source.id,
      title: source.title,
      author: source.identity?.authors?.join(', ') || source.author || null,
      edition: source.identity?.edition || null,
      kind: source.kind,
      unitType: resolved.unitType,
      numbering: resolved.numbering,
      selectionText: describeSelection(source, resolved),
      excludedText: resolved.excluded.length ? compressKeys(resolved.excluded) : '',
      status,
      statusLabel: STATUS_LABELS[status],
      resolved,
      blocks,
      gaps,
      chars: blocks.reduce((s, b) => s + b.text.length, 0),
    };
  });
  return {
    sources: entries,
    totalChars: entries.reduce((s, e) => s + e.chars, 0),
    totalBlocks: entries.reduce((s, e) => s + e.blocks.length, 0),
  };
}

const esc = (s) => String(s ?? '').replace(/"/g, "'");

function sourceHeader(e) {
  const names = UNIT_NAMES[e.unitType] || UNIT_NAMES.part;
  const numbering = e.unitType === 'page' ? (e.numbering === 'printed' ? 'printed book page numbers' : 'PDF page index') : `${names.one} numbers`;
  return `<source key="${e.key}" title="${esc(e.title)}"${e.author ? ` author="${esc(e.author)}"` : ''}${e.edition ? ` edition="${esc(e.edition)}"` : ''} type="${KIND_LABEL[e.kind] || e.kind}" numbering="${numbering}" selected="${esc(e.selectionText)}" coverage="${esc(e.gaps.length ? e.gaps.join('; ') : `all ${e.blocks.length} selected ${names.many} available`)}">`;
}

/** Render a list of { entry, blocks } groups as tagged text. */
export function renderGroups(groups) {
  return groups
    .map(({ entry, blocks }) => {
      const body = blocks
        .map((b) => `<unit ref="${b.ref}"${b.title ? ` title="${esc(b.title)}"` : ''}${b.ocr ? ' ocr="true"' : ''}>\n${b.text}\n</unit>`)
        .join('\n');
      return `${sourceHeader(entry)}\n${body}\n</source>`;
    })
    .join('\n\n');
}

export function materialText(material) {
  return renderGroups(material.sources.map((entry) => ({ entry, blocks: entry.blocks })));
}

/** Plain-language inventory of the material, given to the model before the content. */
export function inventory(material) {
  return material.sources
    .map((e) => {
      const names = UNIT_NAMES[e.unitType] || UNIT_NAMES.part;
      const gap = e.gaps.length ? ` GAPS: ${e.gaps.join('; ')}.` : '';
      return `- ${e.key}: "${e.title}" (${KIND_LABEL[e.kind] || e.kind}) — ${e.blocks.length} ${names.many} used (${e.selectionText}).${gap}`;
    })
    .join('\n');
}

/**
 * Split material into chunks of at most maxChars, never splitting a unit and
 * never mixing sources inside a group. Returns [{ groups: [{entry, blocks}], chars, label }].
 */
export function chunkMaterial(material, maxChars) {
  const chunks = [];
  let cur = { groups: [], chars: 0 };
  const flush = () => {
    if (cur.groups.length) chunks.push(cur);
    cur = { groups: [], chars: 0 };
  };
  for (const entry of material.sources) {
    let group = null;
    for (const b of entry.blocks) {
      const size = b.text.length + 80;
      if (cur.chars + size > maxChars && cur.chars > 0) {
        flush();
        group = null;
      }
      if (!group) {
        group = { entry, blocks: [] };
        cur.groups.push(group);
      }
      group.blocks.push(b);
      cur.chars += size;
    }
  }
  flush();
  return chunks.map((c, i) => ({
    ...c,
    label: c.groups.map((g) => `${g.entry.key} ${g.blocks[0].ref}–${g.blocks[g.blocks.length - 1].ref}`).join(', '),
    index: i + 1,
  }));
}

// Citation format: [S1 p.12], [S1 p.12–14], [S2 slide 4], [S1 ch.3], [S1 pdf-p.2]
export const CITATION_RE = /\[(S\d+)\s+((?:pdf-)?p\.|slide |ch\.|sec\.|part )\s?([0-9ivxlcdm]+)(?:\s*[-–]\s*((?:pdf-)?p\.|slide |ch\.|sec\.|part )?\s?([0-9ivxlcdm]+))?\]/gi;

/**
 * Check that each citation points to a source and unit that was actually in
 * the selected, available material.
 */
export function verifyCitations(text, material) {
  const refsBySource = new Map(material.sources.map((e) => [e.key, new Set(e.blocks.map((b) => b.ref.toLowerCase()))]));
  let total = 0;
  const invalid = [];
  for (const m of String(text).matchAll(CITATION_RE)) {
    total++;
    const [full, key, prefix, a, , b] = m;
    const refs = refsBySource.get(key.toUpperCase());
    if (!refs) {
      invalid.push({ citation: full, reason: `No source ${key} in this material` });
      continue;
    }
    const start = `${prefix.toLowerCase()}${a.toLowerCase()}`.replace(/\s+/g, ' ');
    const okStart = refs.has(start);
    let okEnd = true;
    if (b) okEnd = refs.has(`${prefix.toLowerCase()}${b.toLowerCase()}`.replace(/\s+/g, ' '));
    if (!okStart || !okEnd) invalid.push({ citation: full, reason: 'Points to a page/slide that is not in the selected, available material' });
  }
  return { total, valid: total - invalid.length, invalid: invalid.slice(0, 50) };
}

/** Public summary of the material (shown in result headers). */
export function materialMeta(material) {
  return material.sources.map((e) => ({
    key: e.key,
    id: e.id,
    title: e.title,
    author: e.author,
    kind: e.kind,
    unitType: e.unitType,
    numbering: e.numbering,
    selection: e.selectionText,
    excluded: e.excludedText,
    used: e.blocks.length,
    missing: e.resolved.missing,
    unreadable: e.resolved.unreadable,
    status: e.status,
    statusLabel: e.statusLabel,
    gaps: e.gaps,
  }));
}
