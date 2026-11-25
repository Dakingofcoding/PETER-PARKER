// OpenAI-compatible provider (e.g. Radox AI, OpenRouter, OpenAI itself).
// Speaks /chat/completions with raw fetch so it works both on the server and in the browser.
import { config } from './config.js';

export class CompatError extends Error {
  constructor(message, status) {
    super(message);
    this.userMessage = message;
    this.status = status;
  }
}

const sysText = (system) => (!system ? '' : typeof system === 'string' ? system : system.map((b) => b.text || '').join('\n'));

function convertContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const b of content) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    else if (b.type === 'image' && b.source?.type === 'url') parts.push({ type: 'image_url', image_url: { url: b.source.url } });
    else if (b.type === 'document') throw new CompatError('This AI provider cannot read PDF pages directly, so scanned PDF pages cannot be OCR’d. Upload photos (PNG/JPG) of those pages instead, or use an Anthropic key.', 400);
    else if (b.type === 'tool_result') parts.push({ type: 'text', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
  }
  return parts;
}

function toMessages(system, messages) {
  const out = [];
  const s = sysText(system);
  if (s) out.push({ role: 'system', content: s });
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: sysText(m.content) });
    else out.push({ role: m.role, content: convertContent(m.content) });
  }
  return out;
}

async function post(body, signal) {
  const base = (config.baseURL || '').replace(/\/+$/, '');
  if (!base) throw new CompatError('Set the provider’s base URL in Settings.', 400);
  if (!config.model) throw new CompatError('Set the model name in Settings (copy it from your provider’s model list).', 400);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey()}` },
      body: JSON.stringify({ model: config.model, ...body }),
      signal,
    });
  } catch {
    throw new CompatError(`Could not reach ${base}. Check the base URL and your internet connection${globalThis.PPS_LOCAL ? ', or the provider may not allow use from a web page' : ''}.`, 502);
  }
  if (!res.ok) {
    let msg = '';
    try {
      const j = await res.json();
      msg = j.error?.message || j.message || JSON.stringify(j);
    } catch { /* not json */ }
    const hint = res.status === 401 || res.status === 403 ? 'The API key was rejected. Check it in Settings.' : res.status === 429 ? 'Rate limit or quota reached. Wait a minute or check your plan.' : `The AI provider returned an error (${res.status}).`;
    throw new CompatError(`${hint}${msg ? ` ${msg.slice(0, 300)}` : ''}`, res.status);
  }
  return res;
}

const MAX_OUT = (n) => Math.min(n, 32000);

export async function compatStreamText({ system, messages, maxTokens = 16000, onText, signal }) {
  const res = await post({ messages: toMessages(system, messages), max_tokens: MAX_OUT(maxTokens), stream: true }, signal);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          text += d;
          onText?.(d);
        }
        finish = j.choices?.[0]?.finish_reason || finish;
      } catch { /* keep-alive or partial */ }
    }
  }
  return { text, truncated: finish === 'length', usage: null };
}

function extractJSON(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
}

export async function compatGenerateJSON({ system, messages, schema, jsonSchema, maxTokens = 16000, signal }) {
  const msgs = toMessages(system, messages);
  let lastErr;
  const attempts = [
    { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: jsonSchema } } },
    { response_format: { type: 'json_object' }, extra: true },
    { extra: true },
  ];
  for (const a of attempts) {
    const m = a.extra ? [...msgs, { role: 'user', content: `Reply with ONLY a JSON object (no prose, no code fences) that matches this JSON Schema exactly:\n${JSON.stringify(jsonSchema)}` }] : msgs;
    try {
      const res = await post({ messages: m, max_tokens: MAX_OUT(maxTokens), ...(a.response_format ? { response_format: a.response_format } : {}) }, signal);
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content;
      const parsed = schema.safeParse(extractJSON(typeof content === 'string' ? content : (content || []).map((p) => p.text || '').join('')));
      if (parsed.success) return parsed.data;
      lastErr = new CompatError('The AI response did not have the expected structure. Try again or choose a stronger model.', 502);
    } catch (err) {
      if (err instanceof CompatError && (err.status === 401 || err.status === 403 || err.status === 429 || err.status === 502)) throw err;
      lastErr = err instanceof CompatError ? err : new CompatError('The AI response was not valid JSON. Try again or choose a stronger model.', 502);
    }
  }
  throw lastErr;
}

export function compatWebAgentUnavailable() {
  throw new CompatError('Web research needs an Anthropic (Claude) key, because it uses Claude’s built-in web search. With this provider, books are looked up in free catalogues only; upload your pages to study them.', 400);
}
