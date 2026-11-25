// Browser replacement for server/config.js: settings live in localStorage.
const read = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
export const ROOT = '/';
export const config = {
  port: 0,
  dataDir: '/data',
  get provider() {
    return read('pps-provider', 'anthropic') === 'openai' ? 'openai' : 'anthropic';
  },
  get baseURL() {
    return read('pps-base-url', '');
  },
  get model() {
    return read('pps-model', '') || (this.provider === 'openai' ? '' : 'claude-opus-5-5');
  },
  apiKey: () => read('pps-api-key', ''),
  refusalFallback: true,
  googleBooksKey: '',
  maxUploadBytes: 150 * 1024 * 1024,
  singlePassMaxChars: 300000,
  chunkChars: 120000,
  maxDownloadBytes: 60 * 1024 * 1024,
  fetchTimeoutMs: 30000,
  browserMode: true,
  clientOptions: () => ({ apiKey: read('pps-api-key', ''), dangerouslyAllowBrowser: true, ...(read('pps-base-url', '') ? { baseURL: read('pps-base-url', '') } : {}) }),
};
export function aiConfigured() {
  return Boolean(read('pps-api-key', ''));
}
