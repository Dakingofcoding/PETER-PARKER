// Shared UI helpers: escaping, icons, toasts, modals, drawers, Markdown with citations.
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { api } from './api.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H19"/>',
  books: '<path d="M4 4h4v16H4z"/><path d="M10 4h4v16h-4z"/><path d="m16.5 5 3.5-1 3 15.5-3.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8 20h8"/>',
  text: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  summary: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  quiz: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/>',
  study: '<path d="M2 9 12 4l10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  combine: '<circle cx="8" cy="12" r="5"/><circle cx="16" cy="12" r="5"/>',
  compare: '<path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h5"/><path d="M16 16h5"/>',
  revision: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>',
  steps: '<path d="M4 20h4v-4h4v-4h4V8h4"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  sparkle: '<path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="m6 6 2.5 2.5"/><path d="m15.5 15.5 2.5 2.5"/><path d="m6 18 2.5-2.5"/><path d="m15.5 8.5 2.5-2.5"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m17 6 3 3"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};
export const icon = (name, cls = '') => `<svg class="${cls}" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.info}</svg>`;

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}
export const toastError = (err) => toast(err?.message || String(err), 'bad');

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const STATUS_STYLE = {
  unidentified: 'warn', identified: 'info', researching: 'accent busy', processing: 'accent busy', content_found: 'info',
  partial: 'warn', full_selected: 'ok', limited: 'warn', needs_upload: 'bad', error: 'bad',
};
export const statusBadge = (status, label) => `<span class="badge ${STATUS_STYLE[status] || ''}"><span class="dot"></span>${esc(label || status)}</span>`;

export const kindIcon = (s) => icon(s.kind === 'book' ? 'book' : s.kind === 'pasted' ? 'text' : s.unitType === 'slide' ? 'slides' : 'file');

