// Generation progress view and the polished reading interface for results.
import { api, stream } from './api.js';
import { esc, icon, toast, toastError, renderMarkdown, wireCitations, statusBadge, loading, modal, timeAgo } from './ui.js';
import { go } from './core.js';

const LEVEL_NAMES = { 1: 'Insane detail', 2: 'Good detail', 3: 'OK detail', 4: 'Mid detail', 5: 'Low detail' };
const MODE_NAMES = { summarize: 'Summary', combined: 'Combined study guide', compare: 'Source comparison', revision: 'Revision guide' };

/** #/generate: runs a pending document or quiz generation stored in sessionStorage. */
export async function renderGenerate(main) {
  let req;
  try {
    req = JSON.parse(sessionStorage.getItem('pps-gen') || 'null');
  } catch { /* ignore */ }
  if (!req) {
    main.innerHTML = `<div class="page narrow"><div class="empty">Nothing to generate. <a href="#/">Back to the dashboard</a></div></div>`;
    return;
  }
  const isQuiz = req.kind === 'quiz';
  main.innerHTML = `<div class="page ${isQuiz ? 'narrow' : ''}">
    <div class="crumbs"><a href="#/w/${req.workspaceId}">Back to workspace</a></div>
    <div class="page-head"><div><h1>${isQuiz ? 'Creating your quiz' : `Writing your ${(MODE_NAMES[req.mode] || 'document').toLowerCase()}`}</h1><div class="sub">${isQuiz ? `${req.settings.count} questions · ${req.settings.difficulty} · ${req.settings.mode === 'test' ? 'Test mode' : 'Learning mode'}` : LEVEL_NAMES[req.level]}</div></div></div>
    <div class="card" style="margin-bottom:16px"><div class="row"><span class="spinner" id="gen-spin"></span><strong id="gen-stage">Starting…</strong></div><div class="muted small" id="gen-sources" style="margin-top:8px"></div></div>
    ${isQuiz ? '' : '<article class="prose stream-caret" id="gen-out"><p class="muted">The text appears here as it is written…</p></article>'}</div>`;
  const stage = main.querySelector('#gen-stage');
  const out = main.querySelector('#gen-out');
  let text = '';
  let meta = [];
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (out) out.innerHTML = renderMarkdown(text, { sources: meta });
  };
  const controller = new AbortController();
  sessionStorage.removeItem('pps-gen');
  try {
    if (isQuiz) {
      const done = await stream(`/api/workspaces/${req.workspaceId}/quizzes`, { sourceIds: req.sourceIds, settings: req.settings, avoidQuizId: req.avoidQuizId }, (ev) => {
        if (ev.type === 'stage') stage.textContent = ev.text;
      }, { signal: controller.signal });
      return go(`#/quiz/${done.quizId}`);
    }
    const done = await stream(`/api/workspaces/${req.workspaceId}/generate`, { mode: req.mode, level: req.level, sourceIds: req.sourceIds, extraInstruction: req.extraInstruction }, (ev) => {
      if (ev.type === 'meta') {
        meta = ev.material;
        main.querySelector('#gen-sources').innerHTML = meta.map((m) => `<div><strong>${m.key}</strong> ${esc(m.title)}: ${esc(m.selection)}${m.gaps.length ? ` <span style="color:var(--warn)">(${esc(m.gaps.join('; '))})</span>` : ''}</div>`).join('');
      }
      if (ev.type === 'stage') stage.textContent = ev.text;
      if (ev.type === 'delta') {
        text += ev.text;
        if (!raf) raf = requestAnimationFrame(paint);
      }
    }, { signal: controller.signal });
    history.replaceState(null, '', `#/output/${done.output.id}`);
    return renderOutput(main, { id: done.output.id, preloaded: done.output });
  } catch (err) {
    if (err.name === 'AbortError') return;
    main.querySelector('#gen-spin')?.remove();
    stage.innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`;
    out?.classList.remove('stream-caret');
    toastError(err);
    const retry = document.createElement('div');
    retry.className = 'row';
    retry.style.marginTop = '12px';
    retry.innerHTML = `<button class="btn primary">${icon('refresh')} Try again</button><a class="btn" href="#/w/${req.workspaceId}/start">Back to workspace</a>`;
    retry.querySelector('button').onclick = () => {
      sessionStorage.setItem('pps-gen', JSON.stringify(req));
      renderGenerate(main);
    };
    stage.parentElement.parentElement.appendChild(retry);
  }
  return () => controller.abort();
}

/** #/output/:id: polished reader with actions. */
export async function renderOutput(main, { id, preloaded }) {
  const o = preloaded || (await api.get(`/api/outputs/${id}`));
  const invalid = new Set((o.citationCheck?.invalid || []).map((x) => x.citation));
  const cc = o.citationCheck || { total: 0, valid: 0, invalid: [] };
  const gaps = o.materialMeta.filter((m) => m.gaps.length);
  main.innerHTML = `<div class="page">
    <div class="crumbs"><a href="#/">Dashboard</a><span>/</span><a href="#/w/${o.workspaceId}">${esc(o.workspaceTitle || 'Workspace')}</a></div>
    <div class="page-head"><div class="grow"><h1>${esc(o.title)}</h1><div class="sub">${esc(o.modeLabel)} · ${esc(o.levelName)} · ${timeAgo(o.createdAt)}</div></div></div>
    <div class="toolbar no-print" role="toolbar" aria-label="Document actions">
      <button class="btn sm" data-a="copy">${icon('copy')} Copy</button>
      <button class="btn sm" data-a="md">${icon('download')} Markdown</button>
      <button class="btn sm" data-a="html">${icon('download')} HTML</button>
      <button class="btn sm" data-a="print">${icon('print')} Print</button>
      <span style="width:1px;background:var(--border);margin:0 2px"></span>
      <label class="btn sm" style="gap:6px">${icon('summary')}<span class="sr-only">Detail level</span><select id="lvl" class="select" style="border:0;padding:0 4px;background:transparent;width:auto">${[1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${l === o.level ? 'selected' : ''}>${l}. ${LEVEL_NAMES[l]}</option>`).join('')}</select></label>
      <button class="btn sm" data-a="regen">${icon('refresh')} Regenerate</button>
      <span style="width:1px;background:var(--border);margin:0 2px"></span>
      <button class="btn sm" data-a="quiz">${icon('quiz')} Quiz me on this</button>
      <button class="btn sm" data-a="study">${icon('study')} Study this</button>
      <button class="btn sm" data-a="ask">${icon('chat')} Ask a question</button>
      <a class="btn sm ghost" href="#/w/${o.workspaceId}">${icon('back')} Workspace</a>
    </div>
    <div class="reader">
      <article>
        <div class="print-head"><h1>${esc(o.title)}</h1><p>${esc(o.modeLabel)} · ${esc(o.levelName)}</p>${o.materialMeta.map((m) => `<div>${m.key}: ${esc(m.title)}: ${esc(m.selection)}</div>`).join('')}</div>
        ${o.offline ? `<div class="alert warn no-print" style="margin-bottom:14px">${icon('key')}<div>This is an <strong>offline extractive</strong> version made without AI. Connect the AI in <a href="#/settings">Settings</a> and press Regenerate for a real ${esc(o.modeLabel.toLowerCase())}.</div></div>` : ''}
        ${o.truncated ? `<div class="alert warn" style="margin-bottom:14px">${icon('warn')}<div>The document reached the maximum length and may end abruptly. Try a lower detail level or a smaller page selection.</div></div>` : ''}
        <div class="prose" id="doc">${renderMarkdown(o.content, { sources: o.materialMeta, invalid })}</div>
      </article>
      <aside class="reader-meta">
        <div class="card"><h3>Sources used</h3><div class="stack" style="gap:12px">${o.materialMeta
          .map((m) => `<div><div class="row between" style="align-items:flex-start"><strong class="small"><span class="badge accent">${m.key}</span> ${esc(m.title)}</strong></div>
            <div class="muted tiny" style="margin:4px 0">${esc(m.selection)}</div>${m.excluded ? `<div class="tiny">Excluded: ${esc(m.excluded)}</div>` : ''}
            <div class="tiny">${m.used} ${m.unitType === 'page' ? (m.numbering === 'printed' ? 'printed pages' : 'PDF pages') : `${m.unitType}s`} used</div>
            ${m.gaps.length ? `<div class="tiny" style="color:var(--warn)">${esc(m.gaps.join('; '))}</div>` : ''}<div style="margin-top:4px">${statusBadge(m.status, m.statusLabel)}</div></div>`)
          .join('')}</div></div>
        <div class="card"><h3>Citation check</h3>${cc.total
          ? `<p class="small" style="margin:0">${cc.valid} of ${cc.total} citations point to pages in your selection.</p>${cc.invalid.length ? `<div class="alert warn" style="margin-top:8px">${icon('warn')}<div class="tiny">${cc.invalid.length} citation(s) do not match a selected page and are shown in red: ${esc(cc.invalid.slice(0, 5).map((x) => x.citation).join(', '))}</div></div>` : `<div class="badge ok" style="margin-top:8px">${icon('check')} All citations verified</div>`}`
          : '<p class="small muted" style="margin:0">No citations found.</p>'}
          <p class="muted tiny" style="margin:8px 0 0">Click any citation such as <span class="cite">S1 p.4</span> to see the page text it came from. Purple boxes are explanations beyond the source.</p></div>
        ${gaps.length ? `<div class="alert warn">${icon('warn')}<div class="small">Some selected pages were not accessible and were not used.</div></div>` : ''}
        <div class="card small"><h3>How this was made</h3><div class="muted">${o.pipeline?.strategy === 'hierarchical' ? `Large selection: processed in ${o.pipeline.chunks} parts, then combined.` : o.pipeline?.strategy === 'offline-extractive' ? 'Offline: key sentences extracted without AI.' : 'All selected pages were read in one pass.'}${o.extraInstruction ? `<br>Focus: ${esc(o.extraInstruction)}` : ''}</div></div>
      </aside></div></div>`;
  wireCitations(main.querySelector('#doc'));

  main.querySelector('.toolbar').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === 'copy') {
        await navigator.clipboard.writeText(o.content);
        toast('Copied to clipboard (Markdown).', 'ok');
      } else if (a === 'md' || a === 'html') {
        const res = await fetch(`/api/outputs/${o.id}/download?format=${a}`);
        const blob = await res.blob();
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `document.${a}`;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      } else if (a === 'print') {
        window.print();
      } else if (a === 'regen') {
        regenerate(o, Number(main.querySelector('#lvl').value));
      } else if (a === 'quiz') {
        const settings = await quizSettingsDialog();
        if (!settings) return;
        sessionStorage.setItem('pps-gen', JSON.stringify({ kind: 'quiz', workspaceId: o.workspaceId, sourceIds: o.sourceIds, settings }));
        go('#/generate');
      } else if (a === 'study' || a === 'ask') {
        const chat = await api.post(`/api/workspaces/${o.workspaceId}/chats`, { kind: a === 'ask' ? 'qa' : 'study', outputId: o.id });
        go(`#/chat/${chat.id}`);
      }
    } catch (err) {
      toastError(err);
    }
  });
  main.querySelector('#lvl').addEventListener('change', (e) => {
    const lvl = Number(e.target.value);
    if (lvl !== o.level) regenerate(o, lvl);
  });
}

