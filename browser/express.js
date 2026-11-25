// Minimal in-page Express stand-in: lets server/index.js handle /api requests
// inside the browser and answer with real Response objects (including SSE streams).
const routes = [];
const middleware = [];
const errorHandlers = [];

function compile(p) {
  if (p instanceof RegExp) return (path) => (p.test(path) ? {} : null);
  const names = [];
  const re = new RegExp(`^${p.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
  return (path) => {
    const m = re.exec(path);
    if (!m) return null;
    return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
  };
}

const app = {
  disable() {},
  listen() {},
  use(a, ...rest) {
    if (typeof a === 'function') (a.length === 4 ? errorHandlers : middleware).push(a);
    // path-mounted static handlers are not needed in the browser
  },
};
for (const m of ['get', 'post', 'patch', 'delete']) {
  app[m] = (path, ...handlers) => routes.push({ method: m.toUpperCase(), match: compile(path), handlers });
}

export default function express() {
  return app;
}
express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();

export async function dispatch(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const req = { method, path: url.pathname, url: url.pathname + url.search, params: {}, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers), body: {} };
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) req.body = await request.json().catch(() => ({}));
  else if (ct.includes('multipart/form-data')) req._form = await request.formData();

  return new Promise((resolve) => {
    let status = 200;
    const headers = new Headers();
    let controller = null;
    const closeHandlers = [];
    const enc = new TextEncoder();
    const res = {
      headersSent: false,
      status(c) {
        status = c;
        return res;
      },
      setHeader(k, v) {
        headers.set(k, v);
      },
      json(obj) {
        headers.set('content-type', 'application/json');
        res.send(JSON.stringify(obj));
      },
      send(body) {
        if (res.headersSent) return;
        res.headersSent = true;
        resolve(new Response(body, { status, headers }));
      },
      sendFile() {
        res.status(404).send('Not found');
      },
      writeHead(s, h = {}) {
        status = s;
        for (const [k, v] of Object.entries(h)) headers.set(k, v);
        res.headersSent = true;
        const stream = new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel() {
            closeHandlers.forEach((f) => f());
          },
        });
        resolve(new Response(stream, { status, headers }));
      },
      write(chunk) {
        try {
          controller?.enqueue(enc.encode(chunk));
        } catch { /* stream closed */ }
      },
      end(body) {
        if (!res.headersSent) return res.send(body ?? '');
        try {
          controller?.close();
        } catch { /* already closed */ }
        closeHandlers.forEach((f) => f());
      },
      on(ev, f) {
        if (ev === 'close') closeHandlers.push(f);
      },
    };

    const route = routes.find((r) => r.method === method && (req.params = r.match(req.path)));
    const chain = [...middleware, ...(route ? route.handlers : [(rq, rs) => rs.status(404).json({ error: 'Not found' })])];
    let i = 0;
    const fail = (err) => {
      const h = errorHandlers[0];
      if (h) h(err, req, res, () => {});
      else res.status(500).json({ error: err?.message || 'Error' });
    };
    const next = (err) => {
      if (err) return fail(err);
      const fn = chain[i++];
      if (!fn) return;
      try {
        const r = fn(req, res, next);
        if (r && typeof r.catch === 'function') r.catch(fail);
      } catch (e) {
        fail(e);
      }
    };
    next();
  });
}
