// Book research pipeline:
//   1. identify  – catalogs (+ Claude web search) → candidate editions; the user picks one
//   2. research  – Claude web search/fetch locates legitimate sources and the table of contents
//   3. retrieve  – the server downloads what is genuinely accessible and extracts real pages
// Nothing is ever invented: only text that was actually downloaded and extracted becomes material.
import { z } from 'zod';
import { searchCatalogs, mergeCandidates, normTitle } from './catalogs.js';
import { download, isBlockedHost } from './fetcher.js';
import { extractFile } from '../extract/index.js';
import { htmlToText, htmlTitle, cleanText } from '../extract/text.js';
import { aiAvailable, runWebAgent } from '../ai.js';
import { getUnits, setUnits, sources as sourceStore, newId, now } from '../store.js';

// ---------------------------------------------------------------- identify

const CandidateSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  authors: z.array(z.string()),
  publisher: z.string(),
  edition: z.string().describe('Edition / version, e.g. "2nd edition (2019)", "Pupil Book 6A". Empty if unknown.'),
  year: z.number().int().nullable(),
  isbn13s: z.array(z.string()),
  series: z.string(),
  subject: z.string(),
  level: z.string().describe('Grade / year / age range if stated, else empty'),
  pageCount: z.number().int().nullable(),
  description: z.string(),
  distinguishingNotes: z.string().describe('How this differs from similarly titled books or other editions'),
  evidenceUrls: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
});
const IdentifySchema = z.object({
  candidates: z.array(CandidateSchema),
  notes: z.string(),
});

const IDENTIFY_SYSTEM = `You are a meticulous bibliographic researcher for a study app. You identify exactly which book (and which edition) a student means.
Rules:
- Use web search to verify title, author(s), publisher, edition, year and ISBN. Prefer publisher pages, national library and bookseller catalogues.
- Never merge different editions, volumes (e.g. "6A" vs "6B"), pupil books vs. teacher guides vs. workbooks. List them separately.
- Only report facts you saw in search results or fetched pages; leave fields empty or null when unverified.
- Give 1–6 candidates ordered by how well they match the request. Mark confidence honestly.`;

function catalogToCandidate(c) {
  return {
    id: newId('cand'),
    title: c.title,
    subtitle: c.subtitle || '',
    authors: c.authors || [],
    publisher: c.publisher || '',
    edition: '',
    year: c.year || null,
    isbn13s: c.isbns || [],
    series: '',
    subject: (c.subjects || []).slice(0, 2).join(', '),
    level: '',
    pageCount: c.pageCount || null,
    description: c.description || '',
    distinguishingNotes: '',
    evidenceUrls: c.links.map((l) => l.url),
    links: c.links,
    confidence: 'medium',
    coverUrl: c.coverUrl || null,
    catalogs: c.catalogs || [c.catalog],
    access: c.access || {},
    origin: 'catalog',
  };
}

