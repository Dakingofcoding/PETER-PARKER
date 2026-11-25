// TEST-ONLY scripted stand-in for the Anthropic client, loaded via TEST_FAKE_AI_MODULE.
// It mimics client.beta.messages.stream(): .on('text'|'contentBlock', cb) and .finalMessage().
// Responses are derived from the material in the prompt so citations are real.

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text || '').join('\n');
}
function refsFrom(text) {
  const out = [];
  const re = /<source key="(S\d+)"[\s\S]*?<\/source>/g;
  for (const m of text.matchAll(re)) {
    for (const u of m[0].matchAll(/<unit ref="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/unit>/g)) out.push({ key: m[1], ref: u[1], text: u[2] });
  }
  return out;
}

function makeStream(message, textChunks = []) {
  const handlers = { text: [], contentBlock: [] };
  return {
    on(ev, cb) {
      (handlers[ev] ||= []).push(cb);
      return this;
    },
    async finalMessage() {
      for (const t of textChunks) {
        await new Promise((r) => setTimeout(r, 5));
        handlers.text.forEach((cb) => cb(t));
      }
      for (const b of message.content) handlers.contentBlock.forEach((cb) => cb(b));
      return message;
    },
  };
}
const msg = (content, stop = 'end_turn') => ({ id: 'msg_fake', role: 'assistant', model: 'fake', content, stop_reason: stop, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } });

function lastUser(params) {
  const m = [...params.messages].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || '').join(' ');
}

