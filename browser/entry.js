// Single-file build entry: runs the whole app (server logic included) inside the page.
import './globals.js';
import { initStore, flush } from './store.js';
import { dispatch } from './express.js';

await initStore();
await import('../server/index.js');
const { resetClient, setClientForTests } = await import('../server/ai.js');

if (typeof __PPS_TEST__ !== 'undefined' && __PPS_TEST__) {
  const fake = await import('../tests/e2e/fake-ai.js');
  setClientForTests(fake.default);
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (typeof url === 'string' && url.startsWith('/api/')) {
    if (url === '/api/local/settings') {
      const body = JSON.parse(init.body || '{}');
      try {
        if (body.apiKey === '') localStorage.removeItem('pps-api-key');
        else if (body.apiKey && body.apiKey !== '__keep__') localStorage.setItem('pps-api-key', body.apiKey);
        if (typeof body.model === 'string') localStorage.setItem('pps-model', body.model);
      } catch {
        return new Response(JSON.stringify({ error: 'This browser blocks local storage, so the key cannot be saved.' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      resetClient();
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }
    const res = await dispatch(new Request(`http://local${url}`, init));
    if (init.method && init.method !== 'GET') setTimeout(flush, 400);
    return res;
  }
  return realFetch(input, init);
};

await import('../public/js/app.js');
