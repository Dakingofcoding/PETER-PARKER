// Workspace: the guided flow (books → research → pages → uploads → mode → settings → start)
// with the list of sources always visible beside it.
import { api, pollJob, uploadFile } from './api.js';
import { esc, icon, toast, toastError, modal, confirmDialog, statusBadge, kindIcon, formatBytes, debounce, drawer, loading } from './ui.js';
import { state, go, aiBanner } from './core.js';

const STEPS = [
  ['books', 'Add books'],
  ['research', 'Research'],
  ['pages', 'Select pages'],
  ['uploads', 'Uploads'],
  ['mode', 'Mode'],
  ['settings', 'Settings'],
  ['start', 'Start'],
];

export const MODES = [
  { key: 'summarize', letter: 'A', icon: 'summary', name: 'Summarize', desc: 'A structured summary of the selected pages, chapters or slides at the detail level you choose.', min: 1, detail: true },
  { key: 'quiz', letter: 'B', icon: 'quiz', name: 'Quiz me', desc: 'Interactive questions for any subject, one at a time, with teacher-style feedback and step-by-step maths working.', min: 1 },
  { key: 'study', letter: 'C', icon: 'study', name: 'Study mode', desc: 'A tutor that teaches the material, checks your understanding and answers your questions.', min: 1 },
  { key: 'combined', letter: 'D', icon: 'combine', name: 'Combined study', desc: 'Merge several sources into one learning resource: overlaps combined, unique points kept, conflicts flagged.', min: 2, detail: true },
  { key: 'compare', letter: 'E', icon: 'compare', name: 'Compare sources', desc: 'Similarities, differences, contradictions and unique information across two or more sources.', min: 2, detail: true },
  { key: 'revision', letter: 'F', icon: 'revision', name: 'Revision', desc: 'Definitions, facts, formulas, dates, key people, processes, likely question styles and quick notes.', min: 1, detail: true },
];

const LEVELS = [
  [1, 'Insane detail', 'Practically everything: every concept, rule, method, example and exception, explained step by step.'],
  [2, 'Good detail', 'Thorough coverage of all major topics with essential examples and methods.'],
  [3, 'OK detail', 'Major topics and important concepts explained clearly, essential facts and examples.'],
  [4, 'Mid detail', 'Main ideas, key definitions, rules and formulas for a fairly quick review.'],
  [5, 'Low detail', 'Very concise bullet points of the most important information for quick revision.'],
];

const NAMES = { page: ['page', 'pages'], slide: ['slide', 'slides'], chapter: ['chapter', 'chapters'], section: ['section', 'sections'], part: ['part', 'parts'] };
const unitWord = (s, n = 2) => (NAMES[s.unitType] || NAMES.page)[n === 1 ? 0 : 1];

// Per-workspace task settings live in sessionStorage so they survive reloads.
function loadTask(ws) {
  let t = {};
  try {
    t = JSON.parse(sessionStorage.getItem(`pps-task-${ws.id}`) || '{}');
  } catch { /* ignore */ }
  const ls = ws.lastSettings || {};
  let preMode = null;
  try {
    preMode = sessionStorage.getItem(`pps-mode-${ws.id}`);
    sessionStorage.removeItem(`pps-mode-${ws.id}`);
  } catch { /* ignore */ }
  return {
    mode: preMode || t.mode || null,
    level: t.level || ls.level || 3,
    extraInstruction: t.extraInstruction || '',
    quiz: { count: 10, difficulty: 'normal', types: 'mixed', mode: 'test', topics: [], focus: '', topicMode: 'all', ...(ls.quiz || {}), ...(t.quiz || {}) },
    study: { level: 'intermediate', focus: '', ...(t.study || {}) },
  };
}
function saveTask(ws, task) {
  try {
    sessionStorage.setItem(`pps-task-${ws.id}`, JSON.stringify(task));
  } catch { /* ignore */ }
}

/** Modal to add a book by name; returns the created source or null. */
export async function addBookDialog(workspaceId) {
  return modal({
    title: 'Research a book',
    body: bookFormHtml('dlg'),
    actions: [
      { label: 'Cancel', value: () => null },
      {
        label: `${icon('search')} Find this book`,
        kind: 'primary',
        value: async (wrap) => {
          const q = readBookForm(wrap, 'dlg');
          if (!q.title && !q.isbn) {
            toast('Enter a book title or ISBN.', 'bad');
            return false;
          }
          try {
            const r = await api.post(`/api/workspaces/${workspaceId}/books`, q);
            return r.source;
          } catch (err) {
            toastError(err);
            return false;
          }
        },
      },
    ],
  });
}

function bookFormHtml(p, v = {}) {
  const f = (k, label, ph, extra = '') => `<div class="field" ${extra}><label for="${p}-${k}">${label}</label><input id="${p}-${k}" class="input" name="${k}" placeholder="${ph}" value="${esc(v[k] || '')}"></div>`;
  return `<div class="stack">
    ${f('title', 'Book title', 'e.g. Collins Busy Ants Maths Book 6A')}
    <div class="form-grid">
      ${f('author', 'Author (optional)', 'e.g. Jeanette Mumford')}
      ${f('isbn', 'ISBN (optional)', 'e.g. 9780008...')}
      ${f('edition', 'Edition (optional)', 'e.g. Pupil Book, 2nd ed.')}
      ${f('subject', 'Subject (optional)', 'e.g. Maths')}
      ${f('level', 'Grade / level (optional)', 'e.g. Year 6')}
    </div>
    <p class="muted small" style="margin:0">The more you add, the easier it is to tell apart books with similar titles (6A vs 6B, pupil book vs teacher guide).</p></div>`;
}
function readBookForm(root, p) {
  const q = {};
  for (const k of ['title', 'author', 'isbn', 'edition', 'subject', 'level']) q[k] = root.querySelector(`#${p}-${k}`)?.value.trim() || '';
  return q;
}

