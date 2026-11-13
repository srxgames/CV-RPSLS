import {
  MOVES, LABELS, isMove, verb, scoreRound, sha256Hex, randomHex, commitText,
} from './rules.js';
import { createBackend } from './backend.js';

// ---- Constants and state -------------------------------------------------

const SEAT_KEYS = ['s0', 's1', 's2', 's3'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RULE_LINES = [
  ['scissors', 'cuts', 'paper'],
  ['paper', 'covers', 'rock'],
  ['rock', 'crushes', 'lizard'],
  ['lizard', 'poisons', 'spock'],
  ['spock', 'smashes', 'scissors'],
  ['scissors', 'decapitates', 'lizard'],
  ['lizard', 'eats', 'paper'],
  ['paper', 'disproves', 'spock'],
  ['spock', 'vaporizes', 'rock'],
  ['rock', 'crushes', 'scissors'],
];

const app = document.getElementById('app');
const banner = document.getElementById('banner');

// Room updates arrive often. Skip the DOM rewrite when the markup is unchanged
// so a tap that is already in progress is never lost to a re-render.
let lastHtml = '';
const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
Object.defineProperty(app, 'innerHTML', {
  get() { return innerHtml.get.call(this); },
  set(html) {
    if (html === lastHtml) return;
    lastHtml = html;
    innerHtml.set.call(this, html);
  },
});

const S = {
  backend: null,
  uid: null,
  name: localStorage.getItem('rpsls-name') || '',
  code: null,
  room: null,
  unsub: null,
  pick: null,          // move highlighted on this device, before locking in
  pickRound: null,
  revealingKey: null,  // guards the "publish my move" write
  resolved: null,      // { key, entries, outcome } for the current round
  resolvingKey: null,
  joinCode: '',
};

// ---- Small helpers ---------------------------------------------------------

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function randomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function normalizeCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function shareLink() {
  return `${location.origin}${location.pathname}?room=${S.code}`;
}

function pickKey(round) {
  return `rpsls-pick:${S.code}:${round}:${S.uid}`;
}

function icon(move, cls = '') {
  return `<img class="pix ${cls}" src="assets/${move}.png" alt="${LABELS[move] || ''}" width="128" height="128">`;
}

function friendly(err) {
  const text = (err && err.message) || String(err);
  if (/permission/i.test(text)) return 'The server refused that action. Check the database rules.';
  return text;
}

function setMessage(text, kind = 'error') {
  const el = document.getElementById('msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = `msg ${kind}`;
  el.hidden = !text;
}

// ---- Room model -------------------------------------------------------------

function model() {
  const room = S.room;
  if (!room) return null;
  const target = Number(room.targetPlayers) || 2;
  const seats = room.seats || {};
  const players = SEAT_KEYS.slice(0, target)
    .map((key) => seats[key])
    .filter(Boolean)
    .map((uid) => ({
      uid,
      name: (room.players && room.players[uid] && room.players[uid].name) || 'Joining...',
    }));
  const round = Number(room.round) || 1;
  const data = (room.rounds && room.rounds[`r${round}`]) || {};
  const full = players.length === target;
  const committed = full && players.every((p) => data[p.uid] && data[p.uid].commit);
  const revealed = committed && players.every((p) => data[p.uid].move && data[p.uid].salt);
  return { room, target, players, round, data, full, committed, revealed, isHost: room.hostUid === S.uid };
}

/** Rounds won by each player. Finished rounds only, plus the current one when asked. */
function roundWins(m, includeCurrent) {
  const wins = {};
  m.players.forEach((p) => { wins[p.uid] = 0; });
  const last = includeCurrent ? m.round : m.round - 1;
  for (let r = 1; r <= last; r += 1) {
    const data = (m.room.rounds && m.room.rounds[`r${r}`]) || {};
    if (!m.players.every((p) => data[p.uid] && data[p.uid].move)) continue;
    const outcome = scoreRound(m.players.map((p) => ({ id: p.uid, move: data[p.uid].move })));
    if (!outcome.tie) wins[outcome.winners[0]] += 1;
  }
  return wins;
}

// ---- Actions -----------------------------------------------------------------

async function claimSeat(code, room) {
  const target = Number(room.targetPlayers);
  const seats = room.seats || {};
  if (Object.values(seats).includes(S.uid)) return;
  for (let i = 0; i < target; i += 1) {
    const result = await S.backend.transact(`rooms/${code}/seats/${SEAT_KEYS[i]}`, (cur) => (cur ? undefined : S.uid));
    if (result.committed) return;
  }
  throw new Error('That room is full.');
}

async function takeSeat(code, name) {
  const room = await S.backend.read(`rooms/${code}`);
  if (!room) throw new Error(`Room ${code} was not found. Check the code.`);
  await claimSeat(code, room);
  await S.backend.set(`rooms/${code}/players/${S.uid}`, { name });
  enterRoom(code);
}

async function joinRoom(code, name) {
  if (S.backend.openRoom) await S.backend.openRoom(code, 'auto');
  try {
    await takeSeat(code, name);
  } catch (err) {
    if (S.backend.closeRoom) S.backend.closeRoom();
    throw err;
  }
}

async function createRoom(name, target) {
  let code = null;
  for (let attempt = 0; attempt < 6 && !code; attempt += 1) {
    const candidate = randomCode();
    if (S.backend.openRoom) {
      try {
        await S.backend.openRoom(candidate, 'host');
      } catch (err) {
        if (err.code === 'taken') continue;
        throw err;
      }
    }
    const result = await S.backend.transact(`rooms/${candidate}`, (cur) => (
      cur ? undefined : { targetPlayers: target, hostUid: S.uid, round: 1 }
    ));
    if (result.committed) code = candidate;
  }
  if (!code) throw new Error('Could not create a room. Try again.');
  try {
    await takeSeat(code, name);
  } catch (err) {
    if (S.backend.closeRoom) S.backend.closeRoom();
    throw err;
  }
}

function enterRoom(code) {
  leaveWatch();
  S.code = code;
  S.room = null;
  S.pick = null;
  S.pickRound = null;
  S.resolved = null;
  S.revealingKey = null;
  history.replaceState(null, '', `${location.pathname}?room=${code}`);
  updateBanner();
  S.unsub = S.backend.watch(`rooms/${code}`, (room) => {
    S.room = room;
    onRoomUpdate();
  });
}

function leaveWatch() {
  if (S.unsub) S.unsub();
  S.unsub = null;
}

function leaveRoom() {
  leaveWatch();
  if (S.backend.closeRoom) S.backend.closeRoom();
  S.code = null;
  S.room = null;
  S.joinCode = '';
  history.replaceState(null, '', location.pathname);
  updateBanner();
  renderHome();
}

/** Peer-to-peer rooms live in the host's browser, so tell players what that means. */
function updateBanner(connection) {
  const b = S.backend;
  if (!b || b.mode !== 'p2p' || !S.code) { banner.hidden = true; return; }
  banner.hidden = false;
  if (connection === 'reconnecting') banner.textContent = 'Connection lost. Trying to reconnect to the host...';
  else if (b.role === 'host') banner.textContent = 'You are the host. Keep this page open (and your screen awake) until the game is over.';
  else banner.textContent = 'Connected directly to the host. If the host closes their page, the game pauses until they return.';
}

async function lockIn() {
  const m = model();
  if (!m || !S.pick || !isMove(S.pick)) return;
  const move = S.pick;
  const button = document.querySelector('[data-action="lock"]');
  if (button) button.disabled = true;
  try {
    const salt = randomHex(16);
    const commit = await sha256Hex(commitText(move, salt));
    localStorage.setItem(pickKey(m.round), JSON.stringify({ move, salt }));
    await S.backend.set(`rooms/${S.code}/rounds/r${m.round}/${S.uid}/commit`, commit);
  } catch (err) {
    if (button) button.disabled = false;
    setMessage(friendly(err));
  }
}

async function nextRound() {
  const m = model();
  if (!m) return;
  const button = document.querySelector('[data-action="next"]');
  if (button) button.disabled = true;
  try {
    await S.backend.transact(`rooms/${S.code}/round`, (cur) => (cur === m.round ? m.round + 1 : undefined));
  } catch (err) {
    if (button) button.disabled = false;
    setMessage(friendly(err));
  }
}

/** Once every player has locked in, publish this player's plain move and salt. */
function publishMoveIfReady(m) {
  if (!m.committed || (m.data[S.uid] && m.data[S.uid].move)) return;
  const key = `${S.code}:${m.round}`;
  if (S.revealingKey === key) return;
  const saved = localStorage.getItem(pickKey(m.round));
  if (!saved) return;
  S.revealingKey = key;
  const { move, salt } = JSON.parse(saved);
  S.backend.update(`rooms/${S.code}/rounds/r${m.round}/${S.uid}`, { move, salt }).catch((err) => {
    S.revealingKey = null;
    setMessage(friendly(err));
  });
}

/** Check every revealed move against its hash, then score the round. */
async function resolveRound(m) {
  const key = `${S.code}:${m.round}`;
  if ((S.resolved && S.resolved.key === key) || S.resolvingKey === key) return;
  S.resolvingKey = key;
  try {
    const entries = [];
    for (const p of m.players) {
      const d = m.data[p.uid];
      const hash = await sha256Hex(commitText(d.move, d.salt));
      const valid = hash === d.commit && isMove(d.move);
      entries.push({ id: p.uid, name: p.name, move: valid ? d.move : null, claimed: d.move, valid });
    }
    S.resolved = { key, entries, outcome: scoreRound(entries) };
  } catch (err) {
    S.resolved = null;
    setMessage(friendly(err));
  } finally {
    S.resolvingKey = null;
  }
  render();
}

function onRoomUpdate() {
  const m = model();
  if (m) {
    if (S.pickRound !== m.round) { S.pick = null; S.pickRound = m.round; }
    publishMoveIfReady(m);
  }
  render();
}

// ---- Rendering -----------------------------------------------------------------

function render() {
  const m = model();
  if (!S.code) return;
  if (!m) {
    app.innerHTML = `
      <div class="panel center">
        <h2>Room not found</h2>
        <p>Room ${esc(S.code)} no longer exists.</p>
        <button class="btn" data-action="leave">Back to start</button>
      </div>`;
    return;
  }
  if (!m.full) { renderLobby(m); return; }
  if (m.revealed) {
    if (S.resolved && S.resolved.key === `${S.code}:${m.round}`) { renderReveal(m); return; }
    resolveRound(m);
    renderPlay(m, true);
    return;
  }
  renderPlay(m, false);
}

function renderScoreboard(m, includeCurrent) {
  const wins = roundWins(m, includeCurrent);
  const chips = m.players.map((p) => `
    <li class="chip${p.uid === S.uid ? ' me' : ''}">
      <span class="chip-name">${esc(p.name)}</span>
      <span class="chip-score">${wins[p.uid]}</span>
    </li>`).join('');
  return `<ul class="scoreboard" aria-label="Rounds won">${chips}</ul>`;
}

function renderHome() {
  const invited = S.joinCode;
  app.innerHTML = `
    <div class="panel">
      <label class="field">
        <span>Your name</span>
        <input id="name" maxlength="16" autocomplete="nickname" placeholder="Captain Kirk" value="${esc(S.name)}">
      </label>
      ${invited ? `<p class="invite">You were invited to room <strong>${esc(invited)}</strong>. Enter your name and join.</p>` : ''}
      <div class="split">
        <section class="card">
          <h2>Start a game</h2>
          <fieldset class="count">
            <legend>Players</legend>
            ${[2, 3, 4].map((n) => `
              <label class="count-opt">
                <input type="radio" name="count" value="${n}"${n === 2 ? ' checked' : ''}>
                <span>${n}</span>
              </label>`).join('')}
          </fieldset>
          <button class="btn" data-action="create">Create room</button>
        </section>
        <section class="card">
          <h2>Join a game</h2>
          <label class="field">
            <span>Room code</span>
            <input id="code" class="code-input" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="K7QP" value="${esc(invited)}">
          </label>
          <button class="btn alt" data-action="join">Join room</button>
        </section>
      </div>
      <p id="msg" class="msg error" role="alert" hidden></p>
    </div>
    <details class="panel rules">
      <summary>How the winner is decided</summary>
      <ul class="rule-list">
        ${RULE_LINES.map(([a, v, b]) => `
          <li>${icon(a, 'tiny')}<span><strong>${LABELS[a]}</strong> ${v} <strong>${LABELS[b]}</strong></span>${icon(b, 'tiny')}</li>`).join('')}
      </ul>
      <p>With 3 or 4 players every pair duels, and each duel win is worth 1 point. The highest total wins the round. Equal top totals are a draw.</p>
    </details>`;
}

function renderLobby(m) {
  const missing = m.target - m.players.length;
  const slots = Array.from({ length: m.target }, (_, i) => {
    const p = m.players[i];
    return p
      ? `<li class="slot filled${p.uid === S.uid ? ' me' : ''}"><span class="slot-name">${esc(p.name)}</span><span class="slot-tag">${p.uid === m.room.hostUid ? 'Host' : 'Ready'}</span></li>`
      : '<li class="slot"><span class="slot-name">Open seat</span><span class="slot-tag">Waiting</span></li>';
  }).join('');
  app.innerHTML = `
    <div class="panel center">
      <h2>Room code</h2>
      <p class="room-code" aria-label="Room code ${esc(S.code)}">${esc(S.code)}</p>
      <div class="share">
        <input id="share" readonly value="${esc(shareLink())}" aria-label="Share link">
        <button class="btn small" data-action="copy">Copy link</button>
      </div>
      <p class="hint">Send the link to your friends. Picking starts when ${m.target} players have joined.</p>
      <ul class="slots">${slots}</ul>
      <p class="status">Waiting for ${missing} more player${missing === 1 ? '' : 's'}...</p>
      <p id="msg" class="msg error" role="alert" hidden></p>
      <button class="btn ghost small" data-action="leave">Back to start</button>
    </div>`;
}

function renderPlay(m, revealing) {
  const mine = m.data[S.uid];
  const locked = Boolean(mine && mine.commit);
  const saved = locked ? localStorage.getItem(pickKey(m.round)) : null;
  const lockedMove = saved ? JSON.parse(saved).move : null;

  const status = m.players.map((p) => {
    const done = Boolean(m.data[p.uid] && m.data[p.uid].commit);
    return `<li class="chip status${done ? ' done' : ''}${p.uid === S.uid ? ' me' : ''}">
      <span class="chip-name">${esc(p.name)}</span>
      <span class="chip-tag">${done ? 'Locked in' : 'Choosing...'}</span>
    </li>`;
  }).join('');

  let body;
  if (!locked) {
    body = `
      <p class="status">Pick your move</p>
      <div class="moves" role="group" aria-label="Choose a move">
        ${MOVES.map((mv) => `
          <button class="move${S.pick === mv ? ' selected' : ''}" data-action="pick" data-move="${mv}" aria-pressed="${S.pick === mv}">
            ${icon(mv)}<span>${LABELS[mv]}</span>
          </button>`).join('')}
      </div>
      <button class="btn big" data-action="lock"${S.pick ? '' : ' disabled'}>${S.pick ? `Lock in ${LABELS[S.pick]}` : 'Choose a move'}</button>`;
  } else {
    const left = m.players.filter((p) => !(m.data[p.uid] && m.data[p.uid].commit)).length;
    body = `
      <div class="locked">
        ${lockedMove ? icon(lockedMove, 'big') : ''}
        <p class="status">${revealing ? 'Revealing moves...' : (left ? `Locked in${lockedMove ? ` ${LABELS[lockedMove]}` : ''}. Waiting for ${left} more...` : 'Everyone is in. Revealing moves...')}</p>
      </div>`;
  }

  app.innerHTML = `
    <div class="panel">
      <div class="round-head">
        <h2>Round ${m.round}</h2>
        <span class="room-pill">Room ${esc(S.code)}</span>
      </div>
      ${renderScoreboard(m, false)}
      <ul class="statuses">${status}</ul>
      ${body}
      <p id="msg" class="msg error" role="alert" hidden></p>
    </div>`;
}

function renderReveal(m) {
  const { entries, outcome } = S.resolved;
  const names = Object.fromEntries(entries.map((e) => [e.id, e.name]));
  const winnerSet = new Set(outcome.tie ? [] : outcome.winners);

  let headline;
  let sub = '';
  if (!outcome.tie) {
    const w = entries.find((e) => e.id === outcome.winners[0]);
    headline = `${esc(w.name)} wins the round!`;
    sub = w.id === S.uid ? 'That was you. Nicely played.' : '';
  } else {
    const tied = outcome.winners.map((id) => esc(names[id]));
    headline = tied.length === entries.length ? 'It is a draw!' : `Draw between ${tied.join(' and ')}`;
    sub = 'Nobody takes the round. Go again.';
  }

  const cards = entries.map((e) => `
    <li class="result${winnerSet.has(e.id) ? ' win' : ''}${e.id === S.uid ? ' me' : ''}${!outcome.tie && !winnerSet.has(e.id) ? ' lose' : ''}">
      ${e.valid ? icon(e.move) : '<div class="invalid">?</div>'}
      <span class="result-name">${esc(e.name)}</span>
      <span class="result-move">${e.valid ? LABELS[e.move] : 'Invalid move'}</span>
      <span class="result-points">${outcome.scores[e.id]} pt${outcome.scores[e.id] === 1 ? '' : 's'}</span>
      ${winnerSet.has(e.id) ? '<span class="crown">Winner</span>' : ''}
    </li>`).join('');

  const duels = outcome.pairs.map((p) => {
    if (!p.winnerId) {
      const label = isMove(p.aMove) ? LABELS[p.aMove] : 'nothing';
      return `<li>${esc(names[p.aId])} and ${esc(names[p.bId])} both played ${label}. Tie.</li>`;
    }
    const wm = p.winnerId === p.aId ? p.aMove : p.bMove;
    const lm = p.winnerId === p.aId ? p.bMove : p.aMove;
    const how = isMove(lm)
      ? `${LABELS[wm]} ${verb(wm, lm)} ${LABELS[lm]}`
      : `${LABELS[wm]} beats an invalid move`;
    return `<li><strong>${esc(names[p.winnerId])}</strong> beats ${esc(names[p.loserId])}: ${how}</li>`;
  }).join('');

  app.innerHTML = `
    <div class="panel">
      <div class="round-head">
        <h2>Round ${m.round} result</h2>
        <span class="room-pill">Room ${esc(S.code)}</span>
      </div>
      <div class="headline${outcome.tie ? ' draw' : ''}" role="status">
        <p class="headline-text">${headline}</p>
        ${sub ? `<p class="headline-sub">${sub}</p>` : ''}
      </div>
      <ul class="results n${entries.length}">${cards}</ul>
      <h3>The duels</h3>
      <ul class="duels">${duels}</ul>
      <h3>Rounds won</h3>
      ${renderScoreboard(m, true)}
      <div class="actions">
        <button class="btn big" data-action="next">Play next round</button>
        <button class="btn ghost small" data-action="leave">Back to start</button>
      </div>
      <p id="msg" class="msg error" role="alert" hidden></p>
    </div>`;
}

// ---- Events --------------------------------------------------------------------------

function readName() {
  const input = document.getElementById('name');
  const name = (input ? input.value : S.name).trim().slice(0, 16);
  S.name = name;
  if (name) localStorage.setItem('rpsls-name', name);
  return name;
}

async function withBusy(button, task) {
  if (button) button.disabled = true;
  setMessage('');
  try {
    await task();
  } catch (err) {
    setMessage(friendly(err));
    if (button) button.disabled = false;
  }
}

app.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const action = el.dataset.action;

  if (action === 'pick') {
    S.pick = el.dataset.move;
    render();
  } else if (action === 'lock') {
    lockIn();
  } else if (action === 'next') {
    nextRound();
  } else if (action === 'leave') {
    leaveRoom();
  } else if (action === 'copy') {
    copyLink(el);
  } else if (action === 'create') {
    const name = readName();
    if (!name) { setMessage('Enter your name first.'); return; }
    const checked = document.querySelector('input[name="count"]:checked');
    withBusy(el, () => createRoom(name, Number(checked ? checked.value : 2)));
  } else if (action === 'join') {
    const name = readName();
    const code = normalizeCode(document.getElementById('code').value);
    if (!name) { setMessage('Enter your name first.'); return; }
    if (code.length !== 4) { setMessage('Room codes have 4 characters.'); return; }
    withBusy(el, () => joinRoom(code, name));
  }
});

