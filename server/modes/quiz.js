// Universal quiz engine: subject detection, question generation from the
// selected material, deterministic + AI marking, hints, worked solutions and
// teacher-style explanations when the student goes wrong.
import { z } from 'zod';
import { config } from '../config.js';
import { generateJSON, streamText, cachedSystem } from '../ai.js';
import { CORE_RULES } from '../prompts.js';
import { materialText, inventory, chunkMaterial, renderGroups } from '../material.js';
import { mapLimit } from './generate.js';

// ------------------------------------------------------------------ schemas

const QuestionSchema = z.object({
  type: z.enum(['mcq', 'true_false', 'written', 'numeric']),
  topic: z.string(),
  difficulty: z.enum(['easy', 'normal', 'hard']),
  question: z.string().describe('The question text in Markdown. Self-contained: include any numbers, passage excerpt or context the student needs.'),
  options: z.array(z.string()).describe('mcq: exactly 4 options. true_false: ["True","False"]. Otherwise [].'),
  correctOption: z.number().int().nullable().describe('0-based index of the correct option for mcq/true_false; null otherwise'),
  answer: z.string().describe('The model answer. numeric: just the value with units if needed.'),
  acceptableAnswers: z.array(z.string()).describe('Other correct ways of writing the answer (equivalent forms, synonyms, spellings)'),
  markingGuide: z.string().describe('Key points a written answer must contain to be fully correct; what earns partial credit'),
  explanation: z.string().describe('Teacher-style explanation of why the answer is correct, in Markdown'),
  optionFeedback: z.array(z.string()).describe('mcq/true_false: one entry per option. For the correct option, explain why it is right. For each wrong option, explain like a teacher the misconception behind choosing it and how to think about it instead, WITHOUT naming the correct option (the student may try again). Otherwise [].'),
  commonMistakes: z.array(z.string()).describe('Typical wrong answers/misconceptions for this question and why they are wrong'),
  hints: z.array(z.string()).describe('2-3 progressive hints that guide without giving the answer away'),
  working: z.array(z.object({ step: z.string(), explanation: z.string() })).describe('For maths/calculations/processes: the complete worked solution, one step per entry, using the method suited to the question. [] if not applicable.'),
  alternativeMethod: z.string().describe('Another valid method in Markdown (maths especially). Empty if none.'),
  sourceRefs: z.array(z.object({ source: z.string(), ref: z.string() })).describe('Units the question is based on, e.g. {source:"S1", ref:"p.12"}'),
  supportingQuote: z.string().describe('A short verbatim quote (max ~200 chars) copied exactly from the cited unit that supports the answer. Empty only for pure calculation practice derived from a method in the material.'),
});

const QuizSchema = z.object({
  subject: z.string().describe('Detected subject, e.g. Mathematics, Biology, History, English Literature'),
  contentType: z.string().describe('Short description of the material, e.g. "Year 6 maths textbook: long multiplication and division"'),
  isMaths: z.boolean(),
  questions: z.array(QuestionSchema),
});

const TopicsSchema = z.object({
  subject: z.string(),
  contentType: z.string(),
  topics: z.array(z.object({ name: z.string(), description: z.string(), refs: z.array(z.string()) })),
});

const MarkSchema = z.object({
  verdict: z.enum(['correct', 'partially_correct', 'incorrect']),
  score: z.number().describe('0, 0.5 or 1'),
  feedback: z.string().describe('Speak directly to the student like a kind, expert teacher. Markdown.'),
  whatWasRight: z.string(),
  whatWentWrong: z.string().describe('The specific error or misconception. Empty if fully correct.'),
});

// ------------------------------------------------------------------ prompts

