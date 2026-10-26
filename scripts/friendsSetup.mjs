// npm run friends:setup: adds FRIENDS_SECRET to .env, once. It locks friends' keys (AES-256-GCM) and signs their
// log-ins. Keep it with .env: a different secret makes the saved keys unreadable.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const file = '.env';
const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (/^\s*FRIENDS_SECRET\s*=\s*\S/m.test(text)) {
  console.log('FRIENDS_SECRET is already in .env. Nothing changed.');
  process.exit(0);
}
const lead = text && !text.endsWith('\n') ? '\n' : '';
appendFileSync(file, `${lead}\n# Locks friends' keys and signs their log-ins (npm run friends:setup). Keep it: a new one makes saved keys unreadable.\nFRIENDS_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
const port = process.env.FRIENDS_PORT || 3850;
console.log(`Added FRIENDS_SECRET to .env.

Next:
  1. Restart the app: npm run build, then npm start.
  2. Install Tailscale on this computer, log in, then run once:
       tailscale funnel --bg ${port}
     It prints an address starting with https://
  3. Open the app → Tools → Friends: add your name and that address, then make invite links.`);
