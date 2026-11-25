// Browser replacement for server/research/fetcher.js. Browsers can only download
// files from sites that allow it (CORS); failures are reported honestly.
import { config } from './config.js';

const BLOCKED_HOSTS = [
  'z-lib', 'zlibrary', 'z-library', 'libgen', 'library.lol', 'annas-archive', 'pdfdrive', 'dokumen.pub', 'ebin.pub', 'vdoc.pub',
  'epdf.pub', 'pdfcoffee', 'doku.pub', 'idoc.pub', 'ebookee', 'oceanofpdf', 'pdfroom', 'b-ok.', '1lib.', 'sci-hub', 'booksc.',
  'scribd.com', 'studocu.com', 'coursehero.com', 'documents.pub', 'fliphtml5.com', 'yumpu.com', 'pdfslide', 'dlscrib', 'kupdf',
];
export function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BLOCKED_HOSTS.some((b) => host.includes(b));
  } catch {
    return true;
  }
}
export function sniffType(buffer, contentType = '', url = '') {
  const head = new TextDecoder('latin1').decode(buffer.subarray(0, 8));
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) {
    if (/epub/.test(contentType) || /\.epub(\?|$)/i.test(url)) return 'epub';
    if (/presentation/.test(contentType) || /\.pptx(\?|$)/i.test(url)) return 'pptx';
    if (/word/.test(contentType) || /\.docx(\?|$)/i.test(url)) return 'docx';
    return 'zip';
  }
  if (/html|xml/.test(contentType)) return 'html';
  if (/text\/plain/.test(contentType) || /\.txt(\?|$)/i.test(url)) return 'text';
  const sample = new TextDecoder().decode(buffer.subarray(0, 512));
  if (/<html|<!doctype html/i.test(sample)) return 'html';
  return 'unknown';
}
export async function download(url, { maxBytes = config.maxDownloadBytes, timeoutMs = config.fetchTimeoutMs } = {}) {
  if (isBlockedHost(url)) throw new Error('This site is not used because it commonly hosts unauthorised copies of books');
  if (!/^https?:/i.test(url)) throw new Error('Only http(s) links can be retrieved');
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('The site does not allow downloads from a web page (open the link, save the file, then upload it here)');
  }
  if (!res.ok) throw new Error(`The site returned HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`File is too large (${Math.round(len / 1e6)} MB)`);
  const buffer = globalThis.Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('File is too large');
  const contentType = res.headers.get('content-type') || '';
  return { buffer, contentType, finalUrl: res.url || url, type: sniffType(buffer, contentType, url) };
}
export async function getJSON(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