const SUBJECT_GUIDE = `Adapt question styles to the subject you detect (do not ask the student which subject it is):
- Mathematics: calculations, word problems, concepts, rules, formulas, multi-step problems. Every calculation question needs complete step-by-step working using the method suited to it (column multiplication, partitioning, long/short division, equivalent fractions, decimal place value, percentages of amounts, solving equations, angle facts, area/perimeter formulas, unit conversions, ratio tables…). Never force one format on every question. Compute every answer twice and make sure the numbers are right.
- Science: concepts, processes, definitions, cause and effect, "explain why", applications, interpreting results.
- History: events, dates, people, causes, consequences, chronology, significance, interpreting sources.
- English / language: grammar, vocabulary, comprehension of passages from the material, sentence construction, punctuation, language techniques.
- Geography: locations, physical processes, human geography, environmental issues, case studies.
- Literature: characters, plot, themes, events, quotations, interpretation, comprehension.
- Anything else: adapt intelligently to what the material teaches.`;

const DIFFICULTY_GUIDE = {
  easy: 'EASY: basic understanding and recall of key facts, definitions and single-step methods.',
  normal: 'NORMAL: understanding and application — use the idea in a new example, explain, apply a method.',
  hard: 'HARD: deeper understanding — multi-step reasoning, combining concepts, explaining connections, unfamiliar applications.',
  mixed: 'MIXED: roughly one third easy, one third normal, one third hard.',
};

const TYPE_GUIDE = {
  mcq: 'All questions multiple choice (4 options, one correct, plausible distractors based on real misconceptions).',
  true_false: 'All questions true/false (statements that are clearly true or clearly false from the material; avoid trick wording).',
  written: 'All questions require a written answer (short answer or explanation). For maths, use "numeric" for questions with a single numerical answer.',
  mixed: 'A mix of multiple choice, true/false, written and (for maths) numeric questions.',
};