export async function identifyBook(sourceId, ctx) {
  const source = sourceStore.get(sourceId);
  const q = source.query;
  ctx.log('Searching book catalogues (Open Library, Google Books, Project Gutenberg)…');
  const { results, errors } = await searchCatalogs(q);
  errors.forEach((e) => ctx.log(`Catalogue unavailable — ${e}`));
  const catalogCandidates = mergeCandidates(results).slice(0, 10).map(catalogToCandidate);
  ctx.log(`Catalogues returned ${catalogCandidates.length} possible match(es).`);

  let aiCandidates = [];
  let notes = '';
  if (aiAvailable()) {
    ctx.log('Researching the book on the web to confirm the exact edition…');
    const hint = catalogCandidates
      .slice(0, 8)
      .map((c) => `- ${c.title}${c.subtitle ? `: ${c.subtitle}` : ''} | ${c.authors.join(', ')} | ${c.publisher} | ${c.year || '?'} | ISBN ${c.isbn13s.join('/') || '?'}`)
      .join('\n');
    const prompt = `The student wants this book:
Title: ${q.title || '(not given)'}
Author: ${q.author || '(not given)'}
ISBN: ${q.isbn || '(not given)'}
Edition: ${q.edition || '(not given)'}
Subject: ${q.subject || '(not given)'}
Grade/level: ${q.level || '(not given)'}

Catalogue hits (may be incomplete or wrong):
${hint || '(none — catalogues were unavailable or found nothing)'}

Identify the book and any similarly titled books/editions the student could mean. Then call submit_candidates.`;
    try {
      const { result } = await runWebAgent({
        system: IDENTIFY_SYSTEM,
        prompt,
        submitName: 'submit_candidates',
        submitDescription: 'Submit the identified candidate books/editions. Call exactly once when done.',
        schema: IdentifySchema,
        searchUses: 6,
        fetchUses: 4,
        effort: 'medium',
        onEvent: (e) => ctx.log(eventText(e)),
      });
      aiCandidates = result.candidates.map((c) => ({
        ...c,
        id: newId('cand'),
        links: c.evidenceUrls.map((u) => ({ label: hostOf(u), url: u })),
        origin: 'web-research',
        catalogs: [],
        access: {},
      }));
      notes = result.notes;
    } catch (err) {
      ctx.log(`Web research for identification failed: ${err.userMessage || err.message}`);
    }
  } else {
    ctx.log('AI web research is not connected, so only catalogue results are shown.');
  }

  // Attach catalogue access info (public domain, Gutenberg ids…) to matching AI candidates.
  for (const a of aiCandidates) {
    const m = catalogCandidates.find((c) => (a.isbn13s.length && c.isbn13s.some((i) => a.isbn13s.includes(i))) || normTitle(c.title) === normTitle(a.title));
    if (m) {
      a.access = { ...m.access };
      a.coverUrl = a.coverUrl || m.coverUrl;
      a.catalogs = m.catalogs;
      a.links = [...a.links, ...m.links];
    }
  }
  const seen = new Set(aiCandidates.map((a) => `${normTitle(a.title)}|${a.isbn13s[0] || ''}`));
  const extra = catalogCandidates.filter((c) => !seen.has(`${normTitle(c.title)}|${c.isbn13s[0] || ''}`) && !aiCandidates.some((a) => c.isbn13s.length && c.isbn13s.some((i) => a.isbn13s.includes(i))));
  const candidates = [...aiCandidates, ...extra].slice(0, 12);

  sourceStore.patch(sourceId, {
    candidates,
    research: { ...(source.research || {}), identifyNotes: notes, identifyErrors: errors, identifiedAt: now() },
  });
  ctx.log(candidates.length ? `Found ${candidates.length} candidate(s). Choose the correct one.` : 'No matching books were found. Check the spelling, add the author or ISBN, or upload the book.');
  return { count: candidates.length };
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

function eventText(e) {
  switch (e.kind) {
    case 'search':
      return `Searching the web: “${e.text}”`;
    case 'fetch':
      return `Reading ${hostOf(e.text)}…`;
    case 'fetched':
      return `Read ${hostOf(e.text) || 'page'}`;
    case 'fetch_failed':
      return `Could not read ${hostOf(e.text) || 'a page'}`;
    case 'results':
      return `Search returned ${e.text}`;
    default:
      return e.text;
  }
}

// ---------------------------------------------------------------- research

const ResearchSchema = z.object({
  verifiedIdentity: z.object({
    title: z.string(),
    authors: z.array(z.string()),
    publisher: z.string(),
    edition: z.string(),
    year: z.number().int().nullable(),
    isbn13: z.string(),
    pageCount: z.number().int().nullable(),
    matchesChosenEdition: z.boolean(),
    notes: z.string(),
  }),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      host: z.string(),
      type: z.enum(['full_text', 'sample_pages', 'preview', 'table_of_contents', 'teacher_resource', 'answers', 'metadata', 'related_material']),
      license: z.enum(['public_domain', 'open_license', 'publisher_sample', 'publisher_page', 'preview_only', 'paywalled', 'unknown']),
      format: z.enum(['pdf', 'html', 'epub', 'txt', 'viewer', 'other']),
      directFileUrl: z.string().describe('Direct URL of the PDF/EPUB/TXT file if one exists, else empty'),
      pagesCovered: z.string().describe('Exactly which printed pages/chapters this source shows, as you observed them, e.g. "pp. 4-11". "unknown" if not observed.'),
      printedPageStart: z.number().int().nullable().describe('First printed book page number contained in the file, if observed'),
      edition: z.string().describe('Edition shown by this source, if stated'),
      sameEdition: z.enum(['yes', 'no', 'unsure']),
      access: z.enum(['retrievable', 'view_only', 'none']),
      description: z.string(),
    }),
  ),
  tableOfContents: z.array(z.object({ title: z.string(), startPage: z.number().int().nullable(), endPage: z.number().int().nullable() })),
  pageNumberingNotes: z.string(),
  limitations: z.array(z.string()),
  assessment: z.string(),
});

