// Thin client for the server API. No secrets live in the browser.

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError('Cannot reach the Peter Parker Study server. Is it still running?', 0, 'network');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

/**
 * POST and read a server-sent event stream. onEvent receives parsed events.
 * Resolves with the final 'done' event, rejects on 'error'.
 */
export async function stream(url, body, onEvent, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server.', 0, 'network');
  }
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch { /* not json */ }
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'error') throw new ApiError(ev.message, 500, ev.code);
      if (ev.type === 'done') done = ev;
      onEvent?.(ev);
    }
  }
  if (!done) throw new ApiError('The connection closed before the result was finished. Try again.', 0, 'incomplete');
  return done;
}

/** Upload one file with progress (XHR gives upload progress events; fetch does not). */
export function uploadFile(url, file, fields = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') fd.append(k, v);
    fd.append('file', file, file.name);
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status, data.code));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: the server could not be reached.', 0, 'network'));
    xhr.send(fd);
  });
}

/** Poll a background job until it finishes. onUpdate gets each snapshot. */
export async function pollJob(jobId, onUpdate, { interval = 1200 } = {}) {
  for (;;) {
    let job;
    try {
      job = await api.get(`/api/jobs/${jobId}`);
    } catch (err) {
      if (err.status === 404) return { status: 'done' };
      throw err;
    }
    onUpdate?.(job);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, interval));
  }
}
