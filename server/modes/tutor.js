// Study mode (interactive tutor) and "Ask a question about this" (grounded Q&A).
// Small selections are given to the tutor in full (prompt-cached); large ones
// are searched each turn so the most relevant pages are always in view.
import { config } from '../config.js';
import { streamText, cachedSystem } from '../ai.js';
import { CORE_RULES } from '../prompts.js';
import { materialText, inventory, renderGroups } from '../material.js';

const STOP = new Set('the a an and or of to in on for is are was were be by with as at that this it its from which what how why when who whom can could should would do does did not no yes into than then there their they them these those has have had about'.split(' '));
const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) || [];

/** Simple BM25 over material blocks; returns groups within a character budget. */
export function retrieve(material, query, budget) {
  const docs = [];
  for (const entry of material.sources) for (const b of entry.blocks) docs.push({ entry, b, toks: tokens(`${b.title || ''} ${b.text}`) });
  const N = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.toks.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(tokens(query))];
  const scored = docs.map((d) => {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.toks.length / avg))));
    }
    return { ...d, s };
  });
  scored.sort((a, b) => b.s - a.s);
  const chosen = [];
  let used = 0;
  for (const d of scored) {
    if (used + d.b.text.length > budget) continue;
    chosen.push(d);
    used += d.b.text.length;
    if (used > budget * 0.95) break;
  }
  const groups = [];
  for (const entry of material.sources) {
    const blocks = chosen.filter((c) => c.entry === entry).map((c) => c.b).sort((a, b) => a.n - b.n);
    if (blocks.length) groups.push({ entry, blocks });
  }
  return groups;
}

export const TUTOR_LEVELS = {
  beginner: 'Explain at a beginner level: simple words, very small steps, lots of concrete examples, check understanding often.',
  intermediate: 'Explain at an intermediate level: clear explanations with examples, moderate pace.',
  advanced: 'Explain at an advanced level: concise, precise, emphasise connections, edge cases and deeper reasoning.',
};

const STUDY_RULES = `You are an excellent, patient personal tutor teaching the student the selected material.
How you teach:
- Teach one idea at a time. Break difficult ideas into small parts. Use examples from the material first; extra examples go in "Beyond the source" blockquotes.
- After explaining something, ask ONE short question to check understanding, then wait for the student's reply.
- When the student answers: say clearly whether they are right. If wrong or partly wrong, explain the mistake kindly and precisely like a teacher, re-explain in a different way, then ask a similar question.
- When the student asks a question, answer it from the material with citations. If the material does not contain the answer, say "That isn't covered in your selected material" and, if helpful, give a brief general answer in a "Beyond the source" blockquote.
- For maths, always show complete step-by-step working with the method that suits the question, explaining each step in plain words.
- If the student is confused, try a different explanation (analogy, diagram described in words, smaller steps).
- Keep replies focused (usually under 350 words) unless the student asks for more.`;

const QA_RULES = `You answer the student's questions about the selected material.
- Answer from the material with citations. Quote briefly when it helps.
- If the material does not contain the answer, say plainly: "I couldn't find this in the selected material." You may then add a short general explanation in a "Beyond the source" blockquote, clearly separated.
- If sources disagree, show both views with citations.
- For maths, show step-by-step working.`;

export const QUICK_ACTIONS = {
  explain_differently: 'I don’t get it yet. Please explain that again in a completely different way.',
  example: 'Can you give me another example of this, worked step by step?',
  simpler: 'Please make that simpler and break it into smaller steps.',
  deeper: 'Can you go deeper on this and show how it connects to the other topics?',
  check_me: 'Ask me a question to check whether I understood this.',
  next_topic: 'I understand. Let’s move on to the next topic.',
  summary_so_far: 'Summarise what we have covered so far as short notes.',
};

export function buildTutorSystem(chat, material, latestUserText) {
  const rules = chat.kind === 'qa' ? QA_RULES : STUDY_RULES;
  const levelLine = TUTOR_LEVELS[chat.level] || TUTOR_LEVELS.intermediate;
  const focus = chat.focus ? `\nThe student wants to focus on: ${chat.focus}` : '';
  const doc = chat.contextDoc ? `\n\nThe student is asking about this generated document (based on the same material):\n<document>\n${chat.contextDoc.slice(0, 60000)}\n</document>` : '';
  const full = material.totalChars <= config.singlePassMaxChars * 1.5;
  if (full) {
    return { system: cachedSystem(`${CORE_RULES}\n\n${rules}\n${levelLine}${focus}\n\nSources:\n${inventory(material)}\n\n<material>\n${materialText(material)}\n</material>${doc}`), retrieval: false };
  }
  const history = chat.messages.slice(-4).map((m) => m.content).join(' ');
  const groups = retrieve(material, `${latestUserText} ${chat.focus || ''} ${history}`, Math.floor(config.singlePassMaxChars * 0.8));
  return {
    system: `${CORE_RULES}\n\n${rules}\n${levelLine}${focus}\n\nSources:\n${inventory(material)}\n\nThe selection is large, so only the units most relevant to this turn are shown below. If something seems missing, say which pages you would need rather than guessing.\n\n<material>\n${renderGroups(groups)}\n</material>${doc}`,
    retrieval: true,
  };
}

export async function tutorReply({ chat, material, userText, emit }) {
  const { system, retrieval } = buildTutorSystem(chat, material, userText);
  if (retrieval) emit({ type: 'stage', text: 'Looking up the most relevant pages…' });
  const messages = chat.messages.map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: chat.kind === 'qa' ? 'I have some questions about this material.' : 'Please start teaching me this material.' });
  }
  return streamText({
    system,
    messages,
    maxTokens: 8000,
    effort: 'medium',
    onText: (t) => emit({ type: 'delta', text: t }),
  });
}

export function openingMessage(chat) {
  if (chat.kind === 'qa') return null;
  return `Please start teaching me this material${chat.focus ? `, focusing on: ${chat.focus}` : ''}. First give me a short map of the topics we'll cover (as a numbered list with citations), then begin teaching the first topic and finish with one question to check my understanding.`;
}