function quizPrompt({ count, difficulty, types, topics, focus, priorQuestions }) {
  return `Create a quiz of exactly ${count} question(s) from the material.
${DIFFICULTY_GUIDE[difficulty] || DIFFICULTY_GUIDE.normal}
Make difficulty come from the thinking required, never from confusing or tricky wording.
${TYPE_GUIDE[types] || TYPE_GUIDE.mixed}
${topics?.length ? `Only use these topics: ${topics.join('; ')}.` : 'Cover the whole selected material, spreading questions across its topics.'}
${focus ? `Student's request: ${focus}` : ''}
${priorQuestions?.length ? `Avoid repeating these earlier questions:\n${priorQuestions.map((q) => `- ${q}`).join('\n')}` : ''}

${SUBJECT_GUIDE}

Rules for every question:
- It must be answerable from the material (cite the unit(s) in sourceRefs). Do not test pages that are missing.
- supportingQuote must be copied character-for-character from the cited unit.
- Hints guide the student toward the method without stating the answer.
- explanation and optionFeedback should teach: explain the reasoning and the misconception behind each wrong option, as a good teacher would.
- For calculation questions, the "working" steps must be complete and arithmetically correct, each with a plain-language explanation a student understands.`;
}

// ------------------------------------------------------------------ generation

export async function analyseTopics(material) {
  const groupsList = material.totalChars <= config.singlePassMaxChars ? [null] : chunkMaterial(material, config.chunkChars);
  const parts = await mapLimit(groupsList, 3, async (chunk) => {
    const text = chunk ? renderGroups(chunk.groups) : materialText(material);
    return generateJSON({
      system: `${CORE_RULES}\n\n<material>\n${text}\n</material>`,
      messages: [{ role: 'user', content: 'Detect the subject and list the distinct topics this material teaches (3–15 topics, in teaching order), each with a one-line description and the refs where it appears (e.g. "S1 p.12").' }],
      schema: TopicsSchema,
      maxTokens: 6000,
      effort: 'low',
    });
  });
  const topics = [];
  for (const p of parts) for (const t of p.topics) if (!topics.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) topics.push(t);
  return { subject: parts[0]?.subject || '', contentType: parts[0]?.contentType || '', topics: topics.slice(0, 30) };
}

export async function generateQuiz({ material, settings, emit, priorQuestions }) {
  const count = Math.max(1, Math.min(Number(settings.count) || 10, 40));
  const base = { difficulty: settings.difficulty, types: settings.types, topics: settings.topics, focus: settings.focus, priorQuestions };
  let result;
  if (material.totalChars <= config.singlePassMaxChars) {
    emit?.({ type: 'stage', text: `Reading the material and writing ${count} question(s)…` });
    result = await generateJSON({
      system: cachedSystem(`${CORE_RULES}\n\n<material>\n${materialText(material)}\n</material>`),
      messages: [{ role: 'user', content: `Sources:\n${inventory(material)}\n\n${quizPrompt({ ...base, count })}` }],
      schema: QuizSchema,
      maxTokens: Math.min(6000 + count * 2200, 100000),
      effort: 'high',
    });
  } else {
    const chunks = chunkMaterial(material, config.chunkChars);
    emit?.({ type: 'stage', text: `Large selection: writing questions from ${chunks.length} parts…` });
    const totalChars = chunks.reduce((s, c) => s + c.chars, 0);
    let allocated = 0;
    const shares = chunks.map((c, i) => {
      const n = i === chunks.length - 1 ? count - allocated : Math.max(0, Math.round((c.chars / totalChars) * count));
      allocated += n;
      return n;
    });
    const parts = await mapLimit(chunks, 3, async (chunk, i) => {
      if (!shares[i]) return null;
      return generateJSON({
        system: `${CORE_RULES}\n\n<material>\n${renderGroups(chunk.groups)}\n</material>`,
        messages: [{ role: 'user', content: quizPrompt({ ...base, count: shares[i] }) }],
        schema: QuizSchema,
        maxTokens: Math.min(6000 + shares[i] * 2200, 100000),
        effort: 'high',
      });
    });
    const valid = parts.filter(Boolean);
    result = { subject: valid[0]?.subject || '', contentType: valid[0]?.contentType || '', isMaths: valid.some((p) => p.isMaths), questions: valid.flatMap((p) => p.questions) };
  }
  result.questions = result.questions.map((q) => normaliseQuestion(q, material));
  return result;
}

const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9%.,/×÷+=-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Check the supporting quote against the cited unit text. */
export function verifyQuote(q, material) {
  const quote = normText(q.supportingQuote);
  if (!quote || quote.length < 8) return 'none';
  for (const r of q.sourceRefs) {
    const entry = material.sources.find((e) => e.key === r.source);
    const block = entry?.blocks.find((b) => b.ref.toLowerCase() === String(r.ref).toLowerCase().trim());
    if (block && normText(block.text).includes(quote)) return 'verified';
  }
  for (const e of material.sources) for (const b of e.blocks) if (normText(b.text).includes(quote)) return 'found_elsewhere';
  return 'unverified';
}

function normaliseQuestion(q, material) {
  const out = { ...q };
  if (out.type === 'true_false') {
    out.options = ['True', 'False'];
    if (out.correctOption === null || out.correctOption > 1) out.correctOption = /^t/i.test(out.answer) ? 0 : 1;
  }
  if (out.type === 'mcq') {
    if (!Array.isArray(out.options) || out.options.length < 2) out.type = 'written';
    else if (out.correctOption === null || out.correctOption >= out.options.length) {
      const idx = out.options.findIndex((o) => normText(o) === normText(out.answer));
      out.correctOption = idx >= 0 ? idx : 0;
    }
  }
  out.quoteStatus = verifyQuote(out, material);
  return out;
}

// ------------------------------------------------------------------ marking

function parseNumber(s) {
  const t = String(s || '').replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, '').replace(/[£$€¥]/g, '');
  const frac = /^(-?\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const mixed = /^(-?\d+)(?:and|\+)?(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const pct = /^(-?\d*\.?\d+)%$/.exec(t);
  if (pct) return Number(pct[1]) / 100;
  const m = /^(-?\d*\.?\d+)([a-zµ°²³]*)$/i.exec(t);
  return m ? Number(m[1]) : null;
}

const strip = (s) => normText(s).replace(/[.,!?]+$/g, '').replace(/^(the|a|an) /, '');

/** Deterministic check. Returns { verdict } or null when a judgement is needed. */
export function quickMark(q, response) {
  if (q.type === 'mcq' || q.type === 'true_false') {
    const idx = Number(response);
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) return { verdict: 'invalid' };
    return { verdict: idx === q.correctOption ? 'correct' : 'incorrect', chosen: idx };
  }
  const answers = [q.answer, ...(q.acceptableAnswers || [])];
  const r = strip(response);
  if (!r) return { verdict: 'incorrect', empty: true };
  if (answers.some((a) => strip(a) === r)) return { verdict: 'correct' };
  const rn = parseNumber(response);
  const an = answers.map(parseNumber).filter((x) => x !== null);
  if (rn !== null && an.length) {
    if (an.some((a) => Math.abs(a - rn) <= Math.max(1e-9, Math.abs(a) * 1e-9))) return { verdict: 'correct' };
    if (q.type === 'numeric') return { verdict: 'incorrect', needsFeedback: true };
  }
  return null; // needs AI judgement
}

export async function markWithAI({ q, response, reveal, attempt }) {
  return generateJSON({
    system: `You mark a student's answer like an expert, encouraging teacher.
Marking principles:
- Judge meaning, not wording. Accept any answer that expresses the same idea as the model answer or marking guide, even if phrased differently, shorter, or with minor spelling mistakes that do not change the meaning.
- Maths: accept equivalent forms (½ = 0.5 = 50% where appropriate, 10368 = 10,368), and correct answers without units unless units are what is being tested. A wrong final value is incorrect even if the method is partly right (then say which steps were right).
- Partially correct (score 0.5) when some but not all required points are present.
- When the answer is wrong, pinpoint the exact mistake or misconception and explain it the way a teacher would at the student's level.
${reveal ? '- You may state the correct answer and show how to reach it.' : '- DO NOT state or give away the correct answer: the student will try again. Explain what is wrong in their thinking and nudge them toward the right method.'}`,
    messages: [
      {
        role: 'user',
        content: `Question (${q.type}, ${q.difficulty}, topic: ${q.topic}):\n${q.question}\n\nModel answer: ${q.answer}\nOther acceptable answers: ${(q.acceptableAnswers || []).join(' | ') || 'none'}\nMarking guide: ${q.markingGuide}\nCommon mistakes: ${(q.commonMistakes || []).join(' | ') || 'none listed'}\n${q.working?.length ? `Worked solution:\n${q.working.map((w, i) => `${i + 1}. ${w.step} — ${w.explanation}`).join('\n')}\n` : ''}Supporting text from the material: ${q.supportingQuote || '(none)'}\n\nStudent's answer (attempt ${attempt}):\n${response}`,
      },
    ],
    schema: MarkSchema,
    maxTokens: 4000,
    effort: 'medium',
  });
}