export async function renderWorkspace(main, { id, step }) {
  let ws = await api.get(`/api/workspaces/${id}`);
  const task = loadTask(ws);
  let current = STEPS.some(([k]) => k === step) ? step : ws.sources.length ? (ws.sources.some((s) => s.kind === 'book' && !s.identity) ? 'books' : task.mode ? 'mode' : 'pages') : 'books';
  if (step === 'mode' || step === 'settings') current = step;
  let pageTab = null; // selected source in "Select pages"
  let uploadQueue = [];
  let topicsCache = null;
  let alive = true;
  const polling = new Map(); // jobId -> latest job snapshot

  const books = () => ws.sources.filter((s) => s.kind === 'book');
  const included = () => ws.sources.filter((s) => s.included);
  const src = (sid) => ws.sources.find((s) => s.id === sid);

  async function refresh(rerender = true) {
    ws = await api.get(`/api/workspaces/${id}`);
    for (const s of ws.sources) if (s.job && !polling.has(s.job.id)) watchJob(s.job.id, s.id);
    if (rerender && alive) render();
  }

  function watchJob(jobId, sourceId) {
    if (polling.has(jobId)) return;
    polling.set(jobId, { log: [], status: 'running', sourceId });
    pollJob(jobId, (job) => {
      polling.set(jobId, { ...job, sourceId });
      const el = main.querySelector(`[data-log="${sourceId}"]`);
      if (el) {
        el.innerHTML = logHtml(job.log);
        el.scrollTop = el.scrollHeight;
      }
      const q = uploadQueue.find((u) => u.jobId === jobId);
      if (q) {
        q.log = job.log;
        const row = main.querySelector(`[data-qrow="${q.qid}"] .qstat`);
        if (row && job.log.length) row.textContent = job.log[job.log.length - 1].message;
      }
    })
      .then((job) => {
        polling.delete(jobId);
        const q = uploadQueue.find((u) => u.jobId === jobId);
        if (q) {
          q.status = job.status === 'error' ? 'error' : 'done';
          q.error = job.error;
        }
        if (job.status === 'error') toast(job.error || 'Processing failed', 'bad');
        if (alive) refresh();
      })
      .catch(() => polling.delete(jobId));
  }
  for (const s of ws.sources) if (s.job) watchJob(s.job.id, s.id);

  const logHtml = (log = []) => log.map((l) => `<div class="${l.level === 'error' ? 'err' : ''}">${esc(l.message)}</div>`).join('') || '<div class="muted">Starting…</div>';

  // ---------------------------------------------------------------- layout
  function render() {
    const stepIdx = STEPS.findIndex(([k]) => k === current);
    main.innerHTML = `<div class="page">
      <div class="crumbs"><a href="#/">Dashboard</a><span>/</span><a href="#/workspaces">Workspaces</a></div>
      <div class="page-head"><div class="grow"><h1 id="ws-title" title="Click to rename" style="cursor:text">${esc(ws.title)}</h1>
        <div class="sub">${ws.sources.length} source${ws.sources.length === 1 ? '' : 's'} · ${included().length} selected for tasks</div></div>
        <div class="row tight"><button class="btn ghost" data-act="rename">${icon('text')} Rename</button><button class="btn ghost danger" data-act="delete-ws">${icon('trash')} Delete</button></div></div>
      ${aiBanner()}
      <nav class="stepper" aria-label="Steps">${STEPS.map(([k, label], i) => `<button class="step ${k === current ? 'on' : ''} ${i < stepIdx ? 'done' : ''}" data-step="${k}"><span class="n">${i < stepIdx ? '✓' : i + 1}</span>${label}</button>`).join('')}</nav>
      <div class="ws-layout">
        <aside class="ws-side">${sidebarHtml()}</aside>
        <section id="step-body">${stepHtml()}</section>
      </div></div>`;
    bindCommon();
    bindStep();
  }

  function sidebarHtml() {
    const list = ws.sources;
    return `<div class="card">
      <div class="card-title"><h3>Sources</h3><div class="row tight">${list.length ? `<button class="btn sm ghost" data-act="all">All</button><button class="btn sm ghost" data-act="none">None</button>` : ''}</div></div>
      ${list.length ? `<div class="src-list">${list.map((s, i) => `<div class="src-item ${s.included ? '' : 'off'}">
          <label class="check" title="Use this source in tasks"><input type="checkbox" data-inc="${s.id}" ${s.included ? 'checked' : ''} aria-label="Use ${esc(s.title)} in tasks"></label>
          <span class="kind">${kindIcon(s)}</span>
          <div class="grow"><div class="t">${esc(s.title)}</div>
            <div class="meta">${s.kind === 'book' ? 'Book' : s.kind === 'pasted' ? 'Pasted text' : (s.files?.[0]?.type || 'file').toUpperCase()} · ${s.stats.readable}/${s.stats.units} ${unitWord(s)}</div>
            <div style="margin-top:5px">${statusBadge(s.status, s.statusLabel)}</div>
            ${s.selection.mode === 'custom' ? `<div class="meta" style="margin-top:4px">${esc(s.resolved.description)}</div>` : ''}</div>
          <div class="ctrls"><button data-mv="${i}:-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button data-mv="${i}:1" aria-label="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down')}</button><button data-rm="${s.id}" aria-label="Remove ${esc(s.title)}">${icon('x')}</button></div>
        </div>`).join('')}</div>` : '<p class="muted small" style="margin:0">No sources yet. Add a book or upload a document.</p>'}
      <div class="row tight" style="margin-top:12px"><button class="btn sm" data-step="books">${icon('plus')} Book</button><button class="btn sm" data-step="uploads">${icon('upload')} Upload</button></div></div>`;
  }

  function stepHtml() {
    switch (current) {
      case 'books': return booksStep();
      case 'research': return researchStep();
      case 'pages': return pagesStep();
      case 'uploads': return uploadsStep();
      case 'mode': return modeStep();
      case 'settings': return settingsStep();
      case 'start': return startStep();
      default: return '';
    }
  }

  const foot = (back, next, nextLabel = 'Continue') => `<div class="step-foot">${back ? `<button class="btn" data-step="${back}">${icon('back')} Back</button>` : '<span></span>'}${next ? `<button class="btn primary" data-step="${next}">${nextLabel} ${icon('next')}</button>` : ''}</div>`;

  // ---------------------------------------------------------------- step 1: books
  function booksStep() {
    const bs = books();
    return `<div class="stack lg">
      <div class="card pad-lg"><div class="card-title"><h2>Add a book</h2></div>
        <form id="book-form">${bookFormHtml('bf')}<div class="row" style="margin-top:14px"><button class="btn primary" type="submit">${icon('search')} Find this book</button><span class="muted small">${state.status?.ai ? 'Catalogues + AI web research' : 'Catalogue search only (AI not connected)'}</span></div></form></div>
      ${bs.map(bookCard).join('')}
      ${foot(null, bs.length ? 'research' : 'uploads', bs.length ? 'Continue to research' : 'Skip to uploads')}</div>`;
  }

  function bookCard(s) {
    const job = s.job && polling.get(s.job.id);
    const identifying = s.job?.type === 'identify';
    let body = '';
    if (identifying) {
      body = `<div class="row" style="margin-bottom:8px"><span class="spinner"></span><strong>Searching for this book…</strong></div><div class="log" data-log="${s.id}">${logHtml(job?.log)}</div>`;
    } else if (!s.identity) {
      const c = s.candidates || [];
      body = c.length
        ? `<p class="muted small">We found ${c.length} possible match${c.length === 1 ? '' : 'es'}. Choose the exact book and edition you are using. Books with similar titles are listed separately.</p><div class="stack">${c.map((k) => candidateHtml(s, k)).join('')}</div>`
        : `<div class="alert warn">${icon('warn')}<div>No matching books were found${s.research?.identifyErrors?.length ? ` (some catalogues were unavailable: ${esc(s.research.identifyErrors.join('; '))})` : ''}. Check the spelling, add the author or ISBN, or enter the details yourself.</div></div>`;
      body += `<div class="row" style="margin-top:12px"><button class="btn sm" data-reid="${s.id}">${icon('search')} Search again</button><button class="btn sm ghost" data-manual="${s.id}">Enter details manually</button></div>`;
      if (s.research?.identifyNotes) body += `<p class="muted small" style="margin-top:10px">${esc(s.research.identifyNotes)}</p>`;
    } else {
      const id = s.identity;
      body = `<dl class="kv">
        <dt>Title</dt><dd>${esc(id.title)}${id.subtitle ? `: ${esc(id.subtitle)}` : ''}</dd>
        ${id.authors?.length ? `<dt>Author</dt><dd>${esc(id.authors.join(', '))}</dd>` : ''}
        ${id.publisher ? `<dt>Publisher</dt><dd>${esc(id.publisher)}</dd>` : ''}
        ${id.edition ? `<dt>Edition</dt><dd>${esc(id.edition)}</dd>` : ''}
        ${id.year ? `<dt>Year</dt><dd>${esc(id.year)}</dd>` : ''}
        ${id.isbn13s?.length ? `<dt>ISBN</dt><dd>${esc(id.isbn13s.join(', '))}</dd>` : ''}</dl>
        <div class="row" style="margin-top:12px"><button class="btn sm" data-step="research">${icon('globe')} View research</button><button class="btn sm ghost" data-reid="${s.id}">Wrong book? Search again</button></div>`;
    }
    return `<div class="card"><div class="card-title"><div><div class="muted tiny">You searched for</div><h3>${esc([s.query?.title, s.query?.author, s.query?.isbn].filter(Boolean).join(' · ') || s.title)}</h3></div>${statusBadge(s.status, s.statusLabel)}</div>${body}</div>`;
  }

  function candidateHtml(s, c) {
    const access = c.access || {};
    const accessNote = access.gutenbergId ? '<span class="badge ok">Public-domain full text available</span>' : access.googleViewability === 'ALL_PAGES' ? '<span class="badge ok">Full view on Google Books</span>' : access.googleViewability === 'PARTIAL' ? '<span class="badge info">Preview on Google Books</span>' : '';
    return `<div class="cand">
      ${c.coverUrl ? `<img src="${esc(c.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="cover">${icon('book')}</div>`}
      <div class="grow">
        <div class="row between"><strong>${esc(c.title)}${c.subtitle ? `: ${esc(c.subtitle)}` : ''}</strong><span class="badge ${c.confidence === 'high' ? 'ok' : c.confidence === 'low' ? 'warn' : ''}">${esc(c.confidence)} match</span></div>
        <div class="muted small" style="margin:3px 0 6px">${esc([c.authors?.join(', '), c.publisher, c.edition, c.year, c.isbn13s?.[0] ? `ISBN ${c.isbn13s[0]}` : '', c.pageCount ? `${c.pageCount} pages` : ''].filter(Boolean).join(' · '))}</div>
        ${c.level || c.series ? `<div class="small">${esc([c.series, c.level].filter(Boolean).join(' · '))}</div>` : ''}
        ${c.distinguishingNotes ? `<div class="small" style="margin-top:4px"><strong>How it differs:</strong> ${esc(c.distinguishingNotes)}</div>` : ''}
        ${c.description ? `<details class="more" style="margin-top:6px"><summary>Description</summary><p class="small" style="margin-top:6px">${esc(c.description.slice(0, 600))}</p></details>` : ''}
        <div class="row tight" style="margin-top:8px">${accessNote}${(c.catalogs || []).map((k) => `<span class="tag">${esc(k)}</span>`).join('')}${c.origin === 'web-research' ? '<span class="tag">Verified by web research</span>' : ''}
          ${(c.links || []).slice(0, 3).map((l) => `<a class="small" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join(' ')}</div>
      </div>
      <div><button class="btn primary sm" data-choose="${s.id}:${c.id}">This is my book</button></div></div>`;
  }

  // ---------------------------------------------------------------- step 2: research
  function researchStep() {
    const bs = books().filter((s) => s.identity || s.job?.type === 'research');
    const uploads = ws.sources.filter((s) => s.kind !== 'book');
    return `<div class="stack lg">
      ${bs.length ? bs.map(researchCard).join('') : `<div class="empty">${icon('globe')}<div>No identified books yet. ${books().length ? 'Choose the correct edition in step 1 first.' : 'Add a book in step 1, or upload your own documents.'}</div></div>`}
      ${uploads.length ? `<div class="card"><div class="card-title"><h3>Your documents</h3></div><div class="list">${uploads.map((s) => `<div class="list-row"><span class="ic">${kindIcon(s)}</span><span class="grow"><div class="t">${esc(s.title)}</div><div class="s">${s.stats.readable} of ${s.stats.units} ${unitWord(s)} readable${s.stats.ocr ? ` · ${s.stats.ocr} via OCR` : ''}${s.stats.unreadable ? ` · ${s.stats.unreadable} unreadable` : ''}</div></span>${statusBadge(s.status, s.statusLabel)}</div>`).join('')}</div></div>` : ''}
      ${foot('books', 'pages', 'Continue to page selection')}</div>`;
  }

  function researchCard(s) {
    const r = s.research || {};
    const running = s.job?.type === 'research';
    const job = running && polling.get(s.job.id);
    const vi = r.verifiedIdentity;
    let body;
    if (running) {
      body = `<div class="row" style="margin-bottom:8px"><span class="spinner"></span><strong>Researching legitimate sources for this book…</strong></div><div class="log" data-log="${s.id}">${logHtml(job?.log)}</div><p class="muted small" style="margin-top:8px">This can take a minute or two. You can keep working on other steps.</p>`;
    } else if (!r.researchedAt) {
      body = `<p>This book hasn't been researched yet.</p><button class="btn primary" data-research="${s.id}">${icon('globe')} Research this book</button>`;
    } else {
      const retrieved = (r.sources || []).filter((x) => x.retrieved);
      body = `
        <div class="alert ${s.stats.readable ? (s.completeText ? 'ok' : 'info') : 'warn'}">${icon(s.stats.readable ? 'check' : 'warn')}<div>
          <strong>${s.stats.readable ? `${s.stats.readable} ${unitWord(s, s.stats.readable)} of real content retrieved${s.completeText ? ' (complete text)' : ''}.` : 'No page content could be retrieved from legitimate sources.'}</strong>
          ${r.assessment ? `<p class="small" style="margin:4px 0 0">${esc(r.assessment)}</p>` : ''}</div></div>
        ${vi ? `<div><div class="label" style="margin:14px 0 6px">Verified edition</div><dl class="kv"><dt>Title</dt><dd>${esc(vi.title)}</dd><dt>Author</dt><dd>${esc(vi.authors.join(', ') || '—')}</dd><dt>Publisher</dt><dd>${esc(vi.publisher || '—')}</dd><dt>Edition</dt><dd>${esc(vi.edition || '—')}</dd><dt>ISBN</dt><dd>${esc(vi.isbn13 || '—')}</dd>${vi.pageCount ? `<dt>Pages</dt><dd>${vi.pageCount}</dd>` : ''}<dt>Matches choice</dt><dd>${vi.matchesChosenEdition ? 'Yes' : '<strong>No: check the edition</strong>'}</dd></dl>${vi.notes ? `<p class="muted small" style="margin-top:6px">${esc(vi.notes)}</p>` : ''}</div>` : ''}
        ${(r.limitations || []).length ? `<div class="alert warn" style="margin-top:14px">${icon('warn')}<div><strong>Access limitations</strong><ul>${r.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div></div>` : ''}
        ${r.pageNumberingNotes ? `<div class="alert info" style="margin-top:10px">${icon('info')}<div><strong>Page numbering:</strong> ${esc(r.pageNumberingNotes)}</div></div>` : ''}
        ${(r.sources || []).length ? `<div class="label" style="margin:16px 0 6px">Sources checked</div><div class="table-wrap"><table class="t"><thead><tr><th>Source</th><th>Type</th><th>Pages covered</th><th>Result</th></tr></thead><tbody>${r.sources
          .map((x) => `<tr><td><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.host)}</a><div class="muted tiny">${esc(x.host)}${x.license ? ` · ${esc(x.license.replace(/_/g, ' '))}` : ''}${x.sameEdition && x.sameEdition !== 'yes' ? ` · edition: ${esc(x.sameEdition)}` : ''}</div></td><td>${esc((x.type || '').replace(/_/g, ' '))}</td><td>${esc(x.pagesCovered || '—')}</td><td>${x.retrieved ? `<span class="badge ok">Retrieved ${x.units}</span>` : `<span class="badge ${x.access === 'view_only' ? 'info' : 'warn'}">${esc(x.access === 'view_only' ? 'View only' : 'Not retrieved')}</span>${x.error ? `<div class="muted tiny" style="margin-top:3px">${esc(x.error)}</div>` : ''}`}</td></tr>`)
          .join('')}</tbody></table></div>` : ''}
        ${s.chapters?.length ? `<details class="more" style="margin-top:14px"><summary>Table of contents (${s.chapters.length})</summary><div class="small" style="margin-top:8px">${s.chapters.map((c) => `<div>${esc(c.title)} <span class="muted">${c.numbering === 'printed' ? 'p.' : 'PDF p.'}${c.start}${c.end && c.end !== c.start ? `–${c.end}` : ''}</span></div>`).join('')}</div></details>` : ''}
        <div class="row" style="margin-top:16px"><button class="btn" data-research="${s.id}">${icon('refresh')} Research again</button><button class="btn" data-addpages="${s.id}">${icon('upload')} Upload missing pages</button>${s.stats.readable ? `<button class="btn primary" data-pages="${s.id}">Select pages ${icon('next')}</button>` : ''}</div>`;
    }
    return `<div class="card pad-lg"><div class="card-title"><h2>${esc(s.title)}</h2>${statusBadge(s.status, s.statusLabel)}</div>${body}</div>`;
  }

  // ---------------------------------------------------------------- step 3: pages
  function pagesStep() {
    const list = ws.sources.filter((s) => s.stats.units > 0 || s.kind === 'book');
    if (!list.length) return `<div class="empty">${icon('file')}<div>Add a book or upload a document first.</div></div>${foot('research', 'uploads')}`;
    if (!pageTab || !src(pageTab)) pageTab = list[0].id;
    const s = src(pageTab);
    return `<div class="stack lg">
      <div class="seg" role="tablist">${list.map((x) => `<button role="tab" data-ptab="${x.id}" class="${x.id === pageTab ? 'on' : ''}">${esc(x.title.slice(0, 40))}</button>`).join('')}</div>
      ${selectionEditor(s)}
      ${foot('research', 'uploads')}</div>`;
  }

  function selectionEditor(s) {
    const sel = s.selection;
    const isPage = s.unitType === 'page';
    const showNumbering = isPage && (s.kind === 'book' || s.numbering?.hasPrinted || s.stats.labelled);
    const unitsLabel = unitWord(s);
    const noContent = !s.stats.units;
    const numberingAlert = isPage && s.numbering?.differs
      ? `<div class="alert info">${icon('info')}<div><strong>Printed page numbers differ from the PDF page positions.</strong> ${esc(s.numbering.note || '')} Choose which numbering you are typing below, so the right pages are used.</div></div>`
      : s.numbering?.docNote ? `<div class="alert info">${icon('info')}<div>${esc(s.numbering.docNote)}</div></div>` : '';
    const bookNote = s.kind === 'book' ? `<div class="alert ${s.completeText ? 'ok' : 'info'}">${icon('info')}<div>${s.completeText ? 'The complete text of this book was retrieved.' : `Only retrieved pages can be used. Pages you select that were not retrieved are listed as <strong>missing</strong>; they are never guessed. ${s.stats.units ? '' : 'Nothing has been retrieved yet: you can still choose your pages now and upload them.'}`}</div></div>` : '';
    const pickList = !isPage && s.stats.units ? `<div class="field"><span class="label">Quick pick</span><div class="list" id="unit-pick" style="max-height:260px;overflow:auto"></div></div>` : '';
    const chapters = s.chapters?.length ? `<div class="field"><span class="label">Chapters / sections</span><div class="stack" style="gap:6px;max-height:240px;overflow:auto">${s.chapters.map((c, i) => `<label class="check"><input type="checkbox" data-ch="${i}" ${sel.chapters.includes(i) ? 'checked' : ''}><span>${esc(c.title)} <span class="muted small">${c.numbering === 'printed' ? 'p.' : isPage ? 'PDF p.' : '#'}${c.start}${c.end !== c.start ? `–${c.end}` : ''}</span></span></label>`).join('')}</div></div>` : '';
    return `<div class="card pad-lg stack lg" data-editor="${s.id}">
      <div class="card-title"><div><h2>${esc(s.title)}</h2><div class="muted small">${s.stats.units} ${unitsLabel} available${s.stats.ocr ? ` · ${s.stats.ocr} read with OCR` : ''}${s.stats.unreadable ? ` · ${s.stats.unreadable} unreadable` : ''}</div></div><span id="sel-status">${statusBadge(s.status, s.statusLabel)}</span></div>
      ${bookNote}${numberingAlert}
      ${s.stats.ocrPending && state.status?.ai ? `<div class="alert warn">${icon('warn')}<div>${s.stats.ocrPending} scanned page(s) are waiting for OCR. <button class="btn sm" data-ocr="${s.id}">Retry OCR</button></div></div>` : ''}
      ${showNumbering ? `<div class="field"><span class="label">Page numbering</span><div class="seg" id="numbering"><button data-num="printed" class="${sel.numbering === 'printed' ? 'on' : ''}">Printed page numbers</button><button data-num="index" class="${sel.numbering === 'index' ? 'on' : ''}">${s.kind === 'book' ? 'Position in retrieved material' : 'PDF page index'}</button></div></div>` : ''}
      <div class="field"><span class="label">What to use</span><div class="seg" id="selmode"><button data-mode="all" class="${sel.mode === 'all' ? 'on' : ''}">All available ${unitsLabel}</button><button data-mode="custom" class="${sel.mode === 'custom' ? 'on' : ''}">Choose ${unitsLabel}</button></div></div>
      <div class="form-grid" id="custom-fields" style="${sel.mode === 'custom' ? '' : 'display:none'}">
        <div class="field"><label for="sel-ranges">${unitsLabel[0].toUpperCase() + unitsLabel.slice(1)} to include</label><input id="sel-ranges" class="input" value="${esc(sel.ranges)}" placeholder="${isPage ? 'e.g. 4-67' : 'e.g. 1-3, 5'}"><span class="hint">Ranges and single numbers, separated by commas.</span></div>
      </div>
      <div style="${sel.mode === 'custom' ? '' : 'display:none'}" id="custom-extra" class="stack">${chapters}${pickList}</div>
      <div class="field"><label for="sel-exclude">${unitsLabel[0].toUpperCase() + unitsLabel.slice(1)} to leave out</label><input id="sel-exclude" class="input" value="${esc(sel.exclude)}" placeholder="${isPage ? 'e.g. 23, 39, 52' : 'e.g. 2'}"><span class="hint">These are removed completely and never used.</span></div>
      <div id="sel-preview" class="card soft">${noContent && s.kind !== 'book' ? 'No content yet.' : '<div class="skel" style="width:60%"></div>'}</div>
      ${s.stats.units ? `<div class="field"><div class="row between"><span class="label">${isPage ? 'Page' : 'Unit'} map</span><div class="legend"><span><i style="background:var(--accent-soft)"></i>Included</span><span><i class="pm ex" style="min-width:0;height:12px;padding:0"></i>Excluded</span><span><i style="background:var(--warn-soft)"></i>Unreadable</span><span><i></i>Not selected</span></div></div><div class="page-map" id="page-map"></div><span class="hint">Tap a square to read what was extracted from it.</span></div>` : ''}
      ${s.kind === 'book' ? `<div class="row"><button class="btn sm" data-addpages="${s.id}">${icon('upload')} Upload pages for this book</button></div>` : ''}
    </div>`;
  }

  let sourceUnitsCache = new Map();
  async function bindEditor() {
    const editor = main.querySelector('[data-editor]');
    if (!editor) return;
    const s = src(editor.dataset.editor);
    const sel = { ...s.selection };
    let units = sourceUnitsCache.get(s.id);
    if (!units && s.stats.units) {
      const full = await api.get(`/api/sources/${s.id}`);
      units = full.units;
      sourceUnitsCache.set(s.id, units);
    }
    const preview = async () => {
      const box = main.querySelector('#sel-preview');
      if (!box) return;
      try {
        const p = await api.post(`/api/sources/${s.id}/preview-selection`, { selection: sel });
        const w = unitWord(s);
        box.innerHTML = `<div class="stack" style="gap:6px">
          <div><strong>${p.included} ${unitWord(s, p.included)} will be used</strong>${p.includedRefs ? ` <span class="muted small">(${esc(p.includedRefs)})</span>` : ''}</div>
          ${p.excludedCount ? `<div class="small">Excluded: ${esc(p.excluded)}</div>` : ''}
          ${p.missingCount ? `<div class="small" style="color:var(--bad)"><strong>Missing (${p.missingCount}):</strong> ${esc(p.missing)}: not accessible, so they will not be used${s.kind === 'book' ? '. Upload these pages to include them.' : '.'}</div>` : ''}
          ${p.unreadableCount ? `<div class="small" style="color:var(--warn)"><strong>Unreadable (${p.unreadableCount}):</strong> ${esc(p.unreadable)}${s.stats.ocrPending ? ' (OCR pending)' : ''}</div>` : ''}
          ${p.errors.length ? `<div class="small" style="color:var(--bad)">${p.errors.map(esc).join('<br>')}</div>` : ''}
          <div class="muted tiny">${Math.round(p.chars / 1000)}k characters of text · ${w}</div></div>`;
        main.querySelector('#sel-status').innerHTML = statusBadge(p.status, p.statusLabel);
        const map = main.querySelector('#page-map');
        if (map && units) {
          map.innerHTML = units
            .map((u, i) => {
              const st = p.unitStates[i];
              const lab = s.unitType === 'page' ? (sel.numbering === 'printed' ? u.label || `·${u.n}` : u.n) : u.n;
              return `<button class="pm ${st === 'in' ? 'in' : st === 'ex' ? 'ex' : st === 'unread' ? 'unread' : ''} ${u.status === 'ocr' ? 'ocr' : ''}" data-unit="${u.n}" title="${esc(`${s.unitType === 'page' ? `PDF page ${u.n}${u.label ? ` · printed ${u.label}` : ''}` : `${unitWord(s, 1)} ${u.n}`}${u.title ? ` · ${u.title}` : ''} · ${u.status}`)}">${esc(lab)}</button>`;
            })
            .join('');
        }
      } catch (err) {
        box.innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`;
      }
    };
    const save = debounce(async () => {
      try {
        const updated = await api.patch(`/api/sources/${s.id}`, { selection: sel });
        Object.assign(s, updated);
        main.querySelector('.ws-side').innerHTML = sidebarHtml();
        bindSidebar();
      } catch (err) {
        toastError(err);
      }
    }, 500);
    const changed = () => {
      preview();
      save();
    };
    const pick = main.querySelector('#unit-pick');
    const renderPick = () => {
      if (!pick || !units) return;
      const chosen = new Set(parseSimple(sel.ranges));
      pick.innerHTML = units.map((u) => `<label class="check list-row" style="padding:8px 10px"><input type="checkbox" data-pick="${u.n}" ${chosen.has(u.n) ? 'checked' : ''}><span class="grow"><strong>${u.n}.</strong> ${esc(u.title || `${unitWord(s, 1)} ${u.n}`)} <span class="muted tiny">${u.status === 'ok' || u.status === 'ocr' ? `${Math.round(u.chars / 100) / 10}k chars` : u.status}</span></span></label>`).join('');
    };
    renderPick();
    editor.addEventListener('click', (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) {
        sel.mode = m.dataset.mode;
        editor.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === m));
        main.querySelector('#custom-fields').style.display = sel.mode === 'custom' ? '' : 'none';
        main.querySelector('#custom-extra').style.display = sel.mode === 'custom' ? '' : 'none';
        changed();
      }
      const n = e.target.closest('[data-num]');
      if (n) {
        sel.numbering = n.dataset.num;
        editor.querySelectorAll('[data-num]').forEach((b) => b.classList.toggle('on', b === n));
        changed();
      }
      const u = e.target.closest('[data-unit]');
      if (u) openUnit(s, Number(u.dataset.unit));
    });
    editor.addEventListener('input', (e) => {
      if (e.target.id === 'sel-ranges') {
        sel.ranges = e.target.value;
        renderPick();
        changed();
      } else if (e.target.id === 'sel-exclude') {
        sel.exclude = e.target.value;
        changed();
      }
    });
    editor.addEventListener('change', (e) => {
      if (e.target.dataset.ch !== undefined) {
        const i = Number(e.target.dataset.ch);
        sel.chapters = e.target.checked ? [...new Set([...sel.chapters, i])] : sel.chapters.filter((x) => x !== i);
        changed();
      }
      if (e.target.dataset.pick !== undefined) {
        const set = new Set(parseSimple(sel.ranges));
        const n2 = Number(e.target.dataset.pick);
        if (e.target.checked) set.add(n2);
        else set.delete(n2);
        sel.ranges = compress([...set]);
        main.querySelector('#sel-ranges').value = sel.ranges;
        changed();
      }
    });
    preview();
  }

  async function openUnit(s, n) {
    const d = drawer(`${s.unitType === 'page' ? 'PDF page' : unitWord(s, 1)} ${n}`, loading(), esc(s.title));
    try {
      const r = await api.get(`/api/sources/${s.id}/units?n=${n}`);
      const u = r.units[0];
      d.el.innerHTML = u
        ? `<div class="row tight" style="margin-bottom:10px">${u.label ? `<span class="badge accent">Printed page ${esc(u.label)}</span>` : ''}<span class="badge ${u.status === 'ok' ? 'ok' : u.status === 'ocr' ? 'violet' : 'warn'}">${u.status === 'ok' ? 'Text extracted' : u.status === 'ocr' ? 'Read with OCR' : 'Unreadable'}</span></div>${u.note ? `<div class="alert warn" style="margin-bottom:10px">${icon('info')}<div>${esc(u.note)}</div></div>` : ''}${u.origin?.url ? `<p class="small">Source: <a href="${esc(u.origin.url)}" target="_blank" rel="noopener">${esc(u.origin.name || u.origin.url)}</a></p>` : ''}<div class="unit-text">${esc(u.text || '(no text)')}</div>`
        : '<div class="empty">Not found.</div>';
    } catch (err) {
      d.el.innerHTML = `<div class="alert bad">${esc(err.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- step 4: uploads
  function uploadsStep() {
    const docs = ws.sources.filter((s) => s.kind !== 'book');
    const pending = uploadQueue.filter((q) => q.status !== 'done' || !q.sourceId || !docs.some((d) => d.id === q.sourceId));
    const exts = (state.status?.supportedExtensions || []).join(', ');
    return `<div class="stack lg">
      <div class="card pad-lg stack">
        <div class="card-title"><h2>Upload documents</h2>${docs.length || pending.length ? `<button class="btn sm ghost danger" data-act="clear-uploads">${icon('trash')} Clear all files</button>` : ''}</div>
        <label class="dropzone" id="dropzone" tabindex="0">${icon('upload')}<div style="margin-top:8px"><strong>Drag & drop files here</strong> or <span style="color:var(--accent-text);text-decoration:underline">browse</span></div><div class="muted small" style="margin-top:4px">PDF, Word (.docx), PowerPoint (.pptx), EPUB, TXT, Markdown, HTML, or photos of pages · up to ${state.status?.maxUploadMB || 150} MB each</div>
          <input type="file" id="file-input" multiple accept="${esc(exts)}" class="sr-only"></label>
        <div class="stack" style="gap:8px">${pending.map(queueRow).join('')}${docs.map(docRow).join('')}</div>
      </div>
      <div class="grid cols-2">
        <div class="card stack"><h3 style="margin:0">Paste text</h3>
          <div class="field"><label for="paste-title">Title</label><input id="paste-title" class="input" placeholder="e.g. Class notes: photosynthesis"></div>
          <div class="field"><label for="paste-text">Text</label><textarea id="paste-text" class="textarea" placeholder="Paste notes, a chapter, an article…"></textarea></div>
          <div><button class="btn" data-act="paste">${icon('plus')} Add pasted text</button></div></div>
        <div class="card stack"><h3 style="margin:0">Add pages to a book</h3>
          ${books().length ? `<p class="muted small" style="margin:0">If research couldn't access some pages, photograph or scan them and add them to the book here.</p>
          <div class="field"><label for="ap-book">Book</label><select id="ap-book" class="select">${books().map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('')}</select></div>
          <div class="field"><label for="ap-start">First page in the file is printed page…</label><input id="ap-start" class="input" inputmode="numeric" placeholder="e.g. 23 (leave empty to detect)"></div>
          <div><label class="btn">${icon('upload')} Choose file<input type="file" id="ap-file" class="sr-only" accept="${esc(exts)}"></label></div>` : '<p class="muted small" style="margin:0">Add a book first to attach pages to it.</p>'}</div>
      </div>
      ${foot('pages', 'mode', 'Choose a mode')}</div>`;
  }

  const extOf = (name) => (name.split('.').pop() || '').slice(0, 4);
  function queueRow(q) {
    const pct = Math.round((q.progress || 0) * 100);
    const label = q.status === 'queued' ? 'Waiting…' : q.status === 'uploading' ? `Uploading ${pct}%` : q.status === 'processing' ? (q.log?.length ? q.log[q.log.length - 1].message : 'Extracting text…') : q.status === 'error' ? q.error || 'Failed' : 'Done';
    return `<div class="file-row" data-qrow="${q.qid}"><span class="ext">${esc(extOf(q.name))}</span><div class="grow"><div class="row between"><strong class="small">${esc(q.name)}</strong><span class="muted tiny">${formatBytes(q.size)} · ${esc(q.type || extOf(q.name))}</span></div>
      <div class="progress ${q.status === 'error' ? 'bad' : q.status === 'done' ? 'ok' : ''} ${q.status === 'processing' ? 'indet' : ''}"><i style="width:${q.status === 'uploading' ? pct : q.status === 'queued' ? 0 : 100}%"></i></div>
      <div class="muted tiny qstat" style="margin-top:4px">${esc(label)}</div></div>
      <button class="btn ghost icon" data-unqueue="${q.qid}" aria-label="Remove ${esc(q.name)}">${icon('x')}</button></div>`;
  }
  function docRow(s) {
    const f = s.files?.[0] || {};
    const busy = Boolean(s.job);
    const job = busy && polling.get(s.job.id);
    return `<div class="file-row"><span class="ext">${esc(s.kind === 'pasted' ? 'TXT' : extOf(f.name || s.title))}</span><div class="grow"><div class="row between"><strong class="small">${esc(s.title)}</strong><span class="muted tiny">${s.kind === 'pasted' ? 'Pasted text' : `${formatBytes(f.size)} · ${esc((f.type || '').toUpperCase())}`}</span></div>
      <div class="progress ${s.error ? 'bad' : busy ? 'indet' : 'ok'}"><i style="width:100%"></i></div>
      <div class="row between" style="margin-top:4px"><span class="muted tiny qstat" data-log="${s.id}-mini">${busy ? esc(job?.log?.at(-1)?.message || 'Extracting text…') : s.error ? `<span style="color:var(--bad)">${esc(s.error)}</span>` : `${s.stats.readable} of ${s.stats.units} ${unitWord(s)} readable${s.stats.ocr ? ` · ${s.stats.ocr} OCR` : ''}${s.stats.unreadable ? ` · ${s.stats.unreadable} unreadable` : ''}`}</span>${statusBadge(s.status, s.statusLabel)}</div></div>
      <button class="btn ghost icon" data-rm="${s.id}" aria-label="Remove ${esc(s.title)}">${icon('x')}</button></div>`;
  }

  let uploading = false;
  async function processQueue() {
    if (uploading) return;
    uploading = true;
    try {
      for (;;) {
        const q = uploadQueue.find((x) => x.status === 'queued');
        if (!q) break;
        q.status = 'uploading';
        rerenderUploads();
        try {
          const url = q.bookId ? `/api/sources/${q.bookId}/files` : `/api/workspaces/${id}/uploads`;
          const r = await uploadFile(url, q.file, q.bookId ? { startLabel: q.startLabel } : {}, (p) => {
            q.progress = p;
            const row = main.querySelector(`[data-qrow="${q.qid}"]`);
            if (row) {
              row.querySelector('.progress i').style.width = `${Math.round(p * 100)}%`;
              row.querySelector('.qstat').textContent = `Uploading ${Math.round(p * 100)}%`;
            }
          });
          q.status = 'processing';
          q.sourceId = r.source?.id || q.bookId;
          q.jobId = r.jobId;
          watchJob(r.jobId, q.sourceId);
          await refresh(false);
          rerenderUploads();
        } catch (err) {
          q.status = 'error';
          q.error = err.message;
          rerenderUploads();
        }
      }
    } finally {
      uploading = false;
    }
  }
  function rerenderUploads() {
    if (current !== 'uploads' || !alive) return;
    main.querySelector('#step-body').innerHTML = uploadsStep();
    main.querySelector('.ws-side').innerHTML = sidebarHtml();
    bindSidebar();
    bindStep();
  }
  function enqueue(files, extra = {}) {
    for (const file of files) uploadQueue.push({ qid: Math.random().toString(36).slice(2), file, name: file.name, size: file.size, type: file.type || extOf(file.name).toUpperCase(), progress: 0, status: 'queued', ...extra });
    rerenderUploads();
    processQueue();
  }

  // ---------------------------------------------------------------- step 5: mode
  function modeStep() {
    const n = included().length;
    return `<div class="stack lg"><div class="card pad-lg"><div class="card-title"><h2>What do you want to do?</h2><span class="muted small">${n} source${n === 1 ? '' : 's'} selected</span></div>
      <div class="choice-grid">${MODES.map((m) => `<button class="choice ${task.mode === m.key ? 'on' : ''}" data-pickmode="${m.key}" ${n < m.min ? 'aria-disabled="true"' : ''}><span class="ic">${icon(m.icon)}</span><strong>${m.letter} · ${m.name}</strong><span class="muted">${m.desc}</span>${n < m.min ? `<span class="tiny" style="color:var(--warn)">Needs ${m.min}+ sources</span>` : ''}</button>`).join('')}</div></div>
      ${foot('uploads', task.mode ? 'settings' : null, 'Continue to settings')}</div>`;
  }

  // ---------------------------------------------------------------- step 6: settings
  function sourcePicker() {
    return `<div class="field"><div class="row between"><span class="label">Sources for this task</span><div class="row tight"><button class="btn sm ghost" data-act="all">Select all</button><button class="btn sm ghost" data-act="none">Select none</button></div></div>
      <div class="stack" style="gap:6px">${ws.sources.map((s) => `<label class="check list-row" style="padding:9px 12px"><input type="checkbox" data-inc="${s.id}" ${s.included ? 'checked' : ''}><span class="grow"><strong class="small">${esc(s.title)}</strong><div class="muted tiny">${esc(s.resolved.description)} · ${s.resolved.included} ${unitWord(s, s.resolved.included)} usable</div></span>${statusBadge(s.status, s.statusLabel)}</label>`).join('') || '<span class="muted small">No sources.</span>'}</div></div>`;
  }

  function settingsStep() {
    const m = MODES.find((x) => x.key === task.mode);
    if (!m) return `<div class="empty">Choose a mode first.</div>${foot('mode', null)}`;
    let body = '';
    if (m.detail) {
      body = `<div class="field"><span class="label">Summary detail level</span><div class="choice-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">${LEVELS.map(([k, n, d]) => `<button class="choice ${Number(task.level) === k ? 'on' : ''}" data-level="${k}"><span class="level-num">${k}</span><strong>${n}</strong><span class="muted">${d}</span></button>`).join('')}</div><span class="hint">You can switch level later without researching or uploading again.</span></div>
        <div class="field"><label for="extra">Anything to focus on? (optional)</label><input id="extra" class="input" value="${esc(task.extraInstruction)}" placeholder="e.g. focus on the worked examples, I find fractions hard"></div>`;
    } else if (m.key === 'quiz') {
      const qz = task.quiz;
      const seg = (name, opts, val) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(val) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
      body = `<div class="form-grid">
          <div class="field"><span class="label">Number of questions</span>${seg('count', [[5, '5'], [10, '10'], [15, '15'], [20, '20'], [30, '30']], qz.count)}</div>
          <div class="field"><span class="label">Difficulty</span>${seg('difficulty', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['mixed', 'Mixed']], qz.difficulty)}</div></div>
        <div class="field"><span class="label">Question types</span>${seg('types', [['mixed', 'Mixed'], ['mcq', 'Multiple choice'], ['true_false', 'True / false'], ['written', 'Written answers']], qz.types)}</div>
        <div class="field"><span class="label">Mode</span>${seg('mode', [['test', 'Test mode'], ['learning', 'Learning mode']], qz.mode)}<span class="hint">${qz.mode === 'test' ? 'Test mode: no hints or working until you submit each answer.' : 'Learning mode: hints, guided working and retries while you answer.'}</span></div>
        <div class="field"><span class="label">Topics</span>${seg('topicMode', [['all', 'Whole selected material'], ['choose', 'Choose topics']], qz.topicMode)}
          <div id="topics-box" style="margin-top:10px;${qz.topicMode === 'choose' ? '' : 'display:none'}">${topicsCache ? topicsHtml() : `<button class="btn sm" data-act="load-topics">${icon('search')} Find topics in the material</button>`}</div></div>
        <div class="field"><label for="qfocus">Anything specific? (optional)</label><input id="qfocus" class="input" value="${esc(qz.focus)}" placeholder="e.g. more word problems, focus on dates"></div>
        <p class="muted small" style="margin:0">The subject is detected automatically, and question styles adapt to it (calculations with working for maths, cause and effect for science, chronology for history…).</p>`;
    } else if (m.key === 'study') {
      body = `<div class="field"><span class="label">Explanation level</span><div class="seg" data-seg="studyLevel">${[['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']].map(([v, l]) => `<button data-v="${v}" class="${task.study.level === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="field"><label for="sfocus">What should we focus on? (optional)</label><input id="sfocus" class="input" value="${esc(task.study.focus)}" placeholder="e.g. long division, chapter 3, the causes of the war"></div>`;
    }
    return `<div class="stack lg"><div class="card pad-lg stack lg"><div class="card-title"><h2>${m.letter} · ${m.name}: settings</h2><button class="btn sm ghost" data-step="mode">Change mode</button></div>
      ${sourcePicker()}${body}</div>${foot('mode', 'start', 'Review & start')}</div>`;
  }

  function topicsHtml() {
    return `<div class="stack" style="gap:6px">${topicsCache.topics.map((t) => `<label class="check"><input type="checkbox" data-topic="${esc(t.name)}" ${task.quiz.topics.includes(t.name) ? 'checked' : ''}><span><strong class="small">${esc(t.name)}</strong> <span class="muted tiny">${esc(t.description || '')}</span></span></label>`).join('')}${topicsCache.subject ? `<div class="muted tiny">Detected subject: ${esc(topicsCache.subject)}</div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- step 7: start
  function startStep() {
    const m = MODES.find((x) => x.key === task.mode);
    const inc = included();
    const issues = [];
    if (!m) issues.push('Choose a mode.');
    if (!inc.length) issues.push('Select at least one source.');
    if (m && inc.length < m.min) issues.push(`${m.name} needs at least ${m.min} sources.`);
    if (inc.some((s) => s.job)) issues.push('Wait until all selected sources have finished processing.');
    const noContent = inc.filter((s) => !s.resolved.included);
    if (noContent.length && noContent.length === inc.length) issues.push('None of the selected sources has readable content in its page selection.');
    const warnings = inc.filter((s) => ['partial', 'limited', 'needs_upload', 'content_found'].includes(s.status));
    const settingsText = !m ? '' : m.detail ? `Detail level ${task.level}: ${LEVELS[task.level - 1][1]}${task.extraInstruction ? ` · focus: ${task.extraInstruction}` : ''}` : m.key === 'quiz' ? `${task.quiz.count} questions · ${task.quiz.difficulty} · ${task.quiz.types.replace('_', '/')} · ${task.quiz.mode === 'test' ? 'Test mode' : 'Learning mode'}${task.quiz.topicMode === 'choose' && task.quiz.topics.length ? ` · topics: ${task.quiz.topics.join(', ')}` : ' · whole material'}` : `${task.study.level} level${task.study.focus ? ` · focus: ${task.study.focus}` : ''}`;
    return `<div class="stack lg"><div class="card pad-lg stack">
      <h2 style="margin:0">Ready to start</h2>
      <div class="table-wrap"><table class="t"><thead><tr><th>Source</th><th>Using</th><th>Excluded</th><th>Status</th></tr></thead><tbody>
        ${inc.map((s, i) => `<tr><td><strong>S${i + 1}</strong> ${esc(s.title)}</td><td>${esc(s.resolved.description)}<div class="muted tiny">${s.resolved.included} ${unitWord(s, s.resolved.included)} usable${s.resolved.missingCount ? ` · <span style="color:var(--bad)">${s.resolved.missingCount} missing</span>` : ''}${s.resolved.unreadableCount ? ` · ${s.resolved.unreadableCount} unreadable` : ''}</div></td><td>${esc(s.resolved.excluded || '—')}</td><td>${statusBadge(s.status, s.statusLabel)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No sources selected.</td></tr>'}
      </tbody></table></div>
      <dl class="kv"><dt>Mode</dt><dd>${m ? `${m.letter} · ${m.name}` : '—'}</dd><dt>Settings</dt><dd>${esc(settingsText)}</dd></dl>
      ${warnings.length ? `<div class="alert warn">${icon('warn')}<div><strong>Some content is incomplete.</strong> The result will only use pages that were actually retrieved or uploaded: ${warnings.map((s) => `${esc(s.title)} (${esc(s.statusLabel)}${s.resolved.missingCount ? `, ${s.resolved.missingCount} missing` : ''})`).join('; ')}. Missing pages are never guessed.</div></div>` : ''}
      ${issues.length ? `<div class="alert bad">${icon('warn')}<div><ul>${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>` : ''}
      ${!state.status?.ai && m && m.key !== 'study' ? `<div class="alert info">${icon('info')}<div>AI is not connected, so this will produce a clearly labelled <strong>offline ${m.key === 'quiz' ? 'fill-in-the-blank quiz' : 'extractive version'}</strong>.</div></div>` : ''}
      ${!state.status?.ai && m?.key === 'study' ? `<div class="alert bad">${icon('key')}<div>Study mode needs the AI connection. <a href="#/settings">See setup steps</a>.</div></div>` : ''}
      <div class="row"><button class="btn primary lg" data-act="start" ${issues.length || (m?.key === 'study' && !state.status?.ai) ? 'disabled' : ''}>${icon('play')} Start ${m ? m.name.toLowerCase() : ''}</button></div></div>
      ${foot('settings', null)}</div>`;
  }

  async function start() {
    const m = MODES.find((x) => x.key === task.mode);
    const sourceIds = included().map((s) => s.id);
    saveTask(ws, task);
    if (m.detail) {
      sessionStorage.setItem('pps-gen', JSON.stringify({ kind: 'doc', workspaceId: id, mode: m.key, level: Number(task.level), sourceIds, extraInstruction: task.extraInstruction }));
      return go('#/generate');
    }
    if (m.key === 'quiz') {
      const qz = task.quiz;
      sessionStorage.setItem('pps-gen', JSON.stringify({ kind: 'quiz', workspaceId: id, sourceIds, settings: { count: qz.count, difficulty: qz.difficulty, types: qz.types, mode: qz.mode, topics: qz.topicMode === 'choose' ? qz.topics : [], focus: qz.focus } }));
      return go('#/generate');
    }
    if (m.key === 'study') {
      try {
        const chat = await api.post(`/api/workspaces/${id}/chats`, { kind: 'study', level: task.study.level, focus: task.study.focus, sourceIds });
        return go(`#/chat/${chat.id}`);
      } catch (err) {
        toastError(err);
      }
    }
  }

  // ---------------------------------------------------------------- events
  function bindSidebar() {
    const side = main.querySelector('.ws-side');
    side.querySelectorAll('[data-inc]').forEach((cb) => cb.addEventListener('change', () => setIncluded([cb.dataset.inc], cb.checked)));
  }
  async function setIncluded(ids, value) {
    try {
      await Promise.all(ids.map((sid) => api.patch(`/api/sources/${sid}`, { included: value })));
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function bindCommon() {
    bindSidebar();
    main.querySelector('.page').addEventListener('click', async (e) => {
      const t = e.target.closest('button, [data-step]');
      if (!t || t.disabled) return;
      if (t.dataset.step) {
        current = t.dataset.step;
        history.replaceState(null, '', `#/w/${id}/${current}`);
        return render();
      }
      if (t.dataset.mv) {
        const [i, d] = t.dataset.mv.split(':').map(Number);
        const order = ws.sources.map((s) => s.id);
        const j = i + d;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        await api.patch(`/api/workspaces/${id}`, { sourceOrder: order });
        return refresh();
      }
      if (t.dataset.rm) {
        const s = src(t.dataset.rm);
        if (!(await confirmDialog('Remove source?', `Remove "${s.title}" and its extracted pages from this workspace?`, 'Remove', 'danger'))) return;
        await api.del(`/api/sources/${s.id}`);
        uploadQueue = uploadQueue.filter((q) => q.sourceId !== s.id);
        sourceUnitsCache.delete(s.id);
        return refresh();
      }
      const act = t.dataset.act;
      if (act === 'all' || act === 'none') return setIncluded(ws.sources.filter((s) => s.included !== (act === 'all')).map((s) => s.id), act === 'all');
      if (act === 'rename' || t.id === 'ws-title') return rename();
      if (act === 'delete-ws') {
        if (!(await confirmDialog('Delete workspace?', 'This deletes the workspace with all its sources, summaries, quizzes and study sessions.', 'Delete workspace', 'danger'))) return;
        await api.del(`/api/workspaces/${id}`);
        return go('#/workspaces');
      }
    });
    main.querySelector('#ws-title').addEventListener('click', rename);
  }

  async function rename() {
    const name = await modal({ title: 'Rename workspace', body: `<div class="field"><label for="rn">Name</label><input id="rn" class="input" value="${esc(ws.title)}"></div>`, actions: [{ label: 'Cancel', value: () => null }, { label: 'Save', kind: 'primary', value: (w) => w.querySelector('#rn').value }] });
    if (name === null) return;
    await api.patch(`/api/workspaces/${id}`, { title: name });
    refresh();
  }

  function bindStep() {
    const body = main.querySelector('#step-body');
    body.onclick = async (e) => {
      const t = e.target.closest('button, label.btn');
      if (!t || t.disabled) return;
      try {
        if (t.dataset.choose) {
          const [sid, cid] = t.dataset.choose.split(':');
          t.disabled = true;
          const r = await api.post(`/api/sources/${sid}/choose`, { candidateId: cid });
          if (r.jobId) watchJob(r.jobId, sid);
          toast(state.status?.ai ? 'Book chosen. Researching accessible content…' : 'Book chosen. Checking catalogue sources…');
          current = 'research';
          history.replaceState(null, '', `#/w/${id}/research`);
          return refresh();
        }
        if (t.dataset.reid) {
          const s = src(t.dataset.reid);
          const q = await modal({ title: 'Search again', body: bookFormHtml('rq', s.query || {}), actions: [{ label: 'Cancel', value: () => null }, { label: 'Search', kind: 'primary', value: (w) => readBookForm(w, 'rq') }] });
          if (!q) return;
          const r = await api.post(`/api/sources/${s.id}/identify`, q);
          watchJob(r.jobId, s.id);
          return refresh();
        }
        if (t.dataset.manual) {
          const s = src(t.dataset.manual);
          const v = await modal({
            title: 'Enter book details',
            body: `<div class="stack"><p class="muted small" style="margin:0">Use this if your book is not listed. Research will then look for sources matching these details.</p>${['title', 'author', 'publisher', 'edition', 'year', 'isbn'].map((k) => `<div class="field"><label for="mb-${k}">${k[0].toUpperCase() + k.slice(1)}</label><input id="mb-${k}" class="input" value="${esc(s.query?.[k] || '')}"></div>`).join('')}</div>`,
            actions: [{ label: 'Cancel', value: () => null }, { label: 'Use these details', kind: 'primary', value: (w) => Object.fromEntries(['title', 'author', 'publisher', 'edition', 'year', 'isbn'].map((k) => [k, w.querySelector(`#mb-${k}`).value.trim()])) }],
          });
          if (!v) return;
          const r = await api.post(`/api/sources/${s.id}/choose`, { manual: v });
          if (r.jobId) watchJob(r.jobId, s.id);
          current = 'research';
          return refresh();
        }
        if (t.dataset.research) {
          const r = await api.post(`/api/sources/${t.dataset.research}/research`);
          watchJob(r.jobId, t.dataset.research);
          return refresh();
        }
        if (t.dataset.pages) {
          pageTab = t.dataset.pages;
          current = 'pages';
          return render();
        }
        if (t.dataset.addpages) {
          current = 'uploads';
          render();
          const sel = main.querySelector('#ap-book');
          if (sel) sel.value = t.dataset.addpages;
          main.querySelector('#ap-start')?.focus();
          return;
        }
        if (t.dataset.ptab) {
          pageTab = t.dataset.ptab;
          return render();
        }
        if (t.dataset.ocr) {
          const r = await api.post(`/api/sources/${t.dataset.ocr}/ocr`);
          watchJob(r.jobId, t.dataset.ocr);
          sourceUnitsCache.delete(t.dataset.ocr);
          toast('Running OCR on scanned pages…');
          return refresh();
        }
        if (t.dataset.unqueue) {
          const q = uploadQueue.find((x) => x.qid === t.dataset.unqueue);
          if (q?.sourceId && q.status !== 'error' && !q.bookId) {
            if (!(await confirmDialog('Remove file?', `Remove "${q.name}" from this workspace?`, 'Remove', 'danger'))) return;
            await api.del(`/api/sources/${q.sourceId}`).catch(() => {});
          }
          uploadQueue = uploadQueue.filter((x) => x.qid !== t.dataset.unqueue);
          return refresh();
        }
        if (t.dataset.pickmode) {
          const m = MODES.find((x) => x.key === t.dataset.pickmode);
          if (included().length < m.min) return toast(`${m.name} needs at least ${m.min} selected sources.`, 'bad');
          task.mode = m.key;
          saveTask(ws, task);
          current = 'settings';
          history.replaceState(null, '', `#/w/${id}/settings`);
          return render();
        }
        if (t.dataset.level) {
          task.level = Number(t.dataset.level);
          saveTask(ws, task);
          body.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('on', b === t));
          return;
        }
        const segEl = t.closest('[data-seg]');
        if (segEl && t.dataset.v !== undefined) {
          const name = segEl.dataset.seg;
          const v = name === 'count' ? Number(t.dataset.v) : t.dataset.v;
          if (name === 'studyLevel') task.study.level = v;
          else task.quiz[name] = v;
          saveTask(ws, task);
          if (name === 'mode' || name === 'topicMode') return render();
          segEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === t));
          return;
        }
        const act = t.dataset.act;
        if (act === 'paste') {
          const text = main.querySelector('#paste-text').value;
          const title = main.querySelector('#paste-title').value;
          await api.post(`/api/workspaces/${id}/paste`, { title, text });
          toast('Text added.', 'ok');
          return refresh();
        }
        if (act === 'clear-uploads') {
          const docs = ws.sources.filter((s) => s.kind !== 'book');
          if (!(await confirmDialog('Clear all files?', `Remove all ${docs.length} uploaded/pasted document(s) from this workspace?`, 'Clear all', 'danger'))) return;
          await Promise.all(docs.map((d) => api.del(`/api/sources/${d.id}`)));
          uploadQueue = uploadQueue.filter((q) => q.bookId);
          return refresh();
        }
        if (act === 'load-topics') {
          t.disabled = true;
          t.innerHTML = '<span class="spinner"></span> Reading the material…';
          topicsCache = await api.post(`/api/workspaces/${id}/topics`, { sourceIds: included().map((s) => s.id) });
          main.querySelector('#topics-box').innerHTML = topicsHtml();
          return;
        }
        if (act === 'start') return start();
      } catch (err) {
        toastError(err);
        t.disabled = false;
      }
    };
    body.onchange = (e) => {
      if (e.target.dataset.topic !== undefined) {
        const name = e.target.dataset.topic;
        task.quiz.topics = e.target.checked ? [...new Set([...task.quiz.topics, name])] : task.quiz.topics.filter((x) => x !== name);
        saveTask(ws, task);
      }
      if (e.target.dataset.inc) setIncluded([e.target.dataset.inc], e.target.checked);
      if (e.target.id === 'file-input' && e.target.files.length) enqueue([...e.target.files]);
      if (e.target.id === 'ap-file' && e.target.files.length) {
        enqueue([...e.target.files], { bookId: main.querySelector('#ap-book').value, startLabel: main.querySelector('#ap-start').value.trim() });
      }
    };
    body.oninput = (e) => {
      if (e.target.id === 'extra') task.extraInstruction = e.target.value;
      if (e.target.id === 'qfocus') task.quiz.focus = e.target.value;
      if (e.target.id === 'sfocus') task.study.focus = e.target.value;
      saveTask(ws, task);
    };
    const form = main.querySelector('#book-form');
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const q = readBookForm(form, 'bf');
        if (!q.title && !q.isbn) return toast('Enter a book title or ISBN.', 'bad');
        try {
          const r = await api.post(`/api/workspaces/${id}/books`, q);
          watchJob(r.jobId, r.source.id);
          await refresh();
        } catch (err) {
          toastError(err);
        }
      };
    }
    const dz = main.querySelector('#dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
      dz.addEventListener('drop', (e) => e.dataTransfer?.files?.length && enqueue([...e.dataTransfer.files]));
      dz.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), main.querySelector('#file-input').click()));
    }
    if (current === 'pages') bindEditor();
  }

  render();
  return () => {
    alive = false;
  };
}

// Small helpers for the quick-pick list (plain numbers only).
function parseSimple(str) {
  const out = [];
  for (const part of String(str || '').split(',')) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let k = Math.min(a, b); k <= Math.max(a, b) && out.length < 5000; k++) out.push(k);
  }
  return out;
}
function compress(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return parts.join(', ');
}
