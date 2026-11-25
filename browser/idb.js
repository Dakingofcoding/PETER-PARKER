// Minimal IndexedDB key-value store.
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('peter-parker-study', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
export async function getAll() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = new Map();
    const req = d.transaction('kv').objectStore('kv').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.set(c.key, c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
export async function putMany(entries, deletes) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    for (const [k, v] of entries) st.put(v, k);
    for (const k of deletes) st.delete(k);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
