// Free bibliographic catalogs used to identify books and find legitimately
// accessible full text: Open Library, Google Books and Project Gutenberg (Gutendex).
import { getJSON } from './fetcher.js';
import { config } from '../config.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const normTitle = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function buildQuery(q) {
  return [q.title, q.author, q.edition, q.subject, q.level].map(clean).filter(Boolean).join(' ');
}

export async function searchOpenLibrary(q) {
  const params = new URLSearchParams({
    fields: 'key,title,subtitle,author_name,publisher,first_publish_year,publish_year,isbn,edition_count,number_of_pages_median,subject,ebook_access,ia,cover_i,language',
    limit: '8',
  });
  if (q.isbn) params.set('isbn', q.isbn.replace(/[^0-9Xx]/g, ''));
  else {
    if (q.title) params.set('title', q.title);
    if (q.author) params.set('author', q.author);
    if (!q.title && !q.author) params.set('q', buildQuery(q));
  }
  const data = await getJSON(`https://openlibrary.org/search.json?${params}`);
  return (data.docs || []).map((d) => ({
    catalog: 'Open Library',
    title: clean(d.title),
    subtitle: clean(d.subtitle),
    authors: d.author_name || [],
    publisher: (d.publisher || [])[0] || '',
    year: d.first_publish_year || null,
    isbns: (d.isbn || []).filter((x) => x.length === 13).slice(0, 6),
    pageCount: d.number_of_pages_median || null,
    subjects: (d.subject || []).slice(0, 6),
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    links: [{ label: 'Open Library', url: `https://openlibrary.org${d.key}` }],
    access: {
      openLibraryEbook: d.ebook_access || 'no_ebook',
      iaIds: d.ebook_access === 'public' ? (d.ia || []).slice(0, 3) : [],
    },
  }));
}

export async function searchGoogleBooks(q) {
  const terms = [];
  if (q.isbn) terms.push(`isbn:${q.isbn.replace(/[^0-9Xx]/g, '')}`);
  else {
    if (q.title) terms.push(`intitle:${q.title}`);
    if (q.author) terms.push(`inauthor:${q.author}`);
    if (!q.title && !q.author) terms.push(buildQuery(q));
    if (q.edition && q.title) terms.push(q.edition);
  }
  const params = new URLSearchParams({ q: terms.join(' '), maxResults: '8', printType: 'books' });
  if (config.googleBooksKey) params.set('key', config.googleBooksKey);
  const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?${params}`);
  return (data.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const a = it.accessInfo || {};
    return {
      catalog: 'Google Books',
      title: clean(v.title),
      subtitle: clean(v.subtitle),
      authors: v.authors || [],
      publisher: v.publisher || '',
      year: v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) || null : null,
      publishedDate: v.publishedDate || '',
      isbns: (v.industryIdentifiers || []).filter((x) => x.type === 'ISBN_13').map((x) => x.identifier),
      pageCount: v.pageCount || null,
      subjects: v.categories || [],
      description: clean(v.description).slice(0, 600),
      coverUrl: v.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
      links: [{ label: 'Google Books', url: v.infoLink || v.previewLink }].filter((l) => l.url),
      access: {
        googleViewability: a.viewability || 'UNKNOWN',
        publicDomain: Boolean(a.publicDomain),
        epubDownload: a.epub?.downloadLink || null,
        pdfDownload: a.pdf?.downloadLink || null,
        webReader: a.webReaderLink || null,
      },
    };
  });
}

export async function searchGutenberg(q) {
  const search = [q.title, q.author].map(clean).filter(Boolean).join(' ');
  if (!search) return [];
  const data = await getJSON(`https://gutendex.com/books/?search=${encodeURIComponent(search)}`);
  return (data.results || []).slice(0, 5).map((b) => {
    const f = b.formats || {};
    const txt = Object.entries(f).find(([k, v]) => k.startsWith('text/plain') && !/\.zip$/.test(v))?.[1] || null;
    return {
      catalog: 'Project Gutenberg',
      title: clean(b.title),
      subtitle: '',
      authors: (b.authors || []).map((a) => a.name),
      publisher: 'Project Gutenberg (public domain)',
      year: null,
      isbns: [],
      pageCount: null,
      subjects: (b.subjects || []).slice(0, 5),
      coverUrl: f['image/jpeg'] || null,
      links: [{ label: 'Project Gutenberg', url: `https://www.gutenberg.org/ebooks/${b.id}` }],
      access: {
        publicDomain: b.copyright === false,
        gutenbergId: b.id,
        gutenbergText: txt,
        gutenbergEpub: f['application/epub+zip'] || null,
      },
    };
  });
}

/** Query every catalog in parallel; failures are reported, not thrown. */
export async function searchCatalogs(q) {
  const tasks = [
    ['Open Library', searchOpenLibrary],
    ['Google Books', searchGoogleBooks],
    ['Project Gutenberg', searchGutenberg],
  ];
  const settled = await Promise.allSettled(tasks.map(([, fn]) => fn(q)));
  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push(...s.value);
    else errors.push(`${tasks[i][0]}: ${s.reason?.message || 'unavailable'}`);
  });
  return { results, errors };
}

/** Merge catalog hits that describe the same edition (shared ISBN, or same title+author+year). */
export function mergeCandidates(hits) {
  const out = [];
  for (const h of hits) {
    if (!h.title) continue;
    const match = out.find(
      (c) =>
        (h.isbns.length && c.isbns.some((i) => h.isbns.includes(i))) ||
        (normTitle(c.title) === normTitle(h.title) && normTitle(c.authors[0]) === normTitle(h.authors[0]) && (c.year === h.year || !c.year || !h.year) && c.catalog !== h.catalog && !(c.catalogs || []).includes(h.catalog)),
    );
    if (match) {
      match.catalogs = [...new Set([...(match.catalogs || [match.catalog]), h.catalog])];
      match.isbns = [...new Set([...match.isbns, ...h.isbns])];
      match.links.push(...h.links);
      match.access = { ...h.access, ...match.access };
      for (const k of ['publisher', 'year', 'pageCount', 'coverUrl', 'description', 'subtitle']) if (!match[k] && h[k]) match[k] = h[k];
    } else {
      out.push({ ...h, catalogs: [h.catalog], links: [...h.links] });
    }
  }
  return out;
}
