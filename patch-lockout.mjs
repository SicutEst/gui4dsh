import fs from 'node:fs';
const p = 'D:/Zcode Project/gui4dsh/server/src/api.ts';
let s = fs.readFileSync(p, 'utf8');

// per-IP lockout for failed token auth — direct-exposure hardening
const anchor = 'function rateLimited(ip: string): boolean {';
if (!s.includes(anchor)) throw new Error('rateLimited anchor missing');
s = s.replace(
  anchor,
  `// auth-failure lockout: exposing the gateway directly (IPv6/DDNS) invites
// credential stuffing; 8 bad tokens in 10 minutes silences an IP for 30 min
const authFails = new Map<string, { n: number; until: number }>();
function authLocked(ip: string): boolean {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (rec.until > Date.now()) return true;
  if (rec.until > 0) authFails.delete(ip);
  return false;
}
function authFailed(ip: string): void {
  const now = Date.now();
  const rec = authFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 8) {
    rec.until = now + 30 * 60_000;
    rec.n = 0;
  }
  authFails.set(ip, rec);
  // bounded map: drop stale entries
  if (authFails.size > 5000) {
    for (const [k, v] of authFails) if (v.until < now && v.n < 8) authFails.delete(k);
  }
}

function rateLimited(ip: string): boolean {`,
);

// hook into the auth fence
const fence = `      if (!tokenOk(tokenFromReq(req))) {
        await reply.code(401).send({ error: 'unauthorized' });
      }`;
if (!s.includes(fence)) throw new Error('fence anchor missing');
s = s.replace(
  fence,
  `      const ip = req.ip || 'unknown';
      if (authLocked(ip)) {
        await reply.code(429).send({ error: 'too many failed attempts' });
      } else if (!tokenOk(tokenFromReq(req))) {
        authFailed(ip);
        await reply.code(401).send({ error: 'unauthorized' });
      }`,
);
fs.writeFileSync(p, s);
console.log('auth lockout added');
