// Non-AI fallbacks used when no API key is configured. They are clearly
// labelled as extractive: every sentence shown is copied from the material.
import { UNIT_NAMES } from '../selection.js';

const STOP = new Set(
  'the a an and or but of to in on for is are was were be been being by with as at that this these those it its from which what how why when who whom can could should would will shall may might must do does did not no yes into than then there their they them he she his her you your we our us i me my has have had about also more most such any each other some all one two three if so up out over under very just only own same both few many much'.split(' '),
);

const sentences = (text) =>
  String(text || '')
    .replace(/\n+/g, ' \n ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && s.length < 400 && /[a-z]/i.test(s));

const words = (s) => (s.toLowerCase().match(/[a-z][a-z'-]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));

function termStats(material) {
  const df = new Map();
  let docs = 0;
  for (const e of material.sources)
    for (const b of e.blocks) {
      docs++;
      for (const w of new Set(words(b.text))) df.set(w, (df.get(w) || 0) + 1);
    }
  return { df, docs: Math.max(docs, 1) };
}

function keyTerms(text, stats, n = 12) {
  const tf = new Map();
  for (const w of words(text)) tf.set(w, (tf.get(w) || 0) + 1);
  return [...tf.entries()]
    .map(([w, f]) => [w, f * Math.log(1 + stats.docs / (stats.df.get(w) || 1))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function rankSentences(blocks, stats) {
  const all = [];
  for (const b of blocks) {
    const terms = new Set(keyTerms(b.text, stats, 25));
    sentences(b.text).forEach((s, pos) => {
      const ws = words(s);
      if (!ws.length) return;
      const score = ws.filter((w) => terms.has(w)).length / Math.sqrt(ws.length) + (pos === 0 ? 0.4 : 0) + (/\b(is|are|means|called|defined|known as)\b/i.test(s) ? 0.5 : 0);
      all.push({ s, b, score, pos });
    });
  }
  return all;
}

const RATIO = { 1: 0.4, 2: 0.25, 3: 0.15, 4: 0.09, 5: 0.05 };

const NOTICE = (what) => `> **Offline ${what} — no AI connected.** Every sentence below is copied from your selected material and ranked by importance. It does not explain, connect or check anything. Add an \`ANTHROPIC_API_KEY\` on the server (see Settings) for real AI summaries, tutoring and marking.\n\n`;

export function offlineSummary(material, level, mode) {
  const stats = termStats(material);
  const ratio = RATIO[level] || 0.15;
  let md = NOTICE(mode === 'revision' ? 'revision notes' : mode === 'compare' ? 'comparison' : 'extractive summary');
  if (mode === 'compare' || mode === 'combined') {
    const termSets = material.sources.map((e) => new Set(keyTerms(e.blocks.map((b) => b.text).join('\n'), stats, 40)));
    const shared = [...(termSets[0] || [])].filter((t) => termSets.slice(1).every((s) => s.has(t)));
    md += `## Key terms in common\n${shared.length ? shared.map((t) => `\`${t}\``).join(' · ') : '_No strongly shared key terms found._'}\n\n`;
    material.sources.forEach((e, i) => {
      const unique = [...termSets[i]].filter((t) => termSets.every((s, j) => j === i || !s.has(t))).slice(0, 15);
      md += `## ${e.key}: ${e.title}\n**Terms mostly found only here:** ${unique.map((t) => `\`${t}\``).join(' · ') || '—'}\n\n`;
    });
  }
  for (const e of material.sources) {
    md += `## ${e.key}: ${e.title}\n_${e.selectionText}${e.gaps.length ? ` — ${e.gaps.join('; ')}` : ''}_\n\n`;
    // group by unit title if present (chapters/sections), else by every 5 units
    const groups = [];
    for (const b of e.blocks) {
      const g = groups[groups.length - 1];
      if (b.title && (!g || g.title !== b.title)) groups.push({ title: b.title, blocks: [b] });
      else if (g && g.blocks.length < 5) g.blocks.push(b);
      else groups.push({ title: null, blocks: [b] });
    }
    for (const g of groups) {
      const ranked = rankSentences(g.blocks, stats);
      const keep = Math.max(1, Math.round(ranked.length * ratio));
      const chosen = [...ranked].sort((a, b) => b.score - a.score).slice(0, keep).sort((a, b) => a.b.n - b.b.n || a.pos - b.pos);
      const range = g.blocks.length > 1 ? `${g.blocks[0].ref}–${g.blocks[g.blocks.length - 1].ref}` : g.blocks[0].ref;
      md += `### ${g.title || range}\n`;
      if (mode === 'revision') {
        const defs = chosen.filter((c) => /\b(is|are|means|called|defined as|known as)\b/i.test(c.s));
        const formulas = g.blocks.flatMap((b) => b.text.split('\n').filter((l) => /[=×÷]/.test(l) && /\d|[a-z]\s*=/.test(l) && l.length < 120)).slice(0, 6);
        const dates = g.blocks.flatMap((b) => sentences(b.text).filter((s) => /\b(1[0-9]{3}|20[0-9]{2})\b/.test(s))).slice(0, 5);
        if (defs.length) md += `**Definitions**\n${defs.map((c) => `- ${c.s} [${e.key} ${c.b.ref}]`).join('\n')}\n\n`;
        if (formulas.length) md += `**Formulas / rules**\n${formulas.map((f) => `- \`${f.trim()}\``).join('\n')}\n\n`;
        if (dates.length) md += `**Dates**\n${dates.map((s) => `- ${s}`).join('\n')}\n\n`;
        md += `**Key terms:** ${keyTerms(g.blocks.map((b) => b.text).join(' '), stats, 8).join(', ')}\n\n`;
      } else {
        md += `${chosen.map((c) => `- ${c.s} [${e.key} ${c.b.ref}]`).join('\n')}\n\n`;
      }
    }
  }
  return md;
}

/** Cloze, multiple-choice and true/false questions built from key sentences. */
export function offlineQuiz(material, settings) {
  const stats = termStats(material);
  const count = Math.max(1, Math.min(Number(settings.count) || 10, 40));
  const pool = [];
  for (const e of material.sources) {
    const ranked = rankSentences(e.blocks, stats).sort((a, b) => b.score - a.score);
    for (const r of ranked.slice(0, count * 4)) pool.push({ ...r, e });
  }
  const allTerms = [...new Set(material.sources.flatMap((e) => keyTerms(e.blocks.map((b) => b.text).join(' '), stats, 60)))];
  const questions = [];
  const used = new Set();
  const wantType = settings.types || 'mixed';
  let i = 0;
  for (const p of pool) {
    if (questions.length >= count) break;
    const candidates = keyTerms(p.s, stats, 6).filter((t) => t.length > 4 && new RegExp(`\\b${t}\\b`, 'i').test(p.s));
    const term = candidates.find((t) => !used.has(t));
    if (!term) continue;
    used.add(term);
    const blanked = p.s.replace(new RegExp(`\\b${term}\\b`, 'i'), '_____');
    const type = wantType === 'mixed' ? ['mcq', 'written', 'true_false'][i++ % 3] : wantType === 'written' ? 'written' : wantType;
    const refs = [{ source: p.e.key, ref: p.b.ref }];
    const base = { topic: p.b.title || `${p.e.title}`, difficulty: 'easy', acceptableAnswers: [], markingGuide: `The missing word is "${term}".`, commonMistakes: [], hints: [`It appears in ${p.e.key} ${p.b.ref}.`, `The word starts with "${term[0]}" and has ${term.length} letters.`], working: [], alternativeMethod: '', sourceRefs: refs, supportingQuote: p.s, quoteStatus: 'verified', origin: 'offline' };
    if (type === 'true_false') {
      const swap = allTerms.find((t) => t !== term && t.length > 4 && !p.s.toLowerCase().includes(t));
      const isTrue = !swap || questions.length % 2 === 0;
      const statement = isTrue ? p.s : p.s.replace(new RegExp(`\\b${term}\\b`, 'i'), swap);
      questions.push({ ...base, type: 'true_false', question: `True or false?\n\n> ${statement}`, options: ['True', 'False'], correctOption: isTrue ? 0 : 1, answer: isTrue ? 'True' : 'False', explanation: `The material says: “${p.s}”`, optionFeedback: isTrue ? ['Correct: this is what the material says.', 'This statement matches the material word for word.'] : [`The material actually uses "${term}", not "${swap}".`, `Right: the material says "${term}", not "${swap}".`] });
    } else if (type === 'mcq') {
      const distractors = allTerms.filter((t) => t !== term && t.length > 3).sort(() => Math.random() - 0.5).slice(0, 3);
      if (distractors.length < 3) continue;
      const options = [...distractors, term].sort(() => Math.random() - 0.5);
      questions.push({ ...base, type: 'mcq', question: `Which word completes the sentence?\n\n> ${blanked}`, options, correctOption: options.indexOf(term), answer: term, explanation: `The material says: “${p.s}”`, optionFeedback: options.map((o) => (o === term ? 'Correct — this is the word used in the material.' : `"${o}" appears elsewhere in the material but not in this sentence.`)) });
    } else {
      questions.push({ ...base, type: 'written', question: `Fill in the missing word:\n\n> ${blanked}`, options: [], correctOption: null, answer: term, explanation: `The material says: “${p.s}”`, optionFeedback: [] });
    }
  }
  return { subject: 'Unknown (offline mode cannot detect the subject)', contentType: 'Fill-in-the-blank practice from key sentences', isMaths: false, questions };
}
