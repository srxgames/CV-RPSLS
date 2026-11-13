// Storage layer for the game. Two interchangeable backends share one small API:
//
//   uid                       current player's id
//   mode                      'firebase' or 'local'
//   read(path)                -> value | null
//   watch(path, cb)           -> unsubscribe()   (cb gets the value, null when empty)
//   set(path, value)
//   update(path, obj)         merges keys into the node in one atomic write
//   transact(path, fn)        -> { committed, value }; fn(current) returns the new
//                                value, or undefined to abort
//
// Firebase is used once js/firebase-config.js holds real project settings.
// Until then a localStorage backend lets several tabs of one browser play
// together, which is handy for trying the game out.

import { firebaseConfig, isConfigured } from './firebase-config.js';

export async function createBackend() {
  return isConfigured() ? firebaseBackend() : localBackend();
}

// ---- Firebase Realtime Database -----------------------------------------

async function firebaseBackend() {
  const v = '10.12.2';
  const base = `https://www.gstatic.com/firebasejs/${v}`;
  const [appMod, authMod, db] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-database.js`),
  ]);

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  await auth.authStateReady();
  if (!auth.currentUser) await authMod.signInAnonymously(auth);
  const database = db.getDatabase(app);

  return {
    mode: 'firebase',
    uid: auth.currentUser.uid,
    async read(path) {
      const snap = await db.get(db.ref(database, path));
      return snap.val();
    },
    watch(path, cb) {
      return db.onValue(db.ref(database, path), (snap) => cb(snap.val()));
    },
    async set(path, value) {
      await db.set(db.ref(database, path), value);
    },
    async update(path, obj) {
      await db.update(db.ref(database, path), obj);
    },
    async transact(path, fn) {
      const result = await db.runTransaction(db.ref(database, path), (current) => fn(current));
      return { committed: result.committed, value: result.snapshot.val() };
    },
  };
}

// ---- Local demo (localStorage, synced across tabs) ----------------------

function localBackend() {
  const KEY = 'rpsls-local-db';
  const watchers = new Set();

  let uid = sessionStorage.getItem('rpsls-local-uid');
  if (!uid) {
    uid = `local-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem('rpsls-local-uid', uid);
  }

  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  const save = (tree) => localStorage.setItem(KEY, JSON.stringify(tree));
  const parts = (path) => path.split('/').filter(Boolean);

  const getAt = (tree, path) => {
    let node = tree;
    for (const key of parts(path)) {
      if (node == null || typeof node !== 'object') return null;
      node = node[key];
    }
    return node === undefined ? null : node;
  };

  const setAt = (tree, path, value) => {
    const keys = parts(path);
    let node = tree;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
      node = node[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = value;
  };

  const clone = (v) => (v === null ? null : JSON.parse(JSON.stringify(v)));

  const notify = () => {
    const tree = load();
    watchers.forEach((w) => w.cb(clone(getAt(tree, w.path))));
  };

  // Every write is a read-modify-write of one localStorage key. The Web Locks
  // API makes those writes take turns across tabs so none are lost.
  const withLock = (fn) => (
    navigator.locks ? navigator.locks.request('rpsls-local-db', fn) : Promise.resolve().then(fn)
  );

  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });

  return {
    mode: 'local',
    uid,
    async read(path) {
      return clone(getAt(load(), path));
    },
    watch(path, cb) {
      const w = { path, cb };
      watchers.add(w);
      queueMicrotask(() => { if (watchers.has(w)) cb(clone(getAt(load(), path))); });
      return () => watchers.delete(w);
    },
    async set(path, value) {
      await withLock(() => {
        const tree = load();
        setAt(tree, path, clone(value));
        save(tree);
      });
      notify();
    },
    async update(path, obj) {
      await withLock(() => {
        const tree = load();
        Object.entries(obj).forEach(([k, v]) => setAt(tree, `${path}/${k}`, clone(v)));
        save(tree);
      });
      notify();
    },
    async transact(path, fn) {
      const result = await withLock(() => {
        const tree = load();
        const current = clone(getAt(tree, path));
        const next = fn(current);
        if (next === undefined) return { committed: false, value: current };
        setAt(tree, path, clone(next));
        save(tree);
        return { committed: true, value: clone(next) };
      });
      if (result.committed) notify();
      return result;
    },
  };
}
