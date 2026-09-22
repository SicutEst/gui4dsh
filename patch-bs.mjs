import fs from 'node:fs';
const p = 'D:/Zcode Project/gui4dsh/server/src/api.ts';
let s = fs.readFileSync(p, 'utf8');
const old = 'export async function buildServer(port: number): Promise<FastifyInstance> {\n  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });';
const neu = "export async function buildServer(port: number, httpsOpts?: { key: Buffer; cert: Buffer }): Promise<FastifyInstance> {\n  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, ...(httpsOpts ? { https: httpsOpts } : {}) });";
if (!s.includes(old)) throw new Error('buildServer anchor missing');
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('buildServer https option added');
