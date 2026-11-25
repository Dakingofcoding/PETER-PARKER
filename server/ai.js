// Claude integration. All calls run server-side; the API key never reaches the browser.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config, aiConfigured } from './config.js';

export class UserFacingError extends Error {
  constructor(userMessage, { status = 500, code = 'error', cause } = {}) {
    super(userMessage);
    this.userMessage = userMessage;
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class AINotConfiguredError extends UserFacingError {
  constructor() {
    super(
      'AI features are not connected. Add ANTHROPIC_API_KEY to the .env file on the server and restart it (see Settings for setup steps).',
      { status: 503, code: 'ai_not_configured' },
    );
  }
}

let client = null;
let injectedClient = null; // used only by the automated test-suite

export function setClientForTests(fake) {
  injectedClient = fake;
}
export function aiAvailable() {
  return Boolean(injectedClient) || aiConfigured();
}

function getClient() {
  if (injectedClient) return injectedClient;
  if (!aiConfigured()) throw new AINotConfiguredError();
  if (!client) client = new Anthropic({ maxRetries: 3 });
  return client;
}

// Params shared by every request. Server-side refusal fallback is opt-in and
// enabled by default (AI_REFUSAL_FALLBACK=off disables it).
function baseParams() {
  const p = { model: config.model };
  if (config.refusalFallback) {
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

export function translateError(err) {
  if (err instanceof UserFacingError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new UserFacingError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env and restart the server.', { status: 502, code: 'ai_auth', cause: err });
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new UserFacingError('The API key does not have permission for this model or feature.', { status: 502, code: 'ai_permission', cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new UserFacingError('The AI service is rate-limiting requests right now. Wait a minute and try again.', { status: 429, code: 'ai_rate_limit', cause: err });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new UserFacingError(`The AI request was rejected: ${err.message}`, { status: 502, code: 'ai_bad_request', cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new UserFacingError('Could not reach the Anthropic API. Check the server\'s internet connection.', { status: 502, code: 'ai_connection', cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new UserFacingError(`The AI service returned an error (${err.status ?? 'unknown'}). Try again shortly.`, { status: 502, code: 'ai_api', cause: err });
  }
  if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) {
    return new UserFacingError('The request was cancelled.', { status: 499, code: 'aborted', cause: err });
  }
  return new UserFacingError(err?.message || 'Unexpected error', { status: 500, cause: err });
}

function checkStop(msg) {
  if (msg.stop_reason === 'refusal') {
    const why = msg.stop_details?.explanation ? ` (${msg.stop_details.explanation})` : '';
    throw new UserFacingError(`The AI declined to process this request${why}. Try a different selection of material.`, { status: 422, code: 'ai_refusal' });
  }
}

export function textOf(msg) {
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// System prompt as a cacheable block (long material goes here so follow-up
// turns in tutoring / Q&A reuse the cached prefix).
export const cachedSystem = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];

/**
 * Stream plain text (Markdown). onText receives deltas as they arrive.
 * Returns the final text (authoritative; replaces streamed deltas).
 */
export async function streamText({ system, messages, maxTokens = 64000, effort = 'medium', onText, signal }) {
  const c = getClient();
  try {
    const stream = c.beta.messages.stream(
      { ...baseParams(), max_tokens: maxTokens, system, messages, output_config: { effort } },
      signal ? { signal } : undefined,
    );
    if (onText) stream.on('text', (t) => onText(t));
    const msg = await stream.finalMessage();
    checkStop(msg);
    return { text: textOf(msg), truncated: msg.stop_reason === 'max_tokens', usage: msg.usage };
  } catch (err) {
    throw translateError(err);
  }
}

/**
 * Structured JSON output validated against a Zod schema.
 */
export async function generateJSON({ system, messages, schema, maxTokens = 32000, effort = 'medium', signal }) {
  const c = getClient();
  const fmt = zodOutputFormat(schema);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = c.beta.messages.stream(
        {
          ...baseParams(),
          max_tokens: maxTokens * (attempt + 1),
          system,
          messages,
          output_config: { effort, format: { type: 'json_schema', schema: fmt.schema } },
        },
        signal ? { signal } : undefined,
      );
      const msg = await stream.finalMessage();
      checkStop(msg);
      if (msg.stop_reason === 'max_tokens') {
        lastErr = new UserFacingError('The AI response was cut off because it was too long. Try fewer questions or a smaller selection.', { status: 502, code: 'ai_truncated' });
        continue;
      }
      return fmt.parse(textOf(msg));
    } catch (err) {
      if (err instanceof Anthropic.APIError || err instanceof UserFacingError) throw translateError(err);
      // JSON / validation failure: retry once.
      lastErr = err;
    }
  }
  throw translateError(lastErr);
}

/**
 * Agentic research loop with Anthropic's server-side web_search / web_fetch tools.
 * The model finishes by calling a client tool (submitName) whose input is the
 * structured result; we validate it with the Zod schema.
 */
export async function runWebAgent({
  system,
  prompt,
  submitName,
  submitDescription,
  schema,
  searchUses = 8,
  fetchUses = 8,
  effort = 'high',
  maxTurns = 8,
  onEvent,
  signal,
}) {
  const c = getClient();
  const fmt = zodOutputFormat(schema);
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: searchUses },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: fetchUses, max_content_tokens: 60000 },
    { name: submitName, description: submitDescription, input_schema: fmt.schema, eager_input_streaming: true },
  ];
  const messages = [{ role: 'user', content: prompt }];
  let maxTokens = 32000;
  let reissues = 0;
  let nudges = 0;
  const visited = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    let msg;
    try {
      const stream = c.beta.messages.stream(
        { ...baseParams(), max_tokens: maxTokens, system, messages, tools, output_config: { effort } },
        signal ? { signal } : undefined,
      );
      stream.on('contentBlock', (block) => {
        if (block.type === 'server_tool_use') {
          if (block.name === 'web_search' && block.input?.query) onEvent?.({ kind: 'search', text: block.input.query });
          if (block.name === 'web_fetch' && block.input?.url) onEvent?.({ kind: 'fetch', text: block.input.url });
        } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.url) visited.push({ url: r.url, title: r.title || '' });
          onEvent?.({ kind: 'results', text: `${block.content.length} results` });
        } else if (block.type === 'web_fetch_tool_result') {
          const ok = block.content && block.content.type !== 'web_fetch_tool_result_error' && !block.content.error_code;
          onEvent?.({ kind: ok ? 'fetched' : 'fetch_failed', text: block.content?.url || '' });
        }
      });
      msg = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw translateError(err);
      // Unparseable streamed tool input or dropped connection: re-issue the same turn.
      if (reissues++ < 2) {
        onEvent?.({ kind: 'note', text: 'Retrying an interrupted research step…' });
        continue;
      }
      throw translateError(err);
    }
    checkStop(msg);

    const submit = msg.content.find((b) => b.type === 'tool_use' && b.name === submitName);
    if (msg.stop_reason === 'max_tokens' && submit) {
      maxTokens = Math.min(maxTokens * 2, 128000);
      continue; // retry the same turn with more room; nothing appended
    }
    messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'pause_turn') continue; // server resumes its tool loop

    if (submit) {
      const parsed = schema.safeParse(submit.input);
      if (parsed.success) return { result: parsed.data, visited };
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: submit.id,
            is_error: true,
            content: JSON.stringify({
              INVALID_INPUT: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
            }),
          },
        ],
      });
      continue;
    }

    // Any other client tool_use would be unexpected; answer it so the transcript stays valid.
    const stray = msg.content.filter((b) => b.type === 'tool_use');
    if (stray.length) {
      messages.push({
        role: 'user',
        content: stray.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `Unknown tool. Call ${submitName} to submit.` })),
      });
      continue;
    }

    if (nudges++ >= 2) break;
    messages.push({ role: 'user', content: `Please call the ${submitName} tool now with your findings, following its schema exactly. Report only what you verified.` });
  }
  throw new UserFacingError('The research step did not return a usable result. Try again, or upload the material yourself.', { status: 502, code: 'research_incomplete' });
}

