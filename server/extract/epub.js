// EPUB extraction: one unit per spine document (usually a chapter), titled from
// the book's table of contents (EPUB3 nav or EPUB2 NCX).
import JSZip from 'jszip';
import path from 'node:path';
import { htmlToText, decodeEntities, htmlTitle } from './text.js';

const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

export async function extractEpub(buffer, { fileName }) {
  const zip = await JSZip.loadAsync(buffer);
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error('This EPUB has no package file (META-INF/container.xml is missing or invalid).');
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) throw new Error('EPUB package file not found.');
  const base = path.posix.dirname(opfPath);
  const resolve = (href) => path.posix.normalize(path.posix.join(base, decodeURIComponent(href.split('#')[0])));

  const manifest = new Map();
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const id = attr(m[0], 'id');
    if (id) manifest.set(id, { href: attr(m[0], 'href'), type: attr(m[0], 'media-type'), props: attr(m[0], 'properties') || '' });
  }
  const spine = [...opf.matchAll(/<itemref\s[^>]*>/g)]
    .map((m) => ({ idref: attr(m[0], 'idref'), linear: attr(m[0], 'linear') !== 'no' }))
    .filter((s) => manifest.has(s.idref));

  const bookTitle = decodeEntities(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] || '').trim() || null;
  const bookAuthor = decodeEntities(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/.exec(opf)?.[1] || '').trim() || null;

  // Table of contents → title per document path.
  const tocTitles = new Map();
  const navItem = [...manifest.values()].find((i) => i.props.includes('nav'));
  if (navItem) {
    const navPath = resolve(navItem.href);
    const nav = await zip.file(navPath)?.async('string');
    if (nav) {
      for (const a of nav.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(navPath), decodeURIComponent(a[1].split('#')[0])));
        const title = decodeEntities(a[2].replace(/<[^>]+>/g, '')).trim();
        if (title && !tocTitles.has(target)) tocTitles.set(target, title);
      }
    }
  }
  if (!tocTitles.size) {
    const ncxItem = [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxPath = resolve(ncxItem.href);
      const ncx = await zip.file(ncxPath)?.async('string');
      if (ncx) {
        for (const np of ncx.matchAll(/<navPoint[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content [^>]*src="([^"]+)"/g)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(ncxPath), decodeURIComponent(np[2].split('#')[0])));
          if (!tocTitles.has(target)) tocTitles.set(target, decodeEntities(np[1]).trim());
        }
      }
    }
  }

  const units = [];
  let n = 0;
  for (const s of spine) {
    const item = manifest.get(s.idref);
    if (!/html|xml/.test(item.type || '')) continue;
    const docPath = resolve(item.href);
    const html = await zip.file(docPath)?.async('string');
    n++;
    if (!html) {
      units.push({ n, label: null, title: null, text: '', status: 'unreadable', note: 'Chapter file missing', origin: { kind: 'file', file: fileName, index: n } });
      continue;
    }
    const text = htmlToText(html);
    const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)?.[1];
    const title = tocTitles.get(docPath) || (heading ? decodeEntities(heading.replace(/<[^>]+>/g, '')).trim() : null) || htmlTitle(html) || `Section ${n}`;
    units.push({
      n,
      label: null,
      labelSource: null,
      title,
      text,
      status: text ? 'ok' : 'unreadable',
      note: text ? null : 'No text in this part (cover or image page)',
      origin: { kind: 'file', file: fileName, index: n },
    });
  }
  return { unitType: 'chapter', units, chapters: [], meta: { title: bookTitle, author: bookAuthor } };
}
