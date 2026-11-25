// In-memory registry for long-running background work (research, extraction, OCR).
// The browser polls /api/jobs/:id for progress. Results are also persisted on the
// related source, so a server restart loses only the live progress log.
import { newId, now } from './store.js';

const jobs = new Map();

export function startJob(type, meta, fn) {
  const job = {
    id: newId('job'),
    type,
    meta,
    status: 'running',
    log: [],
    progress: null,
    result: null,
    error: null,
    startedAt: now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  const ctx = {
    log(message, extra) {
      job.log.push({ at: now(), message, ...(extra || {}) });
      if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    },
    progress(done, total, label) {
      job.progress = { done, total, label };
    },
  };
  Promise.resolve()
    .then(() => fn(ctx))
    .then((result) => {
      job.status = 'done';
      job.result = result ?? null;
    })
    .catch((err) => {
      console.error(`[job ${type}]`, err);
      job.status = 'error';
      job.error = err?.userMessage || err?.message || String(err);
      ctx.log(`Failed: ${job.error}`, { level: 'error' });
    })
    .finally(() => {
      job.finishedAt = now();
      // Keep finished jobs for an hour.
      setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.();
    });
  return job;
}

export const getJob = (id) => jobs.get(id) || null;

export function activeJobFor(sourceId) {
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.meta?.sourceId === sourceId) return job;
  }
  return null;
}
