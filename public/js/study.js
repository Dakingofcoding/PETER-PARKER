// Study mode (tutor) and "Ask a question about this" conversations.
import { api, stream } from './api.js';
import { esc, icon, toastError, renderMarkdown, wireCitations, statusBadge } from './ui.js';
import { state } from './core.js';

const QUICK = [
  ['explain_differently', 'Explain differently'],
  ['example', 'Another example'],
  ['simpler', 'Make it simpler'],
  ['deeper', 'Go deeper'],
  ['check_me', 'Check my understanding'],
  ['next_topic', 'Next topic'],
  ['summary_so_far', 'Summarise so far'],
];

export async function renderChat(main, { id }) {
  let chat = await api.get(`/api/chats/${id}`);
  let busy = false;
  const md = (t) => renderMarkdown(t, { sources: chat.materialMeta });
  const isQA = chat.kind === 'qa';

  main.innerHTML = `<div class="page">
    <div class="crumbs"><a href="#/w/${chat.workspaceId}">Back to workspace</a><span>/</span><a href="#/study">Study mode</a></div>
    <div class="page-head"><div class="grow"><h1>${isQA ? 'Ask about your material' : 'Study mode'}</h1><div class="sub">${esc(chat.title)}</div></div>
      <div class="row tight">${isQA ? '' : `<label class="small muted" for="lvl">Level</label><select id="lvl" class="select" style="width:auto">${['beginner', 'intermediate', 'advanced'].map((l) => `<option value="${l}" ${chat.level === l ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}</select>`}
      <button class="btn sm ghost" id="src-toggle">${icon('book')} Sources</button></div></div>
    <div id="src-panel" class="card" style="display:none;margin-bottom:14px">${chat.materialMeta.map((m) => `<div class="row between small" style="padding:4px 0"><span><span class="badge accent">${m.key}</span> <strong>${esc(m.title)}</strong> <span class="muted">${esc(m.selection)}${m.gaps.length ? `; ${esc(m.gaps.join('; '))}` : ''}</span></span>${statusBadge(m.status, m.statusLabel)}</div>`).join('')}${chat.hasContextDoc ? '<div class="muted tiny" style="margin-top:6px">The tutor can also see the document you opened this from.</div>' : ''}</div>
    ${state.status?.ai ? '' : `<div class="alert bad" style="margin-bottom:14px">${icon('key')}<div>Study mode needs the AI connection. <a href="#/settings">See setup steps</a>.</div></div>`}
    <div class="chat">
      <div class="chat-log" id="log" aria-live="polite"></div>
      ${isQA ? '' : `<div class="chat-quick">${QUICK.map(([k, l]) => `<button class="btn sm" data-quick="${k}">${l}</button>`).join('')}</div>`}
      <form class="chat-input" id="form"><label for="msg" class="sr-only">Message</label><textarea id="msg" class="textarea" rows="1" placeholder="${isQA ? 'Ask a question about the selected material…' : 'Answer the tutor, or ask anything about the material…'}"></textarea><button class="btn primary" type="submit" id="send">${icon('next')}<span class="sr-only">Send</span></button></form>
    </div></div>`;
  const log = main.querySelector('#log');
  wireCitations(log);

  const bubble = (m) => (m.role === 'user' ? `<div class="msg user">${esc(m.content)}</div>` : `<div class="msg assistant"><div class="who">${isQA ? 'Answer' : 'Tutor'}</div><div class="prose">${md(m.content)}</div></div>`);
  function paint() {
    log.innerHTML = chat.messages.length ? chat.messages.map(bubble).join('') : `<div class="empty">${icon(isQA ? 'chat' : 'study')}<div>${isQA ? 'Ask anything about the selected pages. If the answer isn’t in your material, you will be told.' : 'Starting your lesson…'}</div></div>`;
    log.scrollTop = log.scrollHeight;
  }

  async function send(body, shownText) {
    if (busy) return;
    busy = true;
    main.querySelector('#send').disabled = true;
    if (shownText) chat.messages.push({ role: 'user', content: shownText });
    paint();
    const live = document.createElement('div');
    live.className = 'msg assistant';
    live.innerHTML = `<div class="who">${isQA ? 'Answer' : 'Tutor'}</div><div class="prose stream-caret"><span class="muted small">Thinking…</span></div>`;
    log.querySelector('.empty')?.remove();
    log.appendChild(live);
    log.scrollTop = log.scrollHeight;
    let text = '';
    let raf = 0;
    try {
      const done = await stream(`/api/chats/${id}/messages`, body, (ev) => {
        if (ev.type === 'stage') live.querySelector('.prose').innerHTML = `<span class="muted small">${esc(ev.text)}</span>`;
        if (ev.type === 'delta') {
          text += ev.text;
          if (!raf) raf = requestAnimationFrame(() => {
            raf = 0;
            live.querySelector('.prose').innerHTML = md(text);
            log.scrollTop = log.scrollHeight;
          });
        }
      });
      chat.messages.push(done.message);
    } catch (err) {
      if (shownText) chat.messages.pop();
      toastError(err);
    } finally {
      busy = false;
      main.querySelector('#send').disabled = false;
      paint();
    }
  }

  main.querySelector('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = main.querySelector('#msg');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    send({ text }, text);
  });
  main.querySelector('#msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      main.querySelector('#form').requestSubmit();
    }
  });
  main.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => send({ action: b.dataset.quick }, b.textContent)));
  main.querySelector('#src-toggle').addEventListener('click', () => {
    const p = main.querySelector('#src-panel');
    p.style.display = p.style.display === 'none' ? '' : 'none';
  });
  main.querySelector('#lvl')?.addEventListener('change', async (e) => {
    try {
      chat = { ...chat, ...(await api.patch(`/api/chats/${id}`, { level: e.target.value })) };
    } catch (err) {
      toastError(err);
    }
  });

  paint();
  if (!isQA && !chat.messages.length && state.status?.ai) send({ start: true });
}