function regenerate(o, level) {
  sessionStorage.setItem('pps-gen', JSON.stringify({ kind: 'doc', workspaceId: o.workspaceId, mode: o.mode, level, sourceIds: o.sourceIds, extraInstruction: o.extraInstruction || '' }));
  go('#/generate');
}

export async function quizSettingsDialog(defaults = {}) {
  const d = { count: 10, difficulty: 'normal', types: 'mixed', mode: 'test', ...defaults };
  const sel = (id, opts, v) => `<select id="${id}" class="select">${opts.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return modal({
    title: 'Quiz settings',
    body: `<div class="form-grid">
      <div class="field"><label for="qs-count">Questions</label>${sel('qs-count', [[5, '5'], [10, '10'], [15, '15'], [20, '20'], [30, '30']], d.count)}</div>
      <div class="field"><label for="qs-diff">Difficulty</label>${sel('qs-diff', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['mixed', 'Mixed']], d.difficulty)}</div>
      <div class="field"><label for="qs-types">Question types</label>${sel('qs-types', [['mixed', 'Mixed'], ['mcq', 'Multiple choice'], ['true_false', 'True / false'], ['written', 'Written answers']], d.types)}</div>
      <div class="field"><label for="qs-mode">Mode</label>${sel('qs-mode', [['test', 'Test mode'], ['learning', 'Learning mode']], d.mode)}</div></div>`,
    actions: [
      { label: 'Cancel', value: () => null },
      { label: 'Create quiz', kind: 'primary', value: (w) => ({ count: Number(w.querySelector('#qs-count').value), difficulty: w.querySelector('#qs-diff').value, types: w.querySelector('#qs-types').value, mode: w.querySelector('#qs-mode').value, topics: d.topics || [], focus: d.focus || '' }) },
    ],
  });
}

export { loading };