function respond(params) {
  const sys = systemText(params.system);
  const user = lastUser(params);
  const units = refsFrom(sys);
  const submit = params.tools?.find((t) => t.name?.startsWith('submit_'));

  if (submit?.name === 'submit_candidates') {
    return msg([
      { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'Collins Busy Ants Maths 6A ISBN' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [{ type: 'web_search_result', url: 'https://collins.co.uk/', title: 'Collins' }] },
      {
        type: 'tool_use', id: 'tu1', name: 'submit_candidates',
        input: {
          candidates: [
            { title: 'Busy Ant Maths Pupil Book 6A', subtitle: '', authors: ['Jeanette Mumford', 'Sandra Roberts', 'Elizabeth Jurgensen'], publisher: 'Collins', edition: 'Pupil Book 6A (2014)', year: 2014, isbn13s: ['9780007568314'], series: 'Busy Ant Maths', subject: 'Mathematics', level: 'Year 6', pageCount: 96, description: 'Pupil book for the first half of Year 6.', distinguishingNotes: 'Book 6A covers the autumn/spring units; 6B is a separate volume.', evidenceUrls: ['https://collins.co.uk/busy-ant'], confidence: 'high' },
            { title: 'Busy Ant Maths Pupil Book 6B', subtitle: '', authors: ['Jeanette Mumford'], publisher: 'Collins', edition: 'Pupil Book 6B (2014)', year: 2014, isbn13s: ['9780007568321'], series: 'Busy Ant Maths', subject: 'Mathematics', level: 'Year 6', pageCount: 96, description: '', distinguishingNotes: 'Second volume (6B), not 6A.', evidenceUrls: [], confidence: 'medium' },
          ],
          notes: 'Two volumes exist (6A and 6B).',
        },
      },
    ], 'tool_use');
  }
  if (submit?.name === 'submit_research') {
    return msg([
      { type: 'server_tool_use', id: 'srv2', name: 'web_fetch', input: { url: 'https://collins.co.uk/sample.pdf' } },
      {
        type: 'tool_use', id: 'tu2', name: 'submit_research',
        input: {
          verifiedIdentity: { title: 'Busy Ant Maths Pupil Book 6A', authors: ['Jeanette Mumford'], publisher: 'Collins', edition: 'Pupil Book 6A', year: 2014, isbn13: '9780007568314', pageCount: 96, matchesChosenEdition: true, notes: '' },
          sources: [
            { url: 'https://collins.co.uk/busy-ant-6a', title: 'Publisher page', host: 'collins.co.uk', type: 'metadata', license: 'publisher_page', format: 'html', directFileUrl: '', pagesCovered: 'unknown', printedPageStart: null, edition: 'Pupil Book 6A', sameEdition: 'yes', access: 'none', description: 'Catalogue page only.' },
            { url: 'https://books.google.com/books?id=x', title: 'Google Books preview', host: 'books.google.com', type: 'preview', license: 'preview_only', format: 'viewer', directFileUrl: '', pagesCovered: 'pp. 4-12', printedPageStart: 4, edition: 'Pupil Book 6A', sameEdition: 'yes', access: 'view_only', description: 'Limited preview.' },
          ],
          tableOfContents: [{ title: 'Unit 1: Place value', startPage: 4, endPage: 11 }, { title: 'Unit 2: Multiplication', startPage: 12, endPage: 23 }],
          pageNumberingNotes: 'Printed page 1 is the first page after the contents.',
          limitations: ['The full pupil book is not freely available; only a view-only preview of pages 4–12 exists.'],
          assessment: 'Only metadata and a view-only preview could be found.',
        },
      },
    ], 'tool_use');
  }

  const fmt = params.output_config?.format;
  if (fmt) {
    const props = fmt.schema?.properties || {};
    const u = units[0] || { key: 'S1', ref: 'p.1', text: 'No text' };
    const quote = u.text.split(/(?<=\.)\s/)[0].slice(0, 120);
    if (props.questions) {
      const count = Number(/exactly (\d+) question/.exec(user)?.[1] || 4);
      const qs = [];
      const templates = [
        { type: 'numeric', topic: 'Long multiplication', difficulty: 'normal', question: 'Calculate **384 × 27**.', options: [], correctOption: null, answer: '10368', acceptableAnswers: ['10,368'], markingGuide: 'Final answer 10,368.', explanation: 'Split 27 into 20 and 7, multiply each part, then add.', optionFeedback: [], commonMistakes: ['Forgetting the zero when multiplying by 20'], hints: ['Split 27 into tens and ones.', 'Work out 384 × 7 first.'], working: [{ step: '384 × 7 = 2,688', explanation: 'Multiply by the ones digit.' }, { step: '384 × 20 = 7,680', explanation: 'Multiply by the tens: 384 × 2 = 768, then × 10.' }, { step: '2,688 + 7,680 = 10,368', explanation: 'Add the two parts.' }], alternativeMethod: 'Use 384 × 27 = 384 × 30 − 384 × 3 = 11,520 − 1,152 = 10,368.' },
        { type: 'mcq', topic: 'Place value', difficulty: 'easy', question: 'In 384, what is the value of the digit 8?', options: ['8', '80', '800', '0.8'], correctOption: 1, answer: '80', acceptableAnswers: [], markingGuide: '', explanation: 'The 8 is in the tens column, so it is worth 80.', optionFeedback: ['8 is the digit itself, not its value.', 'Correct: the 8 is in the tens column.', 'That would be the hundreds column.', 'Decimals are not involved here.'], commonMistakes: [], hints: ['Which column is the 8 in?'], working: [], alternativeMethod: '' },
        { type: 'true_false', topic: 'Equivalent fractions', difficulty: 'easy', question: '1/2 is equivalent to 2/4.', options: ['True', 'False'], correctOption: 0, answer: 'True', acceptableAnswers: [], markingGuide: '', explanation: 'Multiply the numerator and denominator of 1/2 by 2.', optionFeedback: ['Correct.', 'Check by multiplying top and bottom by 2.'], commonMistakes: [], hints: ['Multiply top and bottom by the same number.'], working: [], alternativeMethod: '' },
        { type: 'written', topic: 'Short division', difficulty: 'normal', question: 'Explain how to divide 852 by 4 using short division.', options: [], correctOption: null, answer: 'Divide each digit from the left: 8÷4=2, 5÷4=1 r1, 12÷4=3, so 213.', acceptableAnswers: [], markingGuide: 'Mentions dividing digit by digit, carrying the remainder, and the answer 213.', explanation: 'Short division works from the left, carrying remainders.', optionFeedback: [], commonMistakes: ['Not carrying the remainder'], hints: ['Start with the hundreds digit.'], working: [{ step: '8 ÷ 4 = 2', explanation: 'Hundreds.' }, { step: '5 ÷ 4 = 1 r 1', explanation: 'Tens; carry 1.' }, { step: '12 ÷ 4 = 3', explanation: 'Ones.' }], alternativeMethod: '' },
      ];
      for (let i = 0; i < count; i++) qs.push({ ...templates[i % templates.length], sourceRefs: [{ source: u.key, ref: u.ref }], supportingQuote: quote });
      const json = JSON.stringify({ subject: 'Mathematics', contentType: 'Primary maths textbook', isMaths: true, questions: qs });
      return { m: msg([{ type: 'text', text: json }]), chunks: [] };
    }
    if (props.topics) return { m: msg([{ type: 'text', text: JSON.stringify({ subject: 'Mathematics', contentType: 'Maths book', topics: [{ name: 'Place value', description: 'Digits and columns', refs: [`${u.key} ${u.ref}`] }, { name: 'Long multiplication', description: 'Multi-digit multiplication', refs: [] }] }) }]), chunks: [] };
    if (props.verdict) {
      const ans = /Student's answer[^\n]*\n([\s\S]*)$/.exec(user)?.[1] || '';
      const ok = /213|digit|remainder|carry/i.test(ans);
      return { m: msg([{ type: 'text', text: JSON.stringify({ verdict: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, feedback: ok ? 'Well done, you explained it clearly.' : 'You need to divide each digit in turn and carry any remainder to the next digit. Look again at what happens with the 5.', whatWasRight: ok ? 'Clear method.' : '', whatWentWrong: ok ? '' : 'The remainder was not carried.' }) }]), chunks: [] };
    }
    if (props.pages) return { m: msg([{ type: 'text', text: JSON.stringify({ pages: [{ n: 1, text: 'Scanned page text recovered by OCR.', legible: true, note: '' }] }) }]), chunks: [] };
  }

  // Plain text: tutor or document.
  const cite = (u) => `[${u.key} ${u.ref}]`;
  if (/tutor|teaching me|Tutor/i.test(sys) || params.messages.length > 1 || /patient, expert tutor/.test(sys)) {
    const u = units[0] || { key: 'S1', ref: 'p.1', text: '' };
    const text = `Great question! Here is what your material says ${cite(u)}:\n\n> ${u.text.split('\n')[0].slice(0, 160)}\n\n> **Beyond the source:** A quick extra tip.\n\nCan you tell me what the first step would be?`;
    return { m: msg([{ type: 'text', text }]), chunks: text.match(/.{1,40}/gs) };
  }
  const level = /DETAIL LEVEL (\d)/.exec(user)?.[1] || '3';
  const body = units.slice(0, 8).map((u) => `### ${u.text.split('\n')[0].slice(0, 60)}\n\n- ${u.text.split('\n').slice(1).join(' ').slice(0, 200) || u.text.slice(0, 200)} ${cite(u)}`).join('\n\n');
  const text = `## Overview\n\nThis summary (level ${level}) covers ${units.length} unit(s) of the selected material.\n\n${body}\n\n> **Beyond the source:** Practise each method with your own numbers.\n\n## Key takeaways\n\n- Every point above comes from the cited pages.`;
  return { m: msg([{ type: 'text', text }]), chunks: text.match(/.{1,60}/gs) };
}

export default {
  beta: {
    messages: {
      stream(params) {
        const r = respond(params);
        if (r.m) return makeStream(r.m, r.chunks || []);
        return makeStream(r);
      },
    },
  },
};
