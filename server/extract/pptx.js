// PowerPoint (.pptx) extraction: one unit per slide in presentation order,
// including the slide title, body text, tables and speaker notes.
import JSZip from 'jszip';
import path from 'node:path';
import { cleanText, decodeEntities } from './text.js';

function shapeParagraphs(xml) {
  const paras = [];
  for (const p of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p [^>]*>([\s\S]*?)<\/a:p>/g)) {
    const inner = p[1] ?? p[2] ?? '';
    const text = [...inner.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeEntities(t[1])).join('');
    if (text.trim()) {
      const lvl = Number(/<a:pPr [^>]*lvl="(\d)"/.exec(inner)?.[1] || 0);
      paras.push(`${'  '.repeat(lvl)}${text}`);
    }
  }
  return paras;
}

function slideContent(xml) {
  let title = null;
  const body = [];
  for (const sp of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const isTitle = /<p:ph [^>]*type="(title|ctrTitle)"/.test(sp[1]);
    const paras = shapeParagraphs(sp[1]);
    if (!paras.length) continue;
    if (isTitle && !title) title = paras.join(' ').trim();
    else body.push(...paras.map((t) => (/^\s/.test(t) ? `${t.replace(/^(\s*)/, '$1• ')}` : `• ${t}`)));
  }
  // Tables (graphic frames)
  for (const tbl of xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g)) {
    for (const tr of tbl[1].matchAll(/<a:tr[ >][\s\S]*?<\/a:tr>/g)) {
      const cells = [...tr[0].matchAll(/<a:tc[ >][\s\S]*?<\/a:tc>/g)].map((tc) => shapeParagraphs(tc[0]).join(' '));
      body.push(`| ${cells.join(' | ')} |`);
    }
  }
  return { title, body };
}

const resolveTarget = (baseFile, target) => path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), target));

async function rels(zip, file) {
  const relFile = path.posix.join(path.posix.dirname(file), '_rels', `${path.posix.basename(file)}.rels`);
  const f = zip.file(relFile);
  if (!f) return new Map();
  const xml = await f.async('string');
  const map = new Map();
  for (const m of xml.matchAll(/<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*?\/?>/g)) map.set(m[1], m[2]);
  // Attribute order varies between producers.
  for (const m of xml.matchAll(/<Relationship [^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"[^>]*?\/?>/g)) map.set(m[2], m[1]);
  return map;
}

export async function extractPptx(buffer, { fileName }) {
  const zip = await JSZip.loadAsync(buffer);
  const presFile = 'ppt/presentation.xml';
  const pres = await zip.file(presFile)?.async('string');
  if (!pres) throw new Error('This file does not look like a PowerPoint presentation (ppt/presentation.xml missing).');
  const presRels = await rels(zip, presFile);
  const order = [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => resolveTarget(presFile, presRels.get(m[1]) || ''));

  const units = [];
  let n = 0;
  for (const slidePath of order) {
    n++;
    const xml = await zip.file(slidePath)?.async('string');
    if (!xml) {
      units.push({ n, label: null, title: null, text: '', status: 'unreadable', note: 'Slide file missing', origin: { kind: 'file', file: fileName, index: n } });
      continue;
    }
    const hidden = /<p:sld [^>]*show="0"/.test(xml);
    const { title, body } = slideContent(xml);
    let notes = [];
    const slideRels = await rels(zip, slidePath);
    for (const target of slideRels.values()) {
      if (/notesSlide/i.test(target)) {
        const notesXml = await zip.file(resolveTarget(slidePath, target))?.async('string');
        if (notesXml) {
          notes = [...notesXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)]
            .filter((sp) => !/<p:ph [^>]*type="sldNum"/.test(sp[1]) && !/<p:ph [^>]*type="sldImg"/.test(sp[1]))
            .flatMap((sp) => shapeParagraphs(sp[1]));
        }
      }
    }
    const hasPictures = /<p:pic>/.test(xml);
    const parts = [];
    if (title) parts.push(`# ${title}`);
    if (body.length) parts.push(body.join('\n'));
    if (notes.length) parts.push(`Speaker notes:\n${notes.join('\n')}`);
    const text = cleanText(parts.join('\n\n'));
    units.push({
      n,
      label: null,
      labelSource: null,
      title,
      text,
      status: text ? 'ok' : 'unreadable',
      note: [hidden ? 'Hidden slide' : null, !text && hasPictures ? 'Slide contains only images; no text to extract' : null].filter(Boolean).join('; ') || null,
      origin: { kind: 'file', file: fileName, index: n },
    });
  }
  return { unitType: 'slide', units, chapters: [] };
}
