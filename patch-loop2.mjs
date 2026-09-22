import fs from 'node:fs';
const p = 'D:/Zcode Project/gui4dsh/server/src/api.ts';
let s = fs.readFileSync(p, 'utf8');
const old = "      const ip = req.ip || 'unknown';\n      if (authLocked(ip)) {\n        await reply.code(429).send({ error: 'too many failed attempts' });\n      } else if (!tokenOk(tokenFromReq(req))) {\n        authFailed(ip);\n        await reply.code(401).send({ error: 'unauthorized' });\n      }";
const neu = "      const ip = req.ip || 'unknown';\n      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';\n      if (!loopback && authLocked(ip)) {\n        await reply.code(429).send({ error: 'too many failed attempts' });\n      } else if (!tokenOk(tokenFromReq(req))) {\n        if (!loopback) authFailed(ip);\n        await reply.code(401).send({ error: 'unauthorized' });\n      }";
if (!s.includes(old)) throw new Error('fence block still missing');
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('loopback exemption applied');
