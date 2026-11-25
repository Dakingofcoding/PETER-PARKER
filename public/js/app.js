// App shell: navigation, routing, dashboard, libraries and settings.
import { api } from './api.js';
import { esc, icon, $, toast, toastError, timeAgo, modal, loading, confirmDialog } from './ui.js';
import { renderWorkspace, addBookDialog } from './workspace.js';
import { renderGenerate, renderOutput } from './results.js';
import { renderQuiz } from './quiz.js';
import { renderChat } from './study.js';
import { state, go, aiBanner } from './core.js';

// ---------------- theme ----------------
function applyTheme() {
  let t = 'system';
  try {
    t = localStorage.getItem('pps-theme') || 'system';
  } catch { /* storage unavailable */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

// ---------------- nav ----------------
const NAV = [
  { href: '#/', label: 'Dashboard', icon: 'home', match: /^#\/?$/ },
  { href: '#/workspaces', label: 'Workspaces', icon: 'folder', match: /^#\/(workspaces|w\/)/ },
  { sep: true },
  { href: '#/summaries', label: 'Summaries', icon: 'summary', match: /^#\/(summaries|output)/ },
  { href: '#/quizzes', label: 'Quizzes', icon: 'quiz', match: /^#\/quiz/ },
  { href: '#/study', label: 'Study mode', icon: 'study', match: /^#\/(study|chat)/ },
  { href: '#/revision', label: 'Revision', icon: 'revision', match: /^#\/revision/ },
  { sep: true },
  { href: '#/settings', label: 'Settings', icon: 'settings', match: /^#\/settings/ },
];

function renderNav() {
  const h = location.hash || '#/';
  $('#nav').innerHTML = NAV.map((n) => (n.sep ? '<div class="nav-sep"></div>' : `<a href="${n.href}" class="${n.match.test(h) ? 'active' : ''}">${icon(n.icon)}<span>${n.label}</span></a>`)).join('');
  $('#tabbar').innerHTML = NAV.filter((n) => !n.sep && n.label !== 'Revision')
    .map((n) => `<a href="${n.href}" class="${n.match.test(h) ? 'active' : ''}">${icon(n.icon)}<span>${n.label.replace(' mode', '')}</span></a>`)
    .join('');
}

function renderAiPill() {
  const s = state.status;
  $('#ai-pill').innerHTML = s
    ? s.ai
      ? `<a href="#/settings" class="pill ok" style="text-decoration:none">${icon('sparkle')}<span>AI connected<br><span class="tiny">${esc(s.model)}</span></span></a>`
      : `<a href="#/settings" class="pill warn" style="text-decoration:none">${icon('key')}<span>AI not connected<br><span class="tiny">Set up in Settings</span></span></a>`
    : '';
}

// ---------------- router ----------------
let cleanup = null;
const routes = [
  [/^#\/?$/, renderDashboard],
  [/^#\/workspaces$/, renderWorkspaces],
  [/^#\/w\/([\w]+)(?:\/(\w+))?$/, (m, p) => renderWorkspace(m, { id: p[1], step: p[2] })],
  [/^#\/generate$/, renderGenerate],
  [/^#\/output\/([\w]+)$/, (m, p) => renderOutput(m, { id: p[1] })],
  [/^#\/quiz\/([\w]+)$/, (m, p) => renderQuiz(m, { id: p[1] })],
  [/^#\/chat\/([\w]+)$/, (m, p) => renderChat(m, { id: p[1] })],
  [/^#\/summaries$/, (m) => renderOutputsLibrary(m, { mode: null })],
  [/^#\/revision$/, (m) => renderOutputsLibrary(m, { mode: 'revision' })],
  [/^#\/quizzes$/, renderQuizLibrary],
  [/^#\/study$/, renderStudyLibrary],
  [/^#\/settings$/, renderSettings],
];

async function route() {
  renderNav();
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  const main = $('#main');
  const h = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = re.exec(h);
    if (m) {
      main.innerHTML = loading();
      try {
        cleanup = await fn(main, m);
      } catch (err) {
        main.innerHTML = `<div class="page narrow"><div class="alert bad">${icon('warn')}<div><strong>Something went wrong.</strong><p>${esc(err.message)}</p><a href="#/">Back to the dashboard</a></div></div></div>`;
      }
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = `<div class="page narrow"><div class="empty">Page not found. <a href="#/">Go to the dashboard</a></div></div>`;
}
window.addEventListener('hashchange', route);

// ---------------- workspace helpers ----------------
async function createWorkspace(title) {
  return api.post('/api/workspaces', { title });
}

async function pickWorkspace(purpose) {
  const list = await api.get('/api/workspaces');
  const opts = list.map((w) => `<option value="${w.id}">${esc(w.title)} (${w.sourceCount} source${w.sourceCount === 1 ? '' : 's'})</option>`).join('');
  return modal({
    title: purpose,
    body: `<div class="stack">
      <div class="field"><label for="pw-sel">Workspace</label><select id="pw-sel" class="select"><option value="__new">+ New workspace</option>${opts}</select></div>
      <div class="field" id="pw-new"><label for="pw-title">New workspace name</label><input id="pw-title" class="input" placeholder="e.g. Year 6 Maths revision" value="My study session"></div></div>`,
    onMount: (wrap) => {
      const sel = wrap.querySelector('#pw-sel');
      if (list.length) sel.value = list[0].id;
      const sync = () => (wrap.querySelector('#pw-new').style.display = sel.value === '__new' ? '' : 'none');
      sel.addEventListener('change', sync);
      sync();
    },
    actions: [
      { label: 'Cancel', value: () => null },
      {
        label: 'Continue',
        kind: 'primary',
        value: async (wrap) => {
          const v = wrap.querySelector('#pw-sel').value;
          if (v !== '__new') return v;
          const ws = await createWorkspace(wrap.querySelector('#pw-title').value);
          return ws.id;
        },
      },
    ],
  });
}

async function quickAction(kind) {
  try {
    if (kind === 'new') {
      const name = await modal({
        title: 'New study workspace',
        body: '<div class="field"><label for="nw">Name</label><input id="nw" class="input" placeholder="e.g. My study session" value="My study session"></div>',
        actions: [{ label: 'Cancel', value: () => null }, { label: 'Create', kind: 'primary', value: (w) => w.querySelector('#nw').value }],
      });
      if (name === null) return;
      const ws = await createWorkspace(name);
      return go(`#/w/${ws.id}/books`);
    }
    if (kind === 'research') {
      const ws = await createWorkspace('Book research');
      const added = await addBookDialog(ws.id);
      if (added) {
        await api.patch(`/api/workspaces/${ws.id}`, { title: `Research: ${added.title}`.slice(0, 120) });
        return go(`#/w/${ws.id}/books`);
      }
      await api.del(`/api/workspaces/${ws.id}`);
      return;
    }
    const purposes = { books: 'Add books to which workspace?', upload: 'Upload documents to which workspace?', summarize: 'Summarise material from which workspace?', quiz: 'Make a quiz from which workspace?', study: 'Study material from which workspace?', revision: 'Build a revision guide from which workspace?' };
    const id = await pickWorkspace(purposes[kind]);
    if (!id) return;
    if (kind === 'books') return go(`#/w/${id}/books`);
    if (kind === 'upload') return go(`#/w/${id}/uploads`);
    try {
      sessionStorage.setItem(`pps-mode-${id}`, kind);
    } catch { /* ignore */ }
    return go(`#/w/${id}/mode`);
  } catch (err) {
    toastError(err);
  }
}

// ---------------- dashboard ----------------
const ACTIONS = [
  ['new', 'folder', 'New Study Workspace', 'Start a guided session: add books, pick pages, choose a mode.', ''],
  ['research', 'search', 'Research a Book', 'Type a book name. We identify the edition and find accessible content.', 'info'],
  ['books', 'books', 'Add Books', 'Add more books to an existing workspace.', ''],
  ['upload', 'upload', 'Upload Documents', 'PDF, Word, PowerPoint, EPUB, text or photos of pages.', 'violet'],
  ['summarize', 'summary', 'Summaries', 'Five levels of detail, from insane detail to quick bullets.', ''],
  ['quiz', 'quiz', 'Quizzes', 'Questions for any subject, marked with teacher-style feedback.', 'ok'],
  ['study', 'study', 'Study Mode', 'A tutor that explains your material and checks your understanding.', 'info'],
  ['revision', 'revision', 'Revision', 'Key facts, formulas, definitions and question styles.', 'warn'],
];

async function renderDashboard(main) {
  const [workspaces, outputs, quizzes] = await Promise.all([api.get('/api/workspaces'), api.get('/api/outputs'), api.get('/api/quizzes')]);
  main.innerHTML = `<div class="page">
    <section class="hero">
      <h1>What are you studying today?</h1>
      <p>Name your books or upload your own material, choose exactly which pages to use, then summarise, study with a tutor, or test yourself. Everything stays tied to the pages it came from.</p>
      <div class="row" style="margin-top:14px">
        <button class="btn primary lg" data-q="research">${icon('search')} Research a book</button>
        <button class="btn lg" data-q="new">${icon('plus')} New workspace</button>
      </div>
    </section>
    ${aiBanner()}
    <div class="section-title">Start</div>
    <div class="grid cols-4">${ACTIONS.map(([k, ic, t, d, c]) => `<button class="card link action-card" style="text-align:left" data-q="${k}"><span class="ic ${c}">${icon(ic)}</span><span><h3>${t}</h3><p>${d}</p></span></button>`).join('')}
      <a class="card link action-card" href="#/settings"><span class="ic">${icon('settings')}</span><span><h3>Settings</h3><p>AI connection, theme and how the app works.</p></span></a></div>

    <div class="section-title">Recent workspaces ${workspaces.length ? '<a href="#/workspaces" class="small">View all</a>' : ''}</div>
    ${workspaces.length ? `<div class="grid cols-3">${workspaces.slice(0, 6).map(wsCard).join('')}</div>` : `<div class="empty">${icon('folder')}<div>No workspaces yet. Start by researching a book or creating a workspace.</div></div>`}

    <div class="grid cols-2" style="margin-top:8px">
      <div><div class="section-title">Recent summaries & guides</div>${outputs.length ? `<div class="list">${outputs.slice(0, 5).map(outputRow).join('')}</div>` : '<div class="empty small">Nothing generated yet.</div>'}</div>
      <div><div class="section-title">Recent quizzes</div>${quizzes.length ? `<div class="list">${quizzes.slice(0, 5).map(quizRow).join('')}</div>` : '<div class="empty small">No quizzes yet.</div>'}</div>
    </div></div>`;
  main.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => quickAction(b.dataset.q)));
}

const wsCard = (w) => `<a class="card link" href="#/w/${w.id}">
  <div class="row between"><h3 style="margin:0">${esc(w.title)}</h3><span class="muted tiny">${timeAgo(w.updatedAt)}</span></div>
  <div class="muted small" style="margin:6px 0 10px">${w.sourceCount} source${w.sourceCount === 1 ? '' : 's'} · ${w.outputCount} document${w.outputCount === 1 ? '' : 's'} · ${w.quizCount} quiz${w.quizCount === 1 ? '' : 'zes'}</div>
  <div class="row tight">${w.sources.slice(0, 4).map((s) => `<span class="tag">${esc(s.title.slice(0, 34))}</span>`).join('')}${w.sources.length > 4 ? `<span class="tag">+${w.sources.length - 4}</span>` : ''}</div></a>`;

const MODE_ICON = { summarize: 'summary', combined: 'combine', compare: 'compare', revision: 'revision' };
const outputRow = (o) => `<a class="list-row" href="#/output/${o.id}"><span class="ic">${icon(MODE_ICON[o.mode] || 'summary')}</span><span class="grow"><div class="t">${esc(o.title)}</div><div class="s">${esc(o.modeLabel)} · ${esc(o.levelName)} · ${timeAgo(o.createdAt)}${o.offline ? ' · offline' : ''}</div></span></a>`;
const quizRow = (q) => `<a class="list-row" href="#/quiz/${q.id}"><span class="ic">${icon('quiz')}</span><span class="grow"><div class="t">${esc(q.title)}</div><div class="s">${q.count} questions · ${q.status === 'finished' ? `scored ${q.results?.percent ?? 0}%` : 'in progress'} · ${timeAgo(q.createdAt)}</div></span></a>`;

async function renderWorkspaces(main) {
  const list = await api.get('/api/workspaces');
  main.innerHTML = `<div class="page"><div class="page-head"><div><h1>Workspaces</h1><div class="sub">Each workspace holds books and documents with their own page selections.</div></div><button class="btn primary" data-q="new">${icon('plus')} New workspace</button></div>
    ${list.length ? `<div class="grid cols-3">${list.map(wsCard).join('')}</div>` : `<div class="empty">${icon('folder')}<div>No workspaces yet.</div></div>`}</div>`;
  main.querySelector('[data-q]').addEventListener('click', () => quickAction('new'));
}

async function renderOutputsLibrary(main, { mode }) {
  const all = await api.get('/api/outputs');
  const list = mode ? all.filter((o) => o.mode === mode) : all;
  const title = mode === 'revision' ? 'Revision guides' : 'Summaries & study guides';
  main.innerHTML = `<div class="page narrow"><div class="page-head"><div><h1>${title}</h1><div class="sub">${mode === 'revision' ? 'Essential topics, definitions, formulas and question styles.' : 'Summaries, combined study guides, comparisons and revision guides.'}</div></div><button class="btn primary" data-q="${mode || 'summarize'}">${icon('plus')} New ${mode === 'revision' ? 'revision guide' : 'summary'}</button></div>
    ${list.length ? `<div class="list">${list.map((o) => `<div class="row" style="gap:6px">${outputRow(o).replace('class="list-row"', 'class="list-row grow"')}<button class="btn ghost icon" data-del="${o.id}" aria-label="Delete">${icon('trash')}</button></div>`).join('')}</div>` : `<div class="empty">${icon('summary')}<div>Nothing here yet.</div></div>`}</div>`;
  main.querySelector('[data-q]').addEventListener('click', (e) => quickAction(e.currentTarget.dataset.q));
  main.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete document?', 'This removes the generated document. Your sources are not affected.', 'Delete', 'danger'))) return;
      await api.del(`/api/outputs/${b.dataset.del}`);
      renderOutputsLibrary(main, { mode });
    }),
  );
}

async function renderQuizLibrary(main) {
  const list = await api.get('/api/quizzes');
  main.innerHTML = `<div class="page narrow"><div class="page-head"><div><h1>Quizzes</h1><div class="sub">Every quiz is generated from the pages you selected.</div></div><button class="btn primary" data-q="quiz">${icon('plus')} New quiz</button></div>
    ${list.length ? `<div class="list">${list.map((q) => `<div class="row" style="gap:6px">${quizRow(q).replace('class="list-row"', 'class="list-row grow"')}<button class="btn ghost icon" data-del="${q.id}" aria-label="Delete">${icon('trash')}</button></div>`).join('')}</div>` : `<div class="empty">${icon('quiz')}<div>No quizzes yet.</div></div>`}</div>`;
  main.querySelector('[data-q]').addEventListener('click', () => quickAction('quiz'));
  main.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete quiz?', 'This removes the quiz and its results.', 'Delete', 'danger'))) return;
      await api.del(`/api/quizzes/${b.dataset.del}`);
      renderQuizLibrary(main);
    }),
  );
}

async function renderStudyLibrary(main) {
  const list = await api.get('/api/chats');
  main.innerHTML = `<div class="page narrow"><div class="page-head"><div><h1>Study mode</h1><div class="sub">Tutoring sessions and question threads about your material.</div></div><button class="btn primary" data-q="study">${icon('plus')} Start studying</button></div>
    ${aiBanner()}
    ${list.length ? `<div class="list">${list.map((c) => `<div class="row" style="gap:6px"><a class="list-row grow" href="#/chat/${c.id}"><span class="ic">${icon(c.kind === 'qa' ? 'chat' : 'study')}</span><span class="grow"><div class="t">${esc(c.title)}</div><div class="s">${c.messages} messages · ${timeAgo(c.updatedAt)}</div></span></a><button class="btn ghost icon" data-del="${c.id}" aria-label="Delete">${icon('trash')}</button></div>`).join('')}</div>` : `<div class="empty">${icon('study')}<div>No study sessions yet.</div></div>`}</div>`;
  main.querySelector('[data-q]').addEventListener('click', () => quickAction('study'));
  main.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete conversation?', 'This removes the conversation history.', 'Delete', 'danger'))) return;
      await api.del(`/api/chats/${b.dataset.del}`);
      renderStudyLibrary(main);
    }),
  );
}

// ---------------- settings ----------------
async function renderSettings(main) {
  state.status = await api.get('/api/status');
  renderAiPill();
  const s = state.status;
  let theme = 'system';
  try {
    theme = localStorage.getItem('pps-theme') || 'system';
  } catch { /* ignore */ }
  const feat = (ok, name, detail) => `<tr><td>${ok ? '<span class="badge ok">Available</span>' : '<span class="badge warn">Needs AI key</span>'}</td><td><strong>${name}</strong><div class="muted small">${detail}</div></td></tr>`;
  main.innerHTML = `<div class="page narrow">
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Connection status and how Peter Parker Study works.</div></div></div>
    <div class="card pad-lg stack">
      <div class="card-title"><h2>AI connection</h2>${s.ai ? '<span class="badge ok"><span class="dot"></span>Connected</span>' : '<span class="badge warn"><span class="dot"></span>Not connected</span>'}</div>
      ${s.browserMode ? browserKeyForm(s) : s.ai
        ? `<p>The server has an Anthropic API key. Model: <span class="mono">${esc(s.model)}</span>. Refusal fallback: ${s.refusalFallback ? 'on' : 'off'}. The key stays on the server and is never sent to your browser.</p>`
        : `<p>AI features need an Anthropic API key on the <strong>server</strong>. Keys are never entered in the browser.</p>
           <ol class="small" style="padding-left:18px">
             <li>Get a key at <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a> → API Keys.</li>
             <li>In the project folder, copy <span class="mono">.env.example</span> to <span class="mono">.env</span>.</li>
             <li>Set <span class="mono">ANTHROPIC_API_KEY=sk-ant-…</span> in <span class="mono">.env</span>.</li>
             <li>Restart the server (<span class="mono">npm start</span>) and reload this page.</li>
           </ol>`}
    </div>
    <div class="section-title">Features</div>
    <div class="table-wrap"><table class="t"><tbody>
      ${feat(true, 'Uploads & extraction', 'PDF (per page, printed page labels), Word, PowerPoint (per slide, with notes), EPUB (per chapter), TXT/Markdown/HTML and pasted text.')}
      ${feat(true, 'Page, chapter and slide selection', 'Ranges, exclusions, chapters, printed vs PDF numbering, missing-page reports.')}
      ${feat(true, 'Book catalogue lookup', 'Open Library, Google Books and Project Gutenberg identify books and find public-domain full texts.')}
      ${feat(s.ai, 'Web research', 'Claude searches the web to confirm the edition and find legitimate sources (publisher samples, open textbooks, previews), then the server downloads what is genuinely accessible.')}
      ${feat(s.ai, 'OCR of scanned pages and photos', 'Pages without a text layer are read with Claude’s vision.')}
      ${feat(s.ai, 'Summaries at five detail levels, combined guides, comparisons, revision guides', 'Without a key you get a clearly labelled offline extractive version.')}
      ${feat(s.ai, 'Universal quizzes with intelligent marking', 'Without a key you get a basic fill-in-the-blank quiz.')}
      ${feat(s.ai, 'Study mode tutor and Q&A', 'Grounded in your selected pages with citations.')}
    </tbody></table></div>
    <div class="section-title">Appearance</div>
    <div class="card"><div class="row between"><div><strong>Theme</strong><div class="muted small">Light, dark or follow your device.</div></div>
      <div class="seg" id="theme">${['system', 'light', 'dark'].map((t) => `<button data-t="${t}" class="${t === theme ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div></div>
    <div class="section-title">Honesty & sources</div>
    <div class="card stack small">
      <p style="margin:0">The app only uses text it actually extracted or downloaded. A book is marked <strong>Full Selected Content Accessible</strong> only when every page in your selection was retrieved and readable. Pages that could not be accessed are listed as missing and are never summarised or quizzed.</p>
      <p style="margin:0">Citations such as <span class="cite">S1 p.12</span> open the exact page text. Each document shows a citation check confirming that every citation points to a page you selected. Extra explanations that are not in your material appear in purple “Beyond the source” boxes.</p>
      <p style="margin:0">Large selections over ${Math.round(s.singlePassMaxChars / 1000)}k characters are processed in parts and then combined, so nothing is silently cut off.</p>
    </div></div>`;
  main.querySelector('#key-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/local/settings', { apiKey: main.querySelector('#api-key').value.trim(), model: main.querySelector('#api-model').value.trim() });
      toast('Saved.', 'ok');
      renderSettings(main);
    } catch (err) {
      toastError(err);
    }
  });
  main.querySelector('#key-remove')?.addEventListener('click', async () => {
    await api.post('/api/local/settings', { apiKey: '' });
    toast('Key removed from this browser.');
    renderSettings(main);
  });
  main.querySelectorAll('#theme button').forEach((b) =>
    b.addEventListener('click', () => {
      try {
        localStorage.setItem('pps-theme', b.dataset.t);
      } catch { /* ignore */ }
      applyTheme();
      renderSettings(main);
    }),
  );
}

function browserKeyForm(s) {
  return `${s.ai ? `<p>Your Anthropic API key is saved in this browser only. Model: <span class="mono">${esc(s.model)}</span>.</p><div class="row"><button class="btn danger" id="key-remove" type="button">${icon('trash')} Remove key</button></div>` : '<p>Paste your Anthropic API key to turn on research, summaries, quizzes, the tutor and OCR. Get one at <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a> → API Keys.</p>'}
    <form id="key-form" class="stack" style="margin-top:6px">
      ${s.ai ? '' : '<div class="field"><label for="api-key">API key</label><input id="api-key" class="input" type="password" autocomplete="off" placeholder="sk-ant-…"></div>'}
      <div class="field"><label for="api-model">Model</label><input id="api-model" class="input" value="${esc(s.model)}"></div>
      ${s.ai ? '<input id="api-key" type="hidden" value="__keep__">' : ''}
      <div><button class="btn primary" type="submit">Save</button></div>
      <p class="muted small" style="margin:0">The key is stored only in this browser (on this device) and is sent only to Anthropic. Anyone using this browser profile could see it, so don't use this on a shared computer. Your books and results are also stored only in this browser.</p>
    </form>`;
}

// ---------------- boot ----------------
(async function boot() {
  try {
    state.status = await api.get('/api/status');
  } catch (err) {
    toast(err.message, 'bad');
  }
  renderAiPill();
  route();
})();