/**
 * OCR with Claude's vision: transcribe scanned PDF pages or images verbatim.
 * `content` is a document or image block. Returns [{ n, text, legible }].
 */
export async function transcribeVisual({ block, count, unitName = 'page' }) {
  const { z } = await import('zod');
  const schema = z.object({
    pages: z.array(
      z.object({
        n: z.number().int().describe(`1-based ${unitName} position inside the supplied file`),
        text: z.string().describe('Verbatim transcription. Empty string if unreadable.'),
        legible: z.boolean(),
        note: z.string().describe('Short note on anything unreadable (figures, cut-off text). Empty if none.'),
      }),
    ),
  });
  const result = await generateJSON({
    system:
      'You are an OCR engine. Transcribe text exactly as printed: keep headings, numbered questions, tables (as Markdown tables), and mathematical notation. Describe diagrams briefly in [square brackets]. Never invent, complete, or correct text you cannot read; mark it [illegible].',
    messages: [
      {
        role: 'user',
        content: [
          block,
          { type: 'text', text: `Transcribe all ${count} ${unitName}(s) in this file. Return one entry per ${unitName}, in order.` },
        ],
      },
    ],
    schema,
    maxTokens: Math.min(8000 + count * 3000, 64000),
    effort: 'low',
  });
  return result.pages;
}