const RESEARCH_SYSTEM = `You are a research librarian for a study app. A student has chosen a specific book edition. Find LEGITIMATE, accessible sources of its actual content.
Legitimate sources: the publisher's own site (sample pages, look-inside PDFs, free resources), open-licensed textbooks (OpenStax, LibreTexts, CK-12, OER Commons…), public-domain texts (Project Gutenberg, Wikisource, Internet Archive public-domain scans), official government/school curriculum pages, Google Books previews, author pages.
NEVER use or list piracy or unauthorised-copy sites (shadow libraries, PDF-dump sites, user-uploaded document sharing sites such as Scribd or Studocu).
Honesty rules:
- Report only what you actually saw. For each source, state precisely which printed pages or chapters it contains as observed; use "unknown" if you did not see the page numbers.
- Do not describe or guess the contents of pages you did not see.
- Distinguish the chosen edition from other editions; mark sameEdition honestly.
- If a table of contents is visible anywhere, record it with printed page numbers.
- Record any difference between printed page numbers and PDF page positions in pageNumberingNotes.
- Explain limitations plainly (e.g. "only pages 4–11 are available as a publisher sample").`;

function identityText(id) {
  return [
    `Title: ${id.title}${id.subtitle ? `: ${id.subtitle}` : ''}`,
    `Author(s): ${(id.authors || []).join(', ') || 'unknown'}`,
    `Publisher: ${id.publisher || 'unknown'}`,
    `Edition: ${id.edition || 'unknown'}`,
    `Year: ${id.year || 'unknown'}`,
    `ISBN-13: ${(id.isbn13s || []).join(', ') || 'unknown'}`,
    id.series ? `Series: ${id.series}` : null,
    id.level ? `Level: ${id.level}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function stripGutenberg(text) {
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  let body = text;
  if (start >= 0) body = body.slice(body.indexOf('\n', start) + 1);
  if (end >= 0) body = body.slice(0, body.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i));
  return body;
}

/** Split a long public-domain text into chapters. */
export function splitChapters(text) {
  const re = /^(?:(?:CHAPTER|Chapter|BOOK|Book|PART|Part|ACT|Act|STAVE|Stave|LETTER|Letter)\s+(?:[IVXLCDM]+|\d+|[A-Z][a-z]+)\b[^\n]*|[IVXLC]+\.\s+[A-Z][^\n]{0,60})$/gm;
  const marks = [...text.matchAll(re)].map((m) => ({ index: m.index, title: m[0].trim() }));
  if (marks.length < 2) {
    const parts = [];
    const paras = text.split(/\n{2,}/);
    let cur = '';
    for (const p of paras) {
      if (cur.length + p.length > 12000 && cur) {
        parts.push(cur);
        cur = '';
      }
      cur += (cur ? '\n\n' : '') + p;
    }
    if (cur) parts.push(cur);
    return parts.map((t, i) => ({ title: `Part ${i + 1}`, text: cleanText(t) }));
  }
  const chapters = [];
  if (marks[0].index > 400) chapters.push({ title: 'Front matter', text: cleanText(text.slice(0, marks[0].index)) });
  marks.forEach((m, i) => {
    const body = text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : text.length);
    chapters.push({ title: m.title.replace(/\s+/g, ' '), text: cleanText(body) });
  });
  return chapters.filter((c) => c.text.length > 30);
}

function webOrigin(src, extra = {}) {
  return { kind: 'web', url: src.url, name: src.title || hostOf(src.url), license: src.license, ...extra };
}

async function retrieveSource(src, ctx) {
  const url = src.directFileUrl || src.url;
  ctx.log(`Downloading ${hostOf(url)}…`);
  const dl = await download(url);
  if (dl.type === 'pdf' || dl.type === 'epub' || dl.type === 'docx' || dl.type === 'pptx') {
    const ext = { pdf: '.pdf', epub: '.epub', docx: '.docx', pptx: '.pptx' }[dl.type];
    const res = await extractFile({ buffer: dl.buffer, fileName: `${hostOf(url)}${ext}`, mime: dl.contentType, log: ctx.log });
    // If the research step observed the first printed page and the file has no labels, apply it.
    if (res.unitType === 'page' && src.printedPageStart && !res.units.some((u) => u.labelSource === 'pdf')) {
      res.units.forEach((u, i) => {
        u.label = String(src.printedPageStart + i);
        u.labelSource = 'research';
      });
    }
    res.units.forEach((u) => (u.origin = webOrigin(src, { url: dl.finalUrl, index: u.n })));
    return { unitType: res.unitType, units: res.units, chapters: res.chapters, numbering: res.numbering };
  }
  if (dl.type === 'html' || dl.type === 'text') {
    const raw = dl.buffer.toString('utf8');
    const text = dl.type === 'html' ? htmlToText(raw) : raw;
    const title = dl.type === 'html' ? htmlTitle(raw) : src.title;
    if (cleanText(text).length < 400) throw new Error('The page has almost no readable text (it may need a browser or login)');
    return {
      unitType: 'page',
      units: [{ n: 1, label: null, labelSource: null, title: title || src.title, text: cleanText(text).slice(0, 400000), status: 'ok', origin: webOrigin(src, { url: dl.finalUrl }) }],
      chapters: [],
    };
  }
  throw new Error(`Unrecognised file type (${dl.contentType || 'unknown'})`);
}

async function retrieveGutenberg(access, ctx) {
  ctx.log('Downloading the public-domain text from Project Gutenberg…');
  const dl = await download(access.gutenbergText, { accept: 'text/plain' });
  const body = stripGutenberg(dl.buffer.toString('utf8'));
  const chapters = splitChapters(body);
  return chapters.map((c, i) => ({
    n: i + 1,
    label: null,
    labelSource: null,
    title: c.title,
    text: c.text,
    status: 'ok',
    origin: { kind: 'web', url: `https://www.gutenberg.org/ebooks/${access.gutenbergId}`, name: 'Project Gutenberg', license: 'public_domain' },
  }));
}

