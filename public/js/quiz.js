// Interactive quiz player and results screen.
import { api, stream } from './api.js';
import { esc, icon, toast, toastError, renderMarkdown, wireCitations, showSource } from './ui.js';
import { go } from './core.js';

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
const TYPE_LABEL = { mcq: 'Multiple choice', true_false: 'True or false', written: 'Written answer', numeric: 'Numerical answer' };
const VERDICT = { correct: ['Correct!', 'check'], partially_correct: ['Partly right', 'info'], incorrect: ['Not quite', 'x'] };

export async function renderQuiz(main, { id }) {
  let quiz = await api.get(`/api/quizzes/${id}`);
  let idx = Math.max(0, quiz.questions.findIndex((q) => !q.state.final));
  if (quiz.status === 'finished') return renderResults(main, quiz);
  let selected = null;
  let draft = '';
  const extra = new Map(); // `${idx}:${kind}:${step}` -> streamed text
  const md = (t) => renderMarkdown(t, { sources: quiz.materialMeta });

  function render() {
    const q = quiz.questions[idx];
    const answered = quiz.questions.filter((x) => x.state.final).length;
    const score = quiz.questions.reduce((s, x) => s + (x.state.final ? x.state.score || 0 : 0), 0);
    const learning = quiz.settings.mode === 'learning';
    const st = q.state;
    const final = st.final;
    const hasVerdict = Boolean(st.verdict);
    const choiceType = q.type === 'mcq' || q.type === 'true_false';
    const chosen = st.response !== null && choiceType ? Number(st.response) : selected;

    const optionsHtml = choiceType
      ? `<div class="options" role="radiogroup">${q.options
          .map((o, i) => {
            let cls = '';
            if (final && q.correctOption !== undefined) cls = i === q.correctOption ? 'correct' : i === chosen ? 'wrong' : '';
            else if (i === chosen && hasVerdict && !final) cls = 'wrong';
            else if (i === selected) cls = 'sel';
            const fb = final && q.optionFeedback?.[i] && (i === q.correctOption || i === chosen) ? `<span class="ofb">${esc(q.optionFeedback[i])}</span>` : '';
            return `<button class="opt ${cls}" role="radio" aria-checked="${i === selected}" data-opt="${i}" ${final ? 'disabled' : ''}><span class="key">${q.type === 'true_false' ? (i === 0 ? 'T' : 'F') : KEYS[i]}</span><span>${esc(o)}${fb}</span></button>`;
          })
          .join('')}</div>`
      : q.type === 'numeric'
        ? `<div class="field"><label for="ans" class="sr-only">Your answer</label><input id="ans" class="input" style="font-size:1.1rem;max-width:320px" inputmode="decimal" autocomplete="off" placeholder="Your answer" value="${esc(final ? st.response || '' : draft)}" ${final ? 'disabled' : ''}></div>`
        : `<div class="field"><label for="ans" class="sr-only">Your answer</label><textarea id="ans" class="textarea" placeholder="Write your answer in your own words…" ${final ? 'disabled' : ''}>${esc(final ? st.response || '' : draft)}</textarea><span class="hint">Answers are marked on meaning, so you don't need the book's exact wording.</span></div>`;

    const verdictHtml = hasVerdict
      ? `<div class="verdict ${st.verdict}" role="status"><span class="vi">${icon(VERDICT[st.verdict]?.[1] || 'info')}</span><div class="grow"><h3>${VERDICT[st.verdict]?.[0] || st.verdict}${!final ? ' — try again.' : ''}</h3>
          ${st.feedback?.feedback && !/^correct!?$/i.test(st.feedback.feedback.trim()) ? `<div class="prose bare">${md(st.feedback.feedback)}</div>` : ''}
          ${st.feedback?.whatWasRight && st.verdict !== 'correct' ? `<p class="small" style="margin:8px 0 0"><strong>What you got right:</strong> ${esc(st.feedback.whatWasRight)}</p>` : ''}
          ${st.feedback?.whatWentWrong && st.verdict !== 'correct' && st.feedback.whatWentWrong !== st.feedback.feedback ? `<p class="small" style="margin:6px 0 0"><strong>Where it went wrong:</strong> ${esc(st.feedback.whatWentWrong)}</p>` : ''}</div></div>`
      : '';

    const revealHtml = final || st.revealed
      ? `<div class="explain"><h4>Answer</h4><div class="prose bare"><strong>${esc(choiceType ? q.options[q.correctOption] : q.answer)}</strong></div>
          ${q.explanation ? `<h4 style="margin-top:14px">Why</h4><div class="prose bare">${md(q.explanation)}</div>` : ''}
          ${q.commonMistakes?.length && st.verdict !== 'correct' ? `<h4 style="margin-top:14px">Common mistakes</h4><ul class="small">${q.commonMistakes.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</div>`
      : '';

    const workingVisible = q.working?.length && (final || st.revealed || (learning && q.working));
    const workingHtml = workingVisible
      ? `<div class="explain"><h4>${icon('steps', '')} Step-by-step working</h4><ol class="steps">${q.working
          .map((w, i) => `<li><div><div class="calc">${esc(w.step)}</div><div class="why">${esc(w.explanation)}</div>
            ${extra.has(`${idx}:step:${i}`) ? `<div class="prose bare small" style="margin-top:8px;padding:10px;background:var(--surface-2);border-radius:8px">${md(extra.get(`${idx}:step:${i}`))}</div>` : `<button class="btn sm ghost" style="margin-top:4px" data-explain="step:${i}">${icon('bulb')} Explain this step</button>`}</div></li>`)
          .join('')}</ol>
          ${final || st.revealed ? (q.alternativeMethod ? `<details class="more" style="margin-top:12px"><summary>Show another method</summary><div class="prose bare" style="margin-top:8px">${md(q.alternativeMethod)}</div></details>` : extra.has(`${idx}:another_method:0`) ? `<h4 style="margin-top:14px">Another method</h4><div class="prose bare">${md(extra.get(`${idx}:another_method:0`))}</div>` : `<button class="btn sm" style="margin-top:12px" data-explain="another_method:0">${icon('refresh')} Show another method</button>`) : ''}</div>`
      : '';

    const teacherHtml = extra.has(`${idx}:teacher:0`) ? `<div class="explain"><h4>${icon('study')} Your teacher explains</h4><div class="prose bare">${md(extra.get(`${idx}:teacher:0`))}</div></div>` : '';
    const moreHintHtml = extra.has(`${idx}:hint_more:0`) ? `<div class="hint-box"><strong>Extra hint:</strong> <span class="prose bare">${md(extra.get(`${idx}:hint_more:0`))}</span></div>` : '';
    const hintsHtml = q.hintsShown.length ? q.hintsShown.map((h, i) => `<div class="hint-box"><strong>Hint ${i + 1}:</strong> ${esc(h)}</div>`).join('') : '';
    const sourceBtn = (final || learning) && q.sourceRefs?.length ? `<button class="btn sm ghost" data-a="source">${icon('book')} Where did this come from?</button>` : '';
    const canHint = (learning || final) && q.hintsShown.length < q.hintCount;
    const isLast = idx === quiz.questions.length - 1;

    main.innerHTML = `<div class="page"><div class="quiz-wrap">
      <div class="crumbs"><a href="#/w/${quiz.workspaceId}">Back to workspace</a><span>/</span><a href="#/quizzes">Quizzes</a></div>
      <div class="quiz-top">
        <div class="grow"><h2 style="margin:0">${esc(quiz.title)}</h2><div class="muted small">${esc(quiz.subject || '')}${quiz.contentType ? ` · ${esc(quiz.contentType)}` : ''}</div></div>
        <span class="badge ${learning ? 'info' : 'accent'}">${learning ? 'Learning mode' : 'Test mode'}</span>${quiz.offline ? '<span class="badge warn">Offline quiz</span>' : ''}
      </div>
      <div class="row" style="margin-bottom:14px"><div class="qprogress"><div class="row between small"><span>Question ${idx + 1} of ${quiz.questions.length}</span><span>Score <strong>${score}</strong> / ${answered} answered</span></div><div class="progress"><i style="width:${(answered / quiz.questions.length) * 100}%"></i></div></div></div>
      <div class="row tight" style="margin-bottom:14px;flex-wrap:wrap">${quiz.questions.map((x, i) => `<button class="pm ${i === idx ? 'in' : ''}" style="${x.state.final ? `background:${x.state.verdict === 'correct' ? 'var(--ok-soft)' : x.state.verdict === 'partially_correct' ? 'var(--warn-soft)' : 'var(--bad-soft)'};color:var(--text)` : ''}" data-jump="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`).join('')}</div>
      <div class="qcard">
        <div class="row tight"><span class="tag">${esc(q.topic)}</span><span class="badge ${q.difficulty === 'hard' ? 'bad' : q.difficulty === 'easy' ? 'ok' : 'info'}">${esc(q.difficulty)}</span><span class="muted tiny">${TYPE_LABEL[q.type]}</span></div>
        <div class="qtext prose bare">${md(q.question)}</div>
        ${optionsHtml}
        ${hintsHtml}${moreHintHtml}
        ${verdictHtml}${revealHtml}${workingHtml}${teacherHtml}
        <div class="qactions">
          ${!final ? `<button class="btn primary" data-a="submit">${icon('check')} ${hasVerdict ? 'Submit again' : 'Submit answer'}</button>` : ''}
          ${hasVerdict && !final ? `<button class="btn" data-a="retry">${icon('refresh')} Try again</button>` : ''}
          ${canHint ? `<button class="btn" data-a="hint">${icon('bulb')} Reveal a hint</button>` : ''}
          ${learning && !final && q.hintsShown.length >= q.hintCount && !quiz.offline ? `<button class="btn" data-explain="hint_more:0">${icon('bulb')} Another hint</button>` : ''}
          ${learning && !final && q.hasWorking && !q.working ? `<button class="btn" data-a="working">${icon('steps')} Show working</button>` : ''}
          ${learning && !final ? `<button class="btn ghost" data-a="reveal">${icon('eye')} Show answer</button>` : ''}
          ${final && st.verdict !== 'correct' && !quiz.offline && !extra.has(`${idx}:teacher:0`) ? `<button class="btn" data-explain="teacher:0">${icon('study')} Explain like a teacher</button>` : ''}
          ${sourceBtn}
          <span class="grow"></span>
          ${!final && !learning ? `<button class="btn ghost" data-a="skip">Skip</button>` : ''}
          ${final ? (isLast || quiz.questions.every((x) => x.state.final) ? `<button class="btn primary" data-a="finish">${icon('target')} See results</button>` : `<button class="btn primary" data-a="next">Next question ${icon('next')}</button>`) : ''}
        </div>
        ${!learning && !final ? '<p class="muted tiny" style="margin:10px 0 0">Test mode: hints and working appear after you submit.</p>' : ''}
      </div>
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost sm" data-a="finish">Finish quiz now</button></div>
    </div></div>`;
    wireCitations(main.querySelector('.qcard'));
    const ans = main.querySelector('#ans');
    if (ans && !final) {
      ans.addEventListener('input', () => (draft = ans.value));
      ans.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (q.type === 'numeric' || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          act('submit');
        }
      });
      ans.focus();
    }
  }

  async function act(a, btn) {
    const q = quiz.questions[idx];
    try {
      if (a === 'submit') {
        const response = q.type === 'mcq' || q.type === 'true_false' ? selected : draft.trim();
        if (response === null || response === '') return toast('Choose or write an answer first.', 'bad');
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Marking…';
        }
        const r = await api.post(`/api/quizzes/${id}/answer`, { index: idx, response });
        quiz = r.quiz;
        if (!r.canRetry) {
          selected = null;
          draft = '';
        }
      } else if (a === 'retry') {
        selected = null;
        draft = '';
        quiz.questions[idx].state.verdict = null;
        quiz.questions[idx].state.response = null;
      } else if (a === 'hint') quiz = (await api.post(`/api/quizzes/${id}/hint`, { index: idx })).quiz;
      else if (a === 'working') quiz = (await api.post(`/api/quizzes/${id}/working`, { index: idx })).quiz;
      else if (a === 'reveal') quiz = (await api.post(`/api/quizzes/${id}/reveal`, { index: idx })).quiz;
      else if (a === 'next' || a === 'skip') {
        const next = quiz.questions.findIndex((x, i) => i > idx && !x.state.final);
        idx = next >= 0 ? next : Math.min(idx + 1, quiz.questions.length - 1);
        selected = null;
        draft = '';
      } else if (a === 'finish') {
        const unanswered = quiz.questions.filter((x) => !x.state.final).length;
        if (unanswered && !confirm(`${unanswered} question(s) are unanswered and will count as incorrect. Finish anyway?`)) return;
        quiz = await api.post(`/api/quizzes/${id}/finish`);
        return renderResults(main, quiz);
      } else if (a === 'source') {
        const r = q.sourceRefs[0];
        const m = quiz.materialMeta.find((x) => x.key === r.source);
        return showSource({ sourceId: m?.id, refs: q.sourceRefs.filter((x) => x.source === r.source).map((x) => x.ref).join(','), key: r.source, quote: q.supportingQuote, quoteStatus: q.quoteStatus });
      }
      render();
    } catch (err) {
      toastError(err);
      render();
    }
  }

  async function explain(spec, btn) {
    const [kind, step] = spec.split(':');
    const key = `${idx}:${kind}:${step}`;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Thinking…';
    let text = '';
    try {
      await stream(`/api/quizzes/${id}/explain`, { index: idx, kind, step: Number(step) }, (ev) => {
        if (ev.type === 'delta') {
          text += ev.text;
          extra.set(key, text);
        }
        if (ev.type === 'done') extra.set(key, ev.text);
      });
      render();
    } catch (err) {
      toastError(err);
      render();
    }
  }

  const onClick = (e) => {
    if (!main.querySelector('.qcard')) return;
    const opt = e.target.closest('[data-opt]');
    if (opt && !opt.disabled) {
      selected = Number(opt.dataset.opt);
      const q = quiz.questions[idx];
      if (q.state.verdict && !q.state.final) {
        q.state.verdict = null;
        q.state.response = null;
      }
      return render();
    }
    const j = e.target.closest('[data-jump]');
    if (j) {
      idx = Number(j.dataset.jump);
      selected = null;
      draft = '';
      return render();
    }
    const ex = e.target.closest('[data-explain]');
    if (ex) return explain(ex.dataset.explain, ex);
    const b = e.target.closest('[data-a]');
    if (b) act(b.dataset.a, b);
  };
  main.addEventListener('click', onClick);
  const onKey = (e) => {
    if (!main.querySelector('.qcard') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const q = quiz.questions[idx];
    if (q.state.final) return;
    const k = e.key.toUpperCase();
    const i = q.type === 'true_false' ? (k === 'T' ? 0 : k === 'F' ? 1 : -1) : KEYS.indexOf(k);
    if (i >= 0 && i < (q.options?.length || 0)) {
      selected = i;
      render();
    }
    if (e.key === 'Enter' && selected !== null) act('submit');
  };
  document.addEventListener('keydown', onKey);
  render();
  return () => {
    document.removeEventListener('keydown', onKey);
    main.removeEventListener('click', onClick);
  };
}

function renderResults(main, quiz) {
  const r = quiz.results;
  const md = (t) => renderMarkdown(t, { sources: quiz.materialMeta });
  const grade = r.percent >= 85 ? 'Excellent work!' : r.percent >= 70 ? 'Good job!' : r.percent >= 50 ? 'Getting there.' : 'Keep practising, you’ll get it.';
  main.innerHTML = `<div class="page narrow">
    <div class="crumbs"><a href="#/w/${quiz.workspaceId}">Back to workspace</a><span>/</span><a href="#/quizzes">Quizzes</a></div>
    <div class="page-head"><div><h1>Quiz results</h1><div class="sub">${esc(quiz.title)}</div></div></div>
    <div class="card pad-lg"><div class="row" style="gap:28px">
      <div class="score-ring" style="--p:${r.percent}"><div><div><strong>${r.percent}%</strong><span class="muted small">${r.score} / ${r.total}</span></div></div></div>
      <div class="grow stack"><h2 style="margin:0">${grade}</h2>
        <div class="grid cols-4" style="grid-template-columns:repeat(4,minmax(70px,1fr))"><div class="stat"><strong style="color:var(--ok)">${r.correct}</strong><span class="small muted">Correct</span></div><div class="stat"><strong style="color:var(--warn)">${r.partial}</strong><span class="small muted">Partly</span></div><div class="stat"><strong style="color:var(--bad)">${r.incorrect}</strong><span class="small muted">Incorrect</span></div><div class="stat"><strong>${r.unanswered}</strong><span class="small muted">Skipped</span></div></div></div></div>
      <div class="row" style="margin-top:20px">
        <button class="btn primary" data-r="another">${icon('sparkle')} Generate another quiz</button>
        <button class="btn" data-r="retry">${icon('refresh')} Retry this quiz</button>
        ${r.weakTopics.length && !quiz.offline ? `<button class="btn" data-r="weak">${icon('target')} Practise weak topics</button><button class="btn" data-r="study">${icon('study')} Study weak topics</button>` : ''}
      </div></div>
    ${r.weakTopics.length ? `<div class="alert warn" style="margin-top:16px">${icon('target')}<div><strong>Topics to improve</strong><ul>${r.weakTopics.map((t) => `<li>${esc(t.topic)}: ${t.percent}% (${t.score}/${t.total})</li>`).join('')}</ul></div></div>` : `<div class="alert ok" style="margin-top:16px">${icon('check')}<div>No weak topics in this quiz. Try a harder difficulty next time.</div></div>`}
    <div class="section-title">By topic</div>
    <div class="card stack">${r.topics.map((t) => `<div><div class="row between small"><strong>${esc(t.topic)}</strong><span>${t.percent}%</span></div><div class="bar ${t.percent < 50 ? 'low' : t.percent < 70 ? 'mid' : ''}"><i style="width:${t.percent}%"></i></div></div>`).join('')}</div>
    <div class="section-title">Every question</div>
    <div class="stack" style="gap:8px">${quiz.questions
      .map((q, i) => {
        const v = q.state.final ? q.state.verdict : 'unanswered';
        const yours = q.state.response === null ? '(no answer)' : q.type === 'mcq' || q.type === 'true_false' ? q.options[Number(q.state.response)] : q.state.response;
        const correct = q.type === 'mcq' || q.type === 'true_false' ? q.options[q.correctOption] : q.answer;
        return `<details class="qlist-item" ${v !== 'correct' ? '' : ''}><summary><span class="badge ${v === 'correct' ? 'ok' : v === 'partially_correct' ? 'warn' : 'bad'}">${v === 'correct' ? 'Correct' : v === 'partially_correct' ? 'Partly' : v === 'unanswered' ? 'Skipped' : 'Incorrect'}</span><span class="grow small"><strong>${i + 1}.</strong> ${esc(q.question.replace(/[#>*_`]/g, '').slice(0, 140))}</span>${icon('down')}</summary>
          <div class="body stack" style="gap:8px"><div class="prose bare">${md(q.question)}</div>
          <div class="small"><strong>Your answer:</strong> ${esc(yours)}</div>
          <div class="small"><strong>Correct answer:</strong> ${esc(correct ?? '')}</div>
          ${q.state.feedback?.feedback && v !== 'correct' ? `<div class="explain" style="margin-top:4px"><h4>Feedback</h4><div class="prose bare small">${md(q.state.feedback.feedback)}</div></div>` : ''}
          ${q.explanation ? `<div class="explain" style="margin-top:4px"><h4>Explanation</h4><div class="prose bare small">${md(q.explanation)}</div></div>` : ''}
          ${q.working?.length ? `<div class="explain" style="margin-top:4px"><h4>Working</h4><ol class="steps">${q.working.map((w) => `<li><div><div class="calc">${esc(w.step)}</div><div class="why">${esc(w.explanation)}</div></div></li>`).join('')}</ol></div>` : ''}
          ${q.sourceRefs?.length ? `<div><button class="btn sm ghost" data-src="${i}">${icon('book')} Where did this come from?</button></div>` : ''}</div></details>`;
      })
      .join('')}</div></div>`;
  wireCitations(main);
  main.querySelector('.page').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-src]');
    if (s) {
      const q = quiz.questions[Number(s.dataset.src)];
      const r0 = q.sourceRefs[0];
      const m = quiz.materialMeta.find((x) => x.key === r0.source);
      return showSource({ sourceId: m?.id, refs: q.sourceRefs.filter((x) => x.source === r0.source).map((x) => x.ref).join(','), key: r0.source, quote: q.supportingQuote, quoteStatus: q.quoteStatus });
    }
    const b = e.target.closest('[data-r]');
    if (!b) return;
    try {
      const ws = await api.get(`/api/workspaces/${quiz.workspaceId}`);
      const sourceIds = ws.sources.map((x) => x.id).filter((sid) => quiz.materialMeta.some((m) => m.id === sid));
      if (b.dataset.r === 'retry') {
        const r2 = await api.post(`/api/quizzes/${quiz.id}/retry`);
        return go(`#/quiz/${r2.quizId}`);
      }
      if (b.dataset.r === 'another' || b.dataset.r === 'weak') {
        const settings = { ...quiz.settings, topics: b.dataset.r === 'weak' ? r.weakTopics.map((t) => t.topic) : quiz.settings.topics };
        sessionStorage.setItem('pps-gen', JSON.stringify({ kind: 'quiz', workspaceId: quiz.workspaceId, sourceIds, settings, avoidQuizId: quiz.id }));
        return go('#/generate');
      }
      if (b.dataset.r === 'study') {
        const chat = await api.post(`/api/workspaces/${quiz.workspaceId}/chats`, { kind: 'study', sourceIds, focus: `I found these topics hard in a quiz: ${r.weakTopics.map((t) => t.topic).join(', ')}` });
        return go(`#/chat/${chat.id}`);
      }
    } catch (err) {
      toastError(err);
    }
  });
}
