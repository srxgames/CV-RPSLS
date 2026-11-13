# Rock Paper Scissors Lizard Spock

A browser game for 2 to 4 players. Everyone opens the same link on their own phone or laptop, picks a move in secret, and the winner appears on every screen once all moves are locked in.

Play it: https://srxgames.github.io/CV-RPSLS/

## How to play

1. One player enters a name, picks 2, 3 or 4 players, and creates a room. That player is the **host**.
2. They share the room link (`?room=K7QP`) or the 4-character code.
3. Everyone joins with a name. When every seat is filled, the move buttons appear.
4. Pick a move and press **Lock in**. Your pick stays on your device until everyone has locked in.
5. Every screen reveals all moves, the duels, and the winner. Anyone can start the next round.

Refreshing the page keeps your seat and your locked-in pick. The host should keep their page open (and their screen awake) until the game is over. If the host reloads, the room comes back; if a player drops, they reconnect automatically.

## Rules

| Move | Beats |
| --- | --- |
| Rock | crushes Scissors, crushes Lizard |
| Paper | covers Rock, disproves Spock |
| Scissors | cuts Paper, decapitates Lizard |
| Lizard | poisons Spock, eats Paper |
| Spock | smashes Scissors, vaporizes Rock |

With 3 or 4 players every pair duels and each duel win is worth 1 point. The highest total wins the round. Equal top totals are a draw. The page also keeps a rounds-won scoreboard for the room.

## How moves stay secret

Each player first publishes `SHA-256("move:salt")`. Once every player has published a hash, each player publishes their plain move and salt. Every browser re-hashes each reveal and treats a mismatch as an invalid move. Nobody can read another player's choice while the round is open.

## How players connect (no account or database needed)

By default the game is peer-to-peer. The room creator's browser keeps the game state and the other players connect straight to it over WebRTC. The free [PeerJS](https://peerjs.com/) broker only introduces the browsers to each other; it never sees moves. The host's browser enforces the rules (one seat per player, you can only change your own entries, moves can only be revealed after your commit).

Things to know:

- The host must keep the page open. If they close it, the game pauses until they reopen the same link.
- On a few strict networks (some mobile carriers or office Wi-Fi) a direct connection can fail because there is no relay server. If a player cannot join, try a different network or have a different player host.
- Each tab or device gets its own player id, so you can try the game alone by opening the link in several tabs.

### Optional: Firebase instead

If you want a room to survive without a host online, you can use Firebase. Fill in `js/firebase-config.js` and the page switches to it automatically.

1. In the [Firebase console](https://console.firebase.google.com/) create a project.
2. Under **Build > Authentication > Sign-in method**, enable **Anonymous**.
3. Under **Build > Realtime Database**, create a database, then open the **Rules** tab and paste the contents of `database.rules.json`.
4. Under **Project settings > Your apps**, add a Web app and copy its config into `js/firebase-config.js`. Make sure `databaseURL` is included.
5. Under **Authentication > Settings > Authorized domains**, add `srxgames.github.io`.
6. Commit and push.

With Firebase, use separate devices or browsers, because tabs of one browser share a single anonymous user.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | The single page: home, lobby, picking, reveal |
| `css/styles.css` | Deep-space theme, phone-first layout |
| `js/rules.js` | Beats table, pairwise scoring, hashing helpers |
| `js/game.js` | Rooms, seats, commit-reveal flow, rendering |
| `js/backend.js` | Peer-to-peer backend (default) and Firebase backend |
| `js/firebase-config.js` | Optional Firebase web config |
| `database.rules.json` | Firebase security rules (only used with Firebase) |
| `assets/` | Pixel-art icons for the five moves |

Room data layout (same for both backends):

```
rooms/{code}
  targetPlayers, hostUid, round
  seats/s0..s3        uid that holds each seat
  players/{uid}       { name }
  rounds/r{n}/{uid}   { commit } then { move, salt }
```

## Run locally

Browsers block ES modules from `file://`, so serve the folder over HTTP, for example `npx serve` or `python -m http.server`, and open `http://localhost:8000`.

## Publish with GitHub Pages

The repository must be public for friends to open the link without a GitHub login. In the repository go to **Settings > Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`, and save.
