'use strict';

function abortError() {
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  return error;
}

// Shared work has its own signal: one caller cancelling must not cancel others.
class AsyncCache {
  constructor({ ttlMs, maxEntries = 500, now = Date.now, cacheIf = () => true }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.cacheIf = cacheIf;
    this.values = new Map();
    this.pending = new Map();
  }

  get(key, loader, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || abortError());
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    this.values.delete(key);

    let job = this.pending.get(key);
    if (!job) {
      if (this.pending.size >= this.maxEntries) {
        return Promise.reject(new Error('Too many pending lookups'));
      }
      job = { controller: new AbortController(), waiters: 0, done: false };
      this.pending.set(key, job);
      job.promise = Promise.resolve().then(() => loader(job.controller.signal)).then(
        (value) => {
          job.done = true;
          if (!job.controller.signal.aborted && this.cacheIf(value)) {
            while (this.values.size >= this.maxEntries) {
              this.values.delete(this.values.keys().next().value);
            }
            this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });
          }
          if (this.pending.get(key) === job) this.pending.delete(key);
          return value;
        },
        (error) => {
          job.done = true;
          if (this.pending.get(key) === job) this.pending.delete(key);
          throw error;
        },
      );
    }

    return new Promise((resolve, reject) => {
      job.waiters++;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        job.waiters--;
        if (!job.done && job.waiters === 0) {
          if (this.pending.get(key) === job) this.pending.delete(key);
          job.controller.abort(abortError());
        }
        callback(value);
      };
      const cancel = () => finish(reject, signal.reason || abortError());
      job.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}

module.exports = { AsyncCache };
