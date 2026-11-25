// Summaries, combined study guides, source comparisons and revision guides.
// Small selections are processed in one pass; large ones go through a
// hierarchical map → reduce pipeline so nothing is truncated.
import { config } from '../config.js';
import { streamText, cachedSystem } from '../ai.js';
import { CORE_RULES, MODE_TASKS, MODE_LABELS, levelOf } from '../prompts.js';
import { materialText, inventory, chunkMaterial, renderGroups } from '../material.js';

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const NOTE_TOKENS = { 1: 24000, 2: 16000, 3: 10000, 4: 6000, 5: 4000 };

async function chunkNotes({ chunks, total, mode, lvl, emit, signal }) {
  let done = 0;
  return mapLimit(chunks, 3, async (chunk) => {
    const system = `${CORE_RULES}\n\n<material>\n${renderGroups(chunk.groups)}\n</material>`;
    const user = `This is part ${chunk.index} of ${total} of a larger selection (${chunk.label}). The whole selection is too long to read at once, so you are writing intermediate study notes for this part only.
Write detailed notes that preserve every important concept, definition, fact, rule, method, formula, worked example, exception, date and name in this part, organised under topic headings, with citations exactly as specified. These notes will later be merged with the notes from the other parts into a final ${MODE_LABELS[mode]} at "${lvl.name}" level, so keep everything such a document could need. Do not add an introduction or conclusion.`;
    const { text } = await streamText({ system, messages: [{ role: 'user', content: user }], maxTokens: NOTE_TOKENS[lvl.key], effort: lvl.key <= 2 ? 'high' : 'medium', signal });
    done++;
    emit({ type: 'stage', text: `Processed part ${done} of ${total} (${chunk.label})` });
    return { label: chunk.label, index: chunk.index, text };
  });
}

/**
 * Generate a Markdown document for a mode. emit() receives
 * { type: 'stage' | 'delta', text } events.
 */
export async function generateDocument({ mode, level, material, emit, signal, extraInstruction }) {
  const lvl = levelOf(level);
  const task = MODE_TASKS[mode](lvl);
  const inv = inventory(material);
  const extra = extraInstruction ? `\n\nStudent's extra request: ${extraInstruction}` : '';

  if (material.totalChars <= config.singlePassMaxChars) {
    emit({ type: 'stage', text: `Reading ${material.totalBlocks} unit(s) and writing (${lvl.name})…` });
    const system = cachedSystem(`${CORE_RULES}\n\n<material>\n${materialText(material)}\n</material>`);
    const user = `${task}\n\nSources in this material:\n${inv}${extra}\n\nWrite the ${MODE_LABELS[mode].toLowerCase()} now. Start directly with the content (no preamble about yourself).`;
    const { text, truncated } = await streamText({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: lvl.maxTokens,
      effort: lvl.effort,
      onText: (t) => emit({ type: 'delta', text: t }),
      signal,
    });
    return { text, truncated, pipeline: { strategy: 'single-pass', chunks: 1 } };
  }

  // ---- Hierarchical pipeline ----
  const chunks = chunkMaterial(material, config.chunkChars);
  emit({ type: 'stage', text: `Large selection (${Math.round(material.totalChars / 1000)}k characters): processing in ${chunks.length} parts so nothing is skipped…` });
  let notes = await chunkNotes({ chunks, total: chunks.length, mode, lvl, emit, signal });

  // Second-level reduction if the combined notes are still too long.
  let level2 = 0;
  while (notes.reduce((s, n) => s + n.text.length, 0) > config.singlePassMaxChars && notes.length > 1) {
    level2++;
    emit({ type: 'stage', text: `Condensing notes (round ${level2})…` });
    const groups = [];
    let cur = [];
    let size = 0;
    for (const n of notes) {
      if (size + n.text.length > config.chunkChars && cur.length) {
        groups.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(n);
      size += n.text.length;
    }
    if (cur.length) groups.push(cur);
    notes = await mapLimit(groups, 3, async (g, i) => {
      const { text } = await streamText({
        system: CORE_RULES,
        messages: [
          {
            role: 'user',
            content: `Merge these study notes into one set of notes. Keep every important point and every citation exactly as written; remove only true repetition.\n\n${g.map((n) => `<notes covers="${n.label}">\n${n.text}\n</notes>`).join('\n\n')}`,
          },
        ],
        maxTokens: NOTE_TOKENS[lvl.key] * 2,
        effort: 'medium',
        signal,
      });
      return { label: g.map((n) => n.label).join(' + '), index: i + 1, text };
    });
  }

  emit({ type: 'stage', text: 'Combining all parts into the final document…' });
  const system = cachedSystem(`${CORE_RULES}

The selection was too large to read in one pass, so it was processed in parts. Below are faithful study notes from each part, with citations to the original units. Treat these notes as the material: use only them, keep their citations, and remove repetition across parts.

${inv}

${notes.map((n) => `<notes part="${n.index}" covers="${n.label}">\n${n.text}\n</notes>`).join('\n\n')}`);
  const user = `${task}${extra}\n\nWrite the ${MODE_LABELS[mode].toLowerCase()} now. Start directly with the content.`;
  const { text, truncated } = await streamText({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: lvl.maxTokens,
    effort: lvl.effort,
    onText: (t) => emit({ type: 'delta', text: t }),
    signal,
  });
  return { text, truncated, pipeline: { strategy: 'hierarchical', chunks: chunks.length, reductionRounds: level2 + 1 } };
}
