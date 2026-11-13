// OPTIONAL. The game works without Firebase: while the placeholders below are
// unchanged, players connect peer-to-peer and the room creator's browser acts as
// the host (see js/backend.js).
//
// To use Firebase instead (no host needs to stay online), paste your web app
// config here (Firebase console > Project settings > Your apps > Web app > SDK
// setup and configuration). These values are public by design. The database
// rules in database.rules.json decide who can read and write.

export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  appId: 'YOUR_APP_ID',
};

export function isConfigured() {
  return Boolean(firebaseConfig.apiKey) && !firebaseConfig.apiKey.startsWith('YOUR_');
}