/** Merge newly retrieved units into a book's units (dedupe by printed label). */
export function mergeUnits(existing, incoming) {
  const out = [...existing];
  for (const u of incoming) {
    const dup = u.label ? out.findIndex((x) => x.label && x.label === u.label) : -1;
    if (dup >= 0) {
      if (!(out[dup].text && out[dup].status !== 'unreadable')) out[dup] = u; // fill a gap
    } else out.push(u);
  }
  // Sort: printed numeric labels first in order, then unlabeled in arrival order.
  const labelled = out.filter((u) => u.label && /^\d+$/.test(u.label)).sort((a, b) => Number(a.label) - Number(b.label));
  const other = out.filter((u) => !(u.label && /^\d+$/.test(u.label)));
  return [...other.filter((u) => u.label), ...labelled, ...other.filter((u) => !u.label)].map((u, i) => ({ ...u, n: i + 1 }));
}

export async function researchBook(sourceId, ctx) {
  let source = sourceStore.get(sourceId);
  const identity = source.identity;
  const research = { ...(source.research || {}), sources: [], limitations: [], log: [], researchedAt: null };
  let units = getUnits(sourceId).filter((u) => u.origin?.kind !== 'web'); // keep user uploads, refresh web content
  let unitType = source.unitType || 'page';
  let completeText = false;
  let chapters = source.chapters || [];
  const retrieval = [];

  // 1) Public-domain full text known from catalogues.
  if (identity.access?.gutenbergText && identity.access?.publicDomain !== false) {
    try {
      const gUnits = await retrieveGutenberg(identity.access, ctx);
      if (gUnits.length) {
        units = gUnits.concat(units.map((u, i) => ({ ...u, n: gUnits.length + i + 1 })));
        unitType = 'chapter';
        completeText = true;
        chapters = [];
        retrieval.push({ url: `https://www.gutenberg.org/ebooks/${identity.access.gutenbergId}`, title: 'Project Gutenberg full text', type: 'full_text', license: 'public_domain', retrieved: true, units: gUnits.length });
        ctx.log(`Retrieved the full public-domain text: ${gUnits.length} chapter(s).`);
      }
    } catch (err) {
      ctx.log(`Project Gutenberg download failed: ${err.message}`);
      retrieval.push({ url: identity.access.gutenbergText, title: 'Project Gutenberg', type: 'full_text', license: 'public_domain', retrieved: false, error: err.message });
    }
  }
  // Google Books public-domain downloads
  if (!completeText && identity.access?.publicDomain && (identity.access.epubDownload || identity.access.pdfDownload)) {
    const url = identity.access.epubDownload || identity.access.pdfDownload;
    try {
      const got = await retrieveSource({ url, title: 'Google Books (public domain)', license: 'public_domain' }, ctx);
      units = mergeUnits(units, got.units);
      unitType = got.unitType;
      completeText = true;
      retrieval.push({ url, title: 'Google Books public-domain download', type: 'full_text', license: 'public_domain', retrieved: true, units: got.units.length });
    } catch (err) {
      retrieval.push({ url, title: 'Google Books public-domain download', type: 'full_text', license: 'public_domain', retrieved: false, error: err.message });
    }
  }

  // 2) AI web research for legitimate sources (publisher samples, OER, previews, ToC).
  let agentResult = null;
  if (aiAvailable()) {
    ctx.log('Searching the web for legitimate sources of this book’s content…');
    const sel = source.selection?.mode === 'custom' ? `The student wants: ${source.selection.ranges || ''}${source.selection.exclude ? ` (excluding ${source.selection.exclude})` : ''}.` : 'The student has not chosen pages yet.';
    try {
      const { result } = await runWebAgent({
        system: RESEARCH_SYSTEM,
        prompt: `Chosen book:\n${identityText(identity)}\n\n${sel}\n${completeText ? 'A complete public-domain text has already been retrieved; focus on verifying the edition and finding the table of contents.' : ''}\nFind legitimate accessible sources of this exact book's content (and its table of contents), check what each contains, then call submit_research.`,
        submitName: 'submit_research',
        submitDescription: 'Submit the research findings about accessible sources for the chosen book. Call exactly once.',
        schema: ResearchSchema,
        searchUses: 10,
        fetchUses: 10,
        effort: 'high',
        maxTurns: 10,
        onEvent: (e) => ctx.log(eventText(e)),
      });
      agentResult = result;
    } catch (err) {
      ctx.log(`Web research failed: ${err.userMessage || err.message}`);
      research.limitations.push(`Web research could not be completed: ${err.userMessage || err.message}`);
    }
  } else {
    research.limitations.push('AI web research is not connected (no ANTHROPIC_API_KEY), so only catalogue sources were checked.');
  }

  // 3) Retrieve what is genuinely downloadable.
  if (agentResult) {
    const candidates = agentResult.sources
      .filter((s) => s.access === 'retrievable' && s.sameEdition !== 'no' && ['full_text', 'sample_pages', 'preview', 'teacher_resource', 'table_of_contents'].includes(s.type))
      .filter((s) => ['public_domain', 'open_license', 'publisher_sample', 'publisher_page', 'unknown'].includes(s.license))
      .slice(0, 6);
    for (const s of agentResult.sources) {
      const entry = { ...s, retrieved: false };
      if (isBlockedHost(s.url) || (s.directFileUrl && isBlockedHost(s.directFileUrl))) {
        entry.error = 'Not used: the site commonly hosts unauthorised copies';
      } else if (candidates.includes(s) && !(completeText && s.type !== 'table_of_contents')) {
        try {
          const got = await retrieveSource(s, ctx);
          if (unitType !== got.unitType && !units.length) unitType = got.unitType;
          const readable = got.units.filter((u) => u.text).length;
          units = mergeUnits(units, got.units.filter((u) => u.text || u.status === 'unreadable'));
          entry.retrieved = readable > 0;
          entry.units = readable;
          if (got.numbering?.note) entry.numberingNote = got.numbering.note;
          if (s.type === 'full_text' && ['public_domain', 'open_license'].includes(s.license) && readable > 0) completeText = true;
          ctx.log(`Retrieved ${readable} readable page(s) from ${hostOf(s.url)}.`);
        } catch (err) {
          entry.error = err.message;
          ctx.log(`Could not retrieve ${hostOf(s.url)}: ${err.message}`);
        }
      } else if (s.access !== 'retrievable') {
        entry.error = s.access === 'view_only' ? 'View-only preview: the content can be read in a browser but not downloaded' : 'Not accessible';
      }
      retrieval.push(entry);
    }
    if (agentResult.tableOfContents?.length && !completeText) {
      chapters = agentResult.tableOfContents
        .filter((t) => t.startPage)
        .map((t, i, arr) => ({ title: t.title, depth: 0, start: t.startPage, end: t.endPage || (arr[i + 1]?.startPage ? arr[i + 1].startPage - 1 : t.startPage), numbering: 'printed' }));
    }
    research.limitations.push(...agentResult.limitations);
    research.assessment = agentResult.assessment;
    research.pageNumberingNotes = agentResult.pageNumberingNotes;
    research.verifiedIdentity = agentResult.verifiedIdentity;
    research.tableOfContents = agentResult.tableOfContents;
  }

  research.sources = retrieval.map((r) => ({
    url: r.url,
    title: r.title,
    host: hostOf(r.url),
    type: r.type,
    license: r.license,
    format: r.format || null,
    pagesCovered: r.pagesCovered || null,
    edition: r.edition || null,
    sameEdition: r.sameEdition || null,
    access: r.retrieved ? 'retrieved' : r.access || 'none',
    retrieved: Boolean(r.retrieved),
    units: r.units || 0,
    error: r.error || null,
    description: r.description || '',
    numberingNote: r.numberingNote || null,
  }));
  research.researchedAt = now();
  const readable = units.filter((u) => u.text).length;
  if (!readable) research.limitations.push('No page content of this book could be retrieved from legitimate sources. Upload the pages you need (photo, scan or PDF) to study them.');
  else if (!completeText) research.limitations.push(`Only ${readable} page(s)/section(s) of this book were retrieved. Pages outside these are not available unless you upload them.`);

  setUnits(sourceId, units);
  source = sourceStore.patch(sourceId, { research, unitType, completeText, chapters });
  ctx.log(readable ? `Research finished: ${readable} readable unit(s) retrieved.` : 'Research finished: no content could be retrieved.');
  return { readable, completeText };
}
