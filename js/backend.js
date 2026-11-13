// Storage layer for the game. Two interchangeable backends share one small API:
//
//   uid                       current player's id
//   mode                      'p2p' or 'firebase'
//   read(path)                -> value | null
//   watch(path, cb)           -> unsubscribe()   (cb gets the value, null when empty)
//   set(path, value)
//   update(path, obj)         merges keys into the node in one atomic write
//   transact(path, fn)        -> { committed, value }; fn(current) returns the new
//                                value, or undefined to abort
//
// Peer-to-peer backends also have:
//   openRoom(code, 'host' | 'auto')   connect to (or start) a room before using it
//   closeRoom()
//   role, onStatus
//
// Default: peer-to-peer. No account or database is needed. The player who
// creates a room acts as the host: their browser keeps the game state and the
// other players connect to it over WebRTC (PeerJS's free broker only introduces
// the browsers to each other).
//
// Optional: fill in js/firebase-config.js and the page uses Firebase instead.

import { firebaseConfig, isConfigured } from './firebase-config.js';
import { isMove } from './rules.js';

export async function createBackend() {
  return isConfigured() ? firebaseBackend() : p2pBackend();
}

// ---- Firebase Realtime Database (optional) --------------------------------

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

// ---- Peer-to-peer (host-authoritative, over WebRTC) -----------------------

const PEER_SRC = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PEER_PREFIX = 'rpsls-';
const REQUEST_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 12000;

const clone = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
const parts = (path) => path.split('/').filter(Boolean);

function getAt(tree, path) {
  let node = tree;
  for (const key of parts(path)) {
    if (node == null || typeof node !== 'object') return null;
    node = node[key];
  }
  return node === undefined ? null : node;
}

function setAt(tree, path, value) {
  const keys = parts(path);
  let node = tree;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === null || value === undefined) delete node[last];
  else node[last] = value;
}

function loadPeerLib() {
  const found = () => window.Peer || (window.peerjs && window.peerjs.Peer);
  if (found()) return Promise.resolve(found());
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PEER_SRC;
    script.onload = () => (found() ? resolve(found()) : reject(new Error('Could not start the networking library.')));
    script.onerror = () => reject(new Error('Could not load the networking library. Check your internet connection.'));
    document.head.appendChild(script);
  });
}

