// Word (.docx) extraction. Word stores no fixed pages, but it records where the
// page breaks fell the last time the file was laid out (w:lastRenderedPageBreak)
// plus explicit page breaks. When present we expose pages (flagged approximate);
// otherwise we split into sections by heading.
import JSZip from 'jszip';
import { cleanText, decodeEntities, splitText, guessTitle } from './text.js';

function paragraphText(pXml) {
  let out = '';
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?![^>]*w:type="page")[^>]*\/>|<w:sym [^>]*w:char="([0-9A-F]+)"[^>]*\/>/g;
  let m;
  while ((m = re.exec(pXml))) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else if (m[0].startsWith('<w:br')) out += '\n';
    else if (m[2]) out += String.fromCharCode(parseInt(m[2], 16));
  }
  return out;
}

export async function extractDocx(buffer, { fileName }) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('This file does not look like a Word document (word/document.xml missing).');
  const xml = await docFile.async('string');

  // Map style ids to heading levels (custom style names like "Heading1" / "Titre1").
  const headingStyles = new Map();
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    const styles = await stylesFile.async('string');
    for (const m of styles.matchAll(/<w:style [^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
      const name = /<w:name w:val="([^"]+)"/.exec(m[2])?.[1] || '';
      const lvl = /heading\s*(\d)/i.exec(name)?.[1] || (/^title$/i.test(name) ? '1' : null);
      const outline = /<w:outlineLvl w:val="(\d)"/.exec(m[2])?.[1];
      if (lvl) headingStyles.set(m[1], Number(lvl));
      else if (outline !== undefined) headingStyles.set(m[1], Number(outline) + 1);
    }
  }

  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] || xml;
  const paras = [];
  let pageBreaks = 0;
  for (const m of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const styleId = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1];
    const level = styleId ? headingStyles.get(styleId) || (/heading(\d)/i.exec(styleId) ? Number(/heading(\d)/i.exec(styleId)[1]) : null) : null;
    const breakBefore = /<w:lastRenderedPageBreak\/>|<w:br [^>]*w:type="page"[^>]*\/>|<w:pageBreakBefore\/>/.test(p);
    if (breakBefore) pageBreaks++;
    paras.push({ text: paragraphText(p), level, breakBefore });
  }

  const units = [];
  let chapters = [];
  let unitType;

  if (pageBreaks >= 1) {
    unitType = 'page';
    let cur = [];
    const pushPage = () => {
      units.push({ text: cleanText(cur.join('\n')) });
      cur = [];
    };
    const headingAt = [];
    for (const para of paras) {
      if (para.breakBefore && cur.length) pushPage();
      if (para.level && para.text.trim() && para.level <= 2) headingAt.push({ title: para.text.trim(), depth: para.level - 1, start: units.length + 1 });
      cur.push(para.level ? `${'#'.repeat(para.level)} ${para.text}` : para.text);
    }
    pushPage();
    chapters = headingAt.map((h, i, arr) => {
      const next = arr.slice(i + 1).find((x) => x.depth <= h.depth);
      return { ...h, end: next ? Math.max(h.start, next.start - 1) : units.length };
    });
  } else if (paras.some((p) => p.level)) {
    unitType = 'section';
    let cur = null;
    for (const para of paras) {
      if (para.level && para.level <= 2 && para.text.trim()) {
        if (cur) units.push(cur);
        cur = { title: para.text.trim(), lines: [`${'#'.repeat(para.level)} ${para.text.trim()}`] };
      } else {
        if (!cur) cur = { title: 'Introduction', lines: [] };
        cur.lines.push(para.level ? `${'#'.repeat(para.level)} ${para.text}` : para.text);
      }
    }
    if (cur) units.push(cur);
    units.forEach((u) => (u.text = cleanText(u.lines.join('\n'))));
  } else {
    const { parts } = splitText(paras.map((p) => p.text).join('\n\n'));
    unitType = 'part';
    parts.forEach((t) => units.push({ text: t, title: guessTitle(t) }));
  }

  return {
    unitType,
    numberingNote: unitType === 'page' ? 'Page breaks come from the last time Word laid out this file, so they may differ slightly from a printed copy.' : null,
    units: units.map((u, i) => ({
      n: i + 1,
      label: null,
      labelSource: null,
      title: u.title || null,
      text: u.text,
      status: u.text ? 'ok' : 'unreadable',
      origin: { kind: 'file', file: fileName, index: i + 1 },
    })),
    chapters,
  };
}
