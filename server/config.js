// Central configuration. Secrets are read from the environment only (never sent to the browser).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Minimal .env loader (no dependency). Existing environment variables win.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = {
  port: int(process.env.PORT, 3000),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  provider: (process.env.AI_PROVIDER || 'anthropic').toLowerCase() === 'openai' ? 'openai' : 'anthropic',
  baseURL: process.env.AI_BASE_URL || '',
  model: process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  apiKey: () => process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  clientOptions: () => (process.env.AI_BASE_URL && (process.env.AI_PROVIDER || 'anthropic') !== 'openai' ? { baseURL: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY } : {}),
  refusalFallback: (process.env.AI_REFUSAL_FALLBACK || 'default').toLowerCase() !== 'off',
  googleBooksKey: process.env.GOOGLE_BOOKS_API_KEY || '',
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 150) * 1024 * 1024,
  singlePassMaxChars: int(process.env.SINGLE_PASS_MAX_CHARS, 300000),
  chunkChars: int(process.env.CHUNK_CHARS, 120000),
  // Retrieval limits for server-side downloads of research sources.
  maxDownloadBytes: int(process.env.MAX_DOWNLOAD_MB, 60) * 1024 * 1024,
  fetchTimeoutMs: int(process.env.FETCH_TIMEOUT_MS, 30000),
};

export function aiConfigured() {
  // The SDK also resolves ANTHROPIC_AUTH_TOKEN; accept either.
  return Boolean(process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

fs.mkdirSync(config.dataDir, { recursive: true });
