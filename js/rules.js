// Pure game rules for Rock Paper Scissors Lizard Spock.
// No DOM or network access, so these functions are easy to test.

export const MOVES = ['rock', 'paper', 'scissors', 'lizard', 'spock'];

export const LABELS = {
  rock: 'Rock',
  paper: 'Paper',
  scissors: 'Scissors',
  lizard: 'Lizard',
  spock: 'Spock',
};

// BEATS[winner][loser] = verb
const BEATS = {
  rock: { scissors: 'crushes', lizard: 'crushes' },
  paper: { rock: 'covers', spock: 'disproves' },
  scissors: { paper: 'cuts', lizard: 'decapitates' },
  lizard: { spock: 'poisons', paper: 'eats' },
  spock: { scissors: 'smashes', rock: 'vaporizes' },
};

export function isMove(value) {
  return MOVES.includes(value);
}

/** Verb for a winning matchup, for example verb('rock', 'scissors') === 'crushes'. */
export function verb(winner, loser) {
  return (BEATS[winner] && BEATS[winner][loser]) || null;
}

/**
 * Compare two moves. Returns 1 when `a` wins, -1 when `b` wins, 0 for a tie.
 * A missing or invalid move (null) forfeits against any valid move.
 */
export function duel(a, b) {
  const aOk = isMove(a);
  const bOk = isMove(b);
  if (!aOk && !bOk) return 0;
  if (!aOk) return -1;
  if (!bOk) return 1;
  if (a === b) return 0;
  return verb(a, b) ? 1 : -1;
}

/**
 * Score one round for 2 to 4 players. Every pair of players plays a duel and
 * the winner of a duel earns 1 point. The highest total wins the round; equal
 * top totals are a tie.
 *
 * entries: [{ id, move }]
 * returns: { scores: {id: points}, pairs: [...], winners: [id], tie: boolean }
 */
export function scoreRound(entries) {
  const scores = {};
  entries.forEach((e) => { scores[e.id] = 0; });

  const pairs = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      const result = duel(a.move, b.move);
      let winnerId = null;
      let loserId = null;
      let winMove = null;
      let loseMove = null;
      if (result === 1) {
        winnerId = a.id; loserId = b.id; winMove = a.move; loseMove = b.move;
      } else if (result === -1) {
        winnerId = b.id; loserId = a.id; winMove = b.move; loseMove = a.move;
      }
      if (winnerId) scores[winnerId] += 1;
      pairs.push({
        aId: a.id,
        bId: b.id,
        aMove: a.move,
        bMove: b.move,
        winnerId,
        loserId,
        verb: winnerId && isMove(loseMove) ? verb(winMove, loseMove) : null,
      });
    }
  }

  const top = Math.max(...Object.values(scores));
  const winners = entries.filter((e) => scores[e.id] === top).map((e) => e.id);
  return { scores, pairs, winners, tie: winners.length !== 1 };
}

// ---- Secret moves -------------------------------------------------------
// A player first publishes SHA-256("move:salt"). The plain move is published
// only after every player has published a hash, then checked against it.

export async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('Secret moves need HTTPS or localhost. Open the page from its https link.');
  }
  const buffer = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function commitText(move, salt) {
  return `${move}:${salt}`;
}
