// Paste your Firebase web app config here (Firebase console > Project settings >
// Your apps > Web app > SDK setup and configuration).
//
// These values are public by design. The database rules in
// database.rules.json decide who can read and write.
//
// While the placeholders below are unchanged, the page runs in local demo mode:
// rooms sync only between tabs of the same browser.

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