/** Stream a teacher-style explanation (explain step, another method, deeper help). */
export async function streamExplanation({ q, kind, step, response, emit, material }) {
  const context = `Question:\n${q.question}\n\nCorrect answer: ${q.answer}\nExplanation: ${q.explanation}\n${q.working?.length ? `Worked solution:\n${q.working.map((w, i) => `Step ${i + 1}: ${w.step} — ${w.explanation}`).join('\n')}` : ''}\nSource: ${q.sourceRefs.map((r) => `${r.source} ${r.ref}`).join(', ')}\nSupporting quote: ${q.supportingQuote}`;
  const asks = {
    step: `Explain step ${Number(step) + 1} ("${q.working?.[step]?.step || ''}") in more detail and in simpler language. Show exactly what happens to the numbers and why this step is needed. Use a tiny example if it helps.`,
    another_method: 'Show a different valid method for solving this question, step by step, and say when this method is useful. Keep the final answer the same.',
    teacher: `The student answered: "${response ?? ''}". Explain, like a patient teacher, where their thinking went wrong, why the correct answer is right, and give one quick similar example they can try themselves (with its answer at the end).`,
    hint_more: 'Give one more hint that is more specific than a normal hint but still does not reveal the final answer.',
  };
  const relevant = material
    ? q.sourceRefs
        .map((r) => material.sources.find((e) => e.key === r.source)?.blocks.find((b) => b.ref.toLowerCase() === String(r.ref).toLowerCase()))
        .filter(Boolean)
        .map((b) => `<unit ref="${b.ref}">\n${b.text.slice(0, 6000)}\n</unit>`)
        .join('\n')
    : '';
  return streamText({
    system: `You are a patient, expert tutor. Explain clearly and step by step at the student's level, in Markdown. Base explanations on the material shown; mark extra background with a blockquote starting "**Beyond the source:**". Write maths with Unicode symbols, not LaTeX.${relevant ? `\n\n<material>\n${relevant}\n</material>` : ''}`,
    messages: [{ role: 'user', content: `${context}\n\n${asks[kind] || asks.teacher}` }],
    maxTokens: 6000,
    effort: 'medium',
    onText: (t) => emit({ type: 'delta', text: t }),
  });
}