function p2pBackend() {
  let uid = sessionStorage.getItem('rpsls-uid');
  if (!uid) {
    uid = `p-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
    sessionStorage.setItem('rpsls-uid', uid);
  }

  let role = null;          // 'host' | 'guest'
  let code = null;
  let peer = null;
  let closed = true;
  let nextId = 1;

  // Host side: the authoritative game state and everyone connected to it.
  let tree = {};
  const hostWatchers = new Set();   // { path, cb } for the host's own page
  const guests = new Map();         // connection -> { uid, watches: Map(wid -> { path, last }) }

  // Guest side: the connection to the host.
  let conn = null;
  const pending = new Map();        // request id -> { resolve, reject, timer }
  const guestWatches = new Map();   // wid -> { path, cb }

  const api = { mode: 'p2p', uid, onStatus: null };
  const status = (s) => { if (api.onStatus) api.onStatus(s); };
  const savedKey = (c) => `rpsls-host:${c}`;

  // -- Host: rules about who may change what (the equivalent of database rules)

  function authorize(who, path, value, kind) {
    const p = parts(path);
    if (p[0] !== 'rooms' || p[1] !== code) return 'Wrong room.';
    const rest = p.slice(2);
    const room = tree.rooms && tree.rooms[code];

    if (rest.length === 0) {
      const valid = value && value.hostUid === who && Number(value.round) === 1
        && [2, 3, 4].includes(Number(value.targetPlayers));
      return who === uid && !room && valid ? null : 'Not allowed.';
    }
    if (!room) return 'Room not found.';
    const seated = Object.values(room.seats || {}).includes(who);
    const [area, a, b, field] = rest;

    if (area === 'seats' && rest.length === 2) {
      const ok = /^s[0-3]$/.test(a) && value === who && !seated
        && !(room.seats && room.seats[a]) && Number(a[1]) < Number(room.targetPlayers);
      return ok ? null : 'That seat is taken.';
    }
    if (area === 'players' && rest.length === 2) {
      const ok = a === who && seated && value && typeof value.name === 'string'
        && value.name.length >= 1 && value.name.length <= 16 && Object.keys(value).length === 1;
      return ok ? null : 'Not allowed.';
    }
    if (area === 'round' && rest.length === 1) {
      return kind === 'cas' && seated && value === Number(room.round) + 1 ? null : 'Not allowed.';
    }
    if (area === 'rounds' && rest.length === 4 && /^r\d+$/.test(a) && b === who && seated) {
      const mine = (room.rounds && room.rounds[a] && room.rounds[a][b]) || {};
      if (field === 'commit') {
        return typeof value === 'string' && value.length === 64 && !mine.commit ? null : 'Not allowed.';
      }
      if (field === 'move') {
        return isMove(value) && mine.commit && !mine.move ? null : 'Not allowed.';
      }
      if (field === 'salt') {
        return typeof value === 'string' && value.length <= 64 && !mine.salt ? null : 'Not allowed.';
      }
    }
    return 'Not allowed.';
  }

  function persist() {
    if (role !== 'host') return;
    try {
      localStorage.setItem(savedKey(code), JSON.stringify({ hostUid: uid, tree }));
    } catch { /* storage full or blocked: the game still works */ }
  }

  function pushToGuest(c, info, wid) {
    const w = info.watches.get(wid);
    if (!w) return;
    const value = clone(getAt(tree, w.path));
    const text = JSON.stringify(value);
    if (text === w.last) return;
    w.last = text;
    c.send({ t: 'val', wid, value });
  }

  function notifyAll() {
    hostWatchers.forEach((w) => w.cb(clone(getAt(tree, w.path))));
    guests.forEach((info, c) => info.watches.forEach((_, wid) => pushToGuest(c, info, wid)));
  }

  function commit(path, value) {
    setAt(tree, path, clone(value));
    persist();
    notifyAll();
  }

  /** Run one request against the host's state on behalf of `who`. */
  function execute(who, req) {
    const fail = (error) => ({ ok: false, error });
    if (typeof req.path !== 'string') return fail('Bad request.');
    const p = parts(req.path);
    if (p[0] !== 'rooms' || p[1] !== code) return fail('Wrong room.');

    if (req.op === 'read') return { ok: true, value: clone(getAt(tree, req.path)) };

    if (req.op === 'set') {
      const err = authorize(who, req.path, req.value, 'set');
      if (err) return fail(err);
      commit(req.path, req.value);
      return { ok: true };
    }
    if (req.op === 'update' && req.obj && typeof req.obj === 'object') {
      const entries = Object.entries(req.obj);
      for (const [k, v] of entries) {
        const err = authorize(who, `${req.path}/${k}`, v, 'set');
        if (err) return fail(err);
      }
      entries.forEach(([k, v]) => setAt(tree, `${req.path}/${k}`, clone(v)));
      persist();
      notifyAll();
      return { ok: true };
    }
    if (req.op === 'cas') {
      const current = clone(getAt(tree, req.path));
      if (JSON.stringify(current) !== JSON.stringify(req.expected === undefined ? null : req.expected)) {
        return { ok: true, committed: false, value: current };
      }
      const err = authorize(who, req.path, req.value, 'cas');
      if (err) return { ok: true, committed: false, value: current, error: err };
      commit(req.path, req.value);
      return { ok: true, committed: true };
    }
    return fail('Bad request.');
  }

  function onGuestMessage(c, info, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') { info.uid = String(msg.uid).slice(0, 64); return; }
    if (!info.uid) return;
    if (msg.t === 'watch' && typeof msg.path === 'string') {
      info.watches.set(msg.wid, { path: msg.path, last: undefined });
      pushToGuest(c, info, msg.wid);
    } else if (msg.t === 'unwatch') {
      info.watches.delete(msg.wid);
    } else if (msg.t === 'req') {
      let result;
      try { result = execute(info.uid, msg); } catch { result = { ok: false, error: 'Bad request.' }; }
      c.send({ t: 'res', id: msg.id, ...result });
    }
  }

  async function startHost(c, restore) {
    const Peer = await loadPeerLib();
    const saved = restore ? readSaved(c) : null;
    code = c;
    tree = saved ? saved.tree : {};
    const p = new Peer(`${PEER_PREFIX}${c}`);
    let opened = false;
    await new Promise((resolve, reject) => {
      p.on('open', () => { opened = true; resolve(); });
      p.on('error', (err) => {
        if (opened) return; // later errors are handled per connection
        try { p.destroy(); } catch { /* already destroyed */ }
        if (err.type === 'unavailable-id') reject(Object.assign(new Error('Room code in use.'), { code: 'taken' }));
        else reject(err);
      });
    });
    peer = p;
    role = 'host';
    p.on('connection', (c2) => {
      const info = { uid: null, watches: new Map() };
      guests.set(c2, info);
      c2.on('data', (msg) => onGuestMessage(c2, info, msg));
      c2.on('close', () => guests.delete(c2));
      c2.on('error', () => guests.delete(c2));
    });
    p.on('disconnected', () => { if (!closed && !p.destroyed) p.reconnect(); });
    persist();
  }

  function readSaved(c) {
    try {
      const saved = JSON.parse(localStorage.getItem(savedKey(c)));
      return saved && saved.hostUid === uid && saved.tree ? saved : null;
    } catch { return null; }
  }

  function connectToHost() {
    return new Promise((resolve, reject) => {
      const c = peer.connect(`${PEER_PREFIX}${code}`, { reliable: true });
      let settled = false;
      const onPeerError = (err) => {
        if (err.type === 'peer-unavailable') {
          fail(new Error(`Room ${code} was not found. Check the code, and make sure the host still has the page open.`));
        }
      };
      const done = () => { settled = true; clearTimeout(timer); peer.off('error', onPeerError); };
      const fail = (err) => {
        if (settled) return;
        done();
        try { c.close(); } catch { /* already closed */ }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Could not reach the host. Make sure the host still has the page open.')), CONNECT_TIMEOUT_MS);
      peer.on('error', onPeerError);
      c.on('error', fail);
      c.on('open', () => {
        if (settled) return;
        done();
        conn = c;
        c.on('data', onHostMessage);
        c.on('close', onConnClosed);
        c.send({ t: 'hello', uid });
        guestWatches.forEach((w, wid) => c.send({ t: 'watch', wid, path: w.path }));
        status('connected');
        resolve();
      });
    });
  }

  function onHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    } else if (msg.t === 'val') {
      const w = guestWatches.get(msg.wid);
      if (w) w.cb(msg.value === undefined ? null : msg.value);
    }
  }

  function onConnClosed() {
    conn = null;
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('Lost connection to the host.')); });
    pending.clear();
    if (closed) return;
    status('reconnecting');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    setTimeout(async () => {
      if (closed || conn) return;
      try {
        if (peer.disconnected && !peer.destroyed) peer.reconnect();
        await connectToHost();
      } catch {
        scheduleReconnect();
      }
    }, 2500);
  }

  async function startGuest(c) {
    const Peer = await loadPeerLib();
    code = c;
    const p = new Peer();
    await new Promise((resolve, reject) => {
      p.on('open', resolve);
      p.on('error', reject);
    });
    peer = p;
    role = 'guest';
    try {
      await connectToHost();
    } catch (err) {
      closeRoom();
      throw err;
    }
  }

  function send(op, payload) {
    if (role === 'host') {
      const result = execute(uid, { op, ...payload });
      return result.ok ? Promise.resolve(result) : Promise.reject(new Error(result.error));
    }
    if (!conn) return Promise.reject(new Error('Not connected to the host.'));
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The host did not answer. Check your connection.'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      conn.send({ t: 'req', id, op, ...payload });
    }).then((res) => {
      if (!res.ok) throw new Error(res.error || 'The host refused that action.');
      return res;
    });
  }

  function closeRoom() {
    closed = true;
    pending.forEach((p) => clearTimeout(p.timer));
    pending.clear();
    guests.forEach((_, c) => { try { c.close(); } catch { /* already closed */ } });
    guests.clear();
    hostWatchers.clear();
    guestWatches.clear();
    if (conn) { try { conn.close(); } catch { /* already closed */ } }
    conn = null;
    if (peer) { try { peer.destroy(); } catch { /* already destroyed */ } }
    peer = null;
    role = null;
    code = null;
    tree = {};
  }

  const readPath = async (path) => (await send('read', { path })).value;

  Object.defineProperty(api, 'role', { get: () => role, enumerable: true });

  Object.assign(api, {
    /**
     * 'host': start a new room under this code (throws code 'taken' if in use).
     * 'auto': rejoin as host when this device created the room, else join as a guest.
     */
    async openRoom(c, want) {
      closeRoom();
      closed = false;
      try {
        if (want === 'host') {
          await startHost(c, false);
        } else if (readSaved(c)) {
          // We created this room earlier (page refresh). The old registration with
          // the broker can take a few seconds to expire, so retry.
          let lastError;
          for (let i = 0; i < 6; i += 1) {
            try { await startHost(c, true); lastError = null; break; } catch (err) {
              lastError = err;
              if (err.code !== 'taken') break;
              await new Promise((r) => { setTimeout(r, 2000); });
            }
          }
          if (lastError) throw lastError;
        } else {
          await startGuest(c);
        }
      } catch (err) {
        closeRoom();
        throw err;
      }
    },
    closeRoom,

    read: readPath,
    async set(path, value) {
      await send('set', { path, value });
    },
    async update(path, obj) {
      await send('update', { path, obj });
    },
    async transact(path, fn) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const current = clone(await readPath(path));
        const next = fn(current);
        if (next === undefined) return { committed: false, value: current };
        const res = await send('cas', { path, expected: current, value: next });
        if (res.committed) return { committed: true, value: next };
        if (res.error) throw new Error(res.error);
      }
      throw new Error('Too many people changed this at once. Try again.');
    },
    watch(path, cb) {
      if (role === 'host') {
        const w = { path, cb };
        hostWatchers.add(w);
        queueMicrotask(() => { if (hostWatchers.has(w)) cb(clone(getAt(tree, path))); });
        return () => hostWatchers.delete(w);
      }
      const wid = nextId;
      nextId += 1;
      guestWatches.set(wid, { path, cb });
      if (conn) conn.send({ t: 'watch', wid, path });
      return () => {
        guestWatches.delete(wid);
        if (conn) conn.send({ t: 'unwatch', wid });
      };
    },
  });

  return api;
}