app.addEventListener('input', (event) => {
  if (event.target.id === 'code') event.target.value = normalizeCode(event.target.value);
});

app.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.target.id === 'code') document.querySelector('[data-action="join"]').click();
  if (event.target.id === 'name') {
    const target = S.joinCode ? 'join' : 'create';
    document.querySelector(`[data-action="${target}"]`).click();
  }
});

async function copyLink(button) {
  const link = shareLink();
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const input = document.getElementById('share');
    input.select();
    document.execCommand('copy');
  }
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy link'; }, 1500);
}

// ---- Boot --------------------------------------------------------------------------------

async function boot() {
  try {
    S.backend = await createBackend();
  } catch (err) {
    app.innerHTML = `<div class="panel center"><h2>Could not connect</h2><p>${esc(friendly(err))}</p></div>`;
    return;
  }
  S.uid = S.backend.uid;
  S.backend.onStatus = (state) => updateBanner(state);

  const code = normalizeCode(new URLSearchParams(location.search).get('room'));
  let problem = '';
  if (code.length === 4) {
    try {
      if (S.backend.openRoom) await S.backend.openRoom(code, 'auto');
      const room = await S.backend.read(`rooms/${code}`);
      const seated = room && room.seats && Object.values(room.seats).includes(S.uid);
      if (seated) { enterRoom(code); return; }
      if (!room) problem = `Room ${code} was not found. Check the code.`;
    } catch (err) {
      problem = friendly(err);
    }
    // Not seated here yet: drop the trial connection; joining opens it again.
    if (S.backend.closeRoom) S.backend.closeRoom();
    S.joinCode = code;
  }
  renderHome();
  if (problem) setMessage(problem);
}

boot();