// ------------------------------------------------------------------ client view

/** Strip answers from questions that the student has not finished. */
export function publicQuiz(quiz) {
  const questions = quiz.questions.map((q, i) => {
    const state = quiz.answers[i] || {};
    const done = state.final === true;
    const learning = quiz.settings.mode === 'learning';
    const base = {
      index: i,
      type: q.type,
      topic: q.topic,
      difficulty: q.difficulty,
      question: q.question,
      options: q.options,
      sourceRefs: q.sourceRefs,
      hintCount: q.hints?.length || 0,
      hasWorking: Boolean(q.working?.length),
      hasAlternative: Boolean(q.alternativeMethod),
      hintsShown: (q.hints || []).slice(0, state.hintsUsed || 0),
      state: {
        attempts: state.attempts || 0,
        final: done,
        verdict: state.verdict || null,
        score: state.score ?? null,
        response: state.response ?? null,
        feedback: state.feedback || null,
        revealed: Boolean(state.revealed),
      },
      origin: q.origin || 'ai',
    };
    if (done || state.revealed) {
      Object.assign(base, {
        correctOption: q.correctOption,
        answer: q.answer,
        explanation: q.explanation,
        optionFeedback: q.optionFeedback,
        commonMistakes: q.commonMistakes,
        working: q.working,
        alternativeMethod: q.alternativeMethod,
        supportingQuote: q.supportingQuote,
        quoteStatus: q.quoteStatus,
      });
    } else if (learning && state.workingShown) {
      base.working = q.working;
    }
    return base;
  });
  return {
    id: quiz.id,
    workspaceId: quiz.workspaceId,
    title: quiz.title,
    settings: quiz.settings,
    subject: quiz.subject,
    contentType: quiz.contentType,
    isMaths: quiz.isMaths,
    offline: Boolean(quiz.offline),
    status: quiz.status,
    createdAt: quiz.createdAt,
    materialMeta: quiz.materialMeta,
    results: quiz.status === 'finished' ? quiz.results : null,
    questions,
  };
}

export function computeResults(quiz) {
  const perTopic = new Map();
  let score = 0;
  const items = quiz.questions.map((q, i) => {
    const a = quiz.answers[i] || {};
    const s = a.final ? a.score ?? 0 : 0;
    score += s;
    const t = perTopic.get(q.topic) || { topic: q.topic, total: 0, score: 0 };
    t.total++;
    t.score += s;
    perTopic.set(q.topic, t);
    return { index: i, topic: q.topic, verdict: a.final ? a.verdict : 'unanswered', score: s, hintsUsed: a.hintsUsed || 0, revealed: Boolean(a.revealed) };
  });
  const topics = [...perTopic.values()].map((t) => ({ ...t, percent: Math.round((t.score / t.total) * 100) }));
  const weakTopics = topics.filter((t) => t.percent < 70).sort((a, b) => a.percent - b.percent);
  return {
    score,
    total: quiz.questions.length,
    percent: Math.round((score / Math.max(1, quiz.questions.length)) * 100),
    correct: items.filter((x) => x.verdict === 'correct').length,
    partial: items.filter((x) => x.verdict === 'partially_correct').length,
    incorrect: items.filter((x) => x.verdict === 'incorrect').length,
    unanswered: items.filter((x) => x.verdict === 'unanswered').length,
    items,
    topics,
    weakTopics,
  };
}
