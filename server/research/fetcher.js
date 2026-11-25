// Safe server-side downloads for research sources: http(s) only, no private
// network addresses, size and time limits, and a blocklist of sites that host
// unauthorised copies of books.
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

const UA = 'PeterParkerStudy/1.0 (personal study research tool)';

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

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:127.') || v6.startsWith('::ffff:10.') || v6.startsWith('::ffff:192.168.');
}

async function assertPublicUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links can be retrieved');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new Error('Local addresses are not allowed');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private network addresses are not allowed');
  return u;
}

export function sniffType(buffer, contentType = '', url = '') {
  const head = buffer.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) {
    if (/epub/.test(contentType) || /\.epub(\?|$)/i.test(url)) return 'epub';
    if (/presentation/.test(contentType) || /\.pptx(\?|$)/i.test(url)) return 'pptx';
    if (/word/.test(contentType) || /\.docx(\?|$)/i.test(url)) return 'docx';
    return 'zip';
  }
  if (/html|xml/.test(contentType)) return 'html';
  if (/text\/plain/.test(contentType) || /\.txt(\?|$)/i.test(url)) return 'text';
  const sample = buffer.subarray(0, 512).toString('utf8');
  if (/<html|<!doctype html/i.test(sample)) return 'html';
  return 'unknown';
}

/** Download a URL with limits. Returns { buffer, contentType, finalUrl, type }. */
export async function download(url, { maxBytes = config.maxDownloadBytes, timeoutMs = config.fetchTimeoutMs, accept } = {}) {
  if (isBlockedHost(url)) throw new Error('This site is not used because it commonly hosts unauthorised copies of books');
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: accept || 'application/pdf,application/epub+zip,text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      if (isBlockedHost(current)) throw new Error('Redirected to a site that is not used');
      continue;
    }
    if (!res.ok) throw new Error(`The site returned HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) throw new Error(`File is too large (${Math.round(len / 1e6)} MB)`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`File is too large (over ${Math.round(maxBytes / 1e6)} MB)`);
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    const contentType = res.headers.get('content-type') || '';
    return { buffer, contentType, finalUrl: current, type: sniffType(buffer, contentType, current) };
  }
  throw new Error('Too many redirects');
}

/** Fetch JSON from a public API with a timeout. */
export async function getJSON(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