// ---------------- modal ----------------
export function modal({ title, body, actions = [], onMount, wide }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="overlay" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt" style="${wide ? 'width:min(760px,100%)' : ''}">
      <div class="modal-head row between"><h2 id="mt" style="margin:0">${esc(title)}</h2><button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-act="${i}">${a.label}</button>`).join('')}</div></div>`;
    const close = (val) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => e.key === 'Escape' && close(null);
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-act]');
      if (b) {
        const a = actions[Number(b.dataset.act)];
        const v = a.value ? await a.value(wrap) : a.label;
        if (v !== false) close(v);
      }
    });
    root.appendChild(wrap);
    onMount?.(wrap, close);
    setTimeout(() => (wrap.querySelector('input,textarea,select') || wrap.querySelector('[data-act]'))?.focus(), 30);
  });
}
export const confirmDialog = (title, text, label = 'Confirm', kind = 'primary') =>
  modal({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel', value: () => null }, { label, kind, value: () => true }] });

// ---------------- drawer ----------------
export function drawer(title, bodyHtml, sub = '') {
  const root = $('#drawer-root');
  root.innerHTML = `<div class="overlay" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="drawer-head"><div><h2 style="margin:0">${esc(title)}</h2>${sub ? `<div class="muted small">${sub}</div>` : ''}</div><button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="drawer-body">${bodyHtml}</div></aside>`;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  return { el: root.querySelector('.drawer-body'), close };
}

// ---------------- markdown + citations ----------------
marked.setOptions({ gfm: true, breaks: false });
const CITE_SRC = String.raw`\[(S\d+)\s+((?:pdf-)?p\.|slide |ch\.|sec\.|part )\s?([0-9ivxlcdm]+)(?:\s*[-–]\s*(?:(?:pdf-)?p\.|slide |ch\.|sec\.|part )?\s?([0-9ivxlcdm]+))?\]`;
const CITE_TEST = new RegExp(CITE_SRC, 'i');
const CITE = /\[(S\d+)\s+((?:pdf-)?p\.|slide |ch\.|sec\.|part )\s?([0-9ivxlcdm]+)(?:\s*[-–]\s*(?:(?:pdf-)?p\.|slide |ch\.|sec\.|part )?\s?([0-9ivxlcdm]+))?\]/gi;

/**
 * Render Markdown safely and turn [S1 p.12] citations into buttons.
 * sources: [{ key, id, title }] from materialMeta. invalid: Set of citation strings that failed verification.
 */
export function renderMarkdown(md, { sources = [], invalid } = {}) {
  const html = DOMPurify.sanitize(marked.parse(String(md || '')), { USE_PROFILES: { html: true } });
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (CITE_TEST.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest('code,pre')) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    for (const m of text.matchAll(CITE)) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const [full, key, prefix, a, b] = m;
      const src = byKey.get(key.toUpperCase());
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cite${!src || invalid?.has(full) ? ' bad' : ''}`;
      btn.dataset.cite = '1';
      btn.dataset.source = src?.id || '';
      btn.dataset.key = key.toUpperCase();
      const p = prefix.toLowerCase();
      const refs = [];
      if (b && /^\d+$/.test(a) && /^\d+$/.test(b) && Number(b) - Number(a) < 15) for (let k = Number(a); k <= Number(b); k++) refs.push(`${p}${k}`);
      else refs.push(`${p}${a}`, ...(b ? [`${p}${b}`] : []));
      btn.dataset.refs = refs.join(',');
      btn.title = src ? `Where did this come from? ${src.title}` : 'This citation does not match a selected source';
      btn.textContent = `${key.toUpperCase()} ${prefix.trim()}${prefix.endsWith(' ') ? ' ' : ''}${a}${b ? `–${b}` : ''}`;
      frag.appendChild(btn);
      last = m.index + full.length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
  tpl.content.querySelectorAll('blockquote').forEach((bq) => {
    const t = bq.textContent.trim();
    if (/^beyond the source/i.test(t)) bq.classList.add('beyond');
    else if (/^⚠|sources differ/i.test(t)) bq.classList.add('differ');
  });
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  const div = document.createElement('div');
  div.appendChild(tpl.content);
  return div.innerHTML;
}

function highlight(text, quote) {
  const safe = esc(text);
  if (!quote || quote.length < 8) return safe;
  const q = esc(quote.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try {
    return safe.replace(new RegExp(q, 'i'), (m) => `<mark>${m}</mark>`);
  } catch {
    return safe;
  }
}

/** Open the "Where did this come from?" drawer for a citation button or a sourceRef. */
export async function showSource({ sourceId, refs, key, quote, quoteStatus }) {
  if (!sourceId) {
    drawer('Source not found', `<div class="alert bad">${icon('warn')}<div>This citation (${esc(key)}) does not match any source in the selected material. Treat the statement with caution.</div></div>`);
    return;
  }
  const d = drawer('Where did this come from?', '<div class="center-load"><span class="spinner"></span></div>');
  try {
    const data = await api.get(`/api/sources/${sourceId}/units?ref=${encodeURIComponent(refs)}`);
    const quoteNote = quote
      ? `<div class="alert ${quoteStatus === 'verified' ? 'ok' : quoteStatus === 'found_elsewhere' ? 'info' : 'warn'}" style="margin-bottom:14px">${icon(quoteStatus === 'verified' ? 'check' : 'info')}<div><strong>${quoteStatus === 'verified' ? 'Quote verified in the cited page' : quoteStatus === 'found_elsewhere' ? 'Quote found in the material, but on a different page' : 'Quote could not be matched exactly in the material'}</strong><p class="small" style="margin:4px 0 0">“${esc(quote)}”</p></div></div>`
      : '';
    const body = data.units.length
      ? data.units
          .map(
            (u) => `<section style="margin-bottom:18px">
        <div class="row between" style="margin-bottom:6px"><strong>${esc(key || '')} ${esc(u.ref)}${u.title ? ` — ${esc(u.title)}` : ''}</strong>${u.status === 'ocr' ? '<span class="badge violet">OCR</span>' : ''}</div>
        <div class="muted tiny" style="margin-bottom:8px">${u.origin?.kind === 'web' ? `Retrieved from <a href="${esc(u.origin.url)}" target="_blank" rel="noopener">${esc(u.origin.name || u.origin.url)}</a>` : u.origin?.file ? `From your file ${esc(u.origin.file)}${u.origin.index ? ` (position ${u.origin.index})` : ''}` : u.origin?.kind === 'pasted' ? 'From pasted text' : ''}${u.label && u.ref !== `p.${u.label}` ? ` · printed page ${esc(u.label)}` : ''}</div>
        <div class="unit-text">${highlight(u.text, quote)}</div></section>`,
          )
          .join('')
      : `<div class="alert warn">${icon('warn')}<div>The cited ${esc(refs)} is not available in <strong>${esc(data.source.title)}</strong>. It may have been removed from the selection, or the citation is wrong.</div></div>`;
    d.el.innerHTML = `<p class="muted small" style="margin-top:0">${esc(data.source.title)}</p>${quoteNote}${body}`;
  } catch (err) {
    d.el.innerHTML = `<div class="alert bad">${icon('warn')}<div>${esc(err.message)}</div></div>`;
  }
}

/** Delegate clicks on citation buttons inside a container. */
export function wireCitations(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cite]');
    if (!b) return;
    e.preventDefault();
    showSource({ sourceId: b.dataset.source, refs: b.dataset.refs, key: b.dataset.key });
  });
}

export function loading(text = 'Loading…') {
  return `<div class="center-load"><span class="spinner lg"></span><div>${esc(text)}</div></div>`;
}
