// assemble a publishable npm package for `npx gui4dsh`:
//   release/gui4dsh/  → package.json + bin + server/dist + web/dist
// then `npm pack` it into a tarball for local testing before publishing

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'release', 'gui4dsh');

// Git Bash's env breaks spawnSync-through-cmd.exe; call npm's cli js directly
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const run = (args, cwd) => {
  const r = spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', cwd });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${r.status})`);
};

console.log('[pack] building server + web …');
run(['run', 'build', '-w', 'web'], root);
run(['run', 'build', '-w', 'server'], root);

fs.rmSync(path.join(root, 'release'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'bin'), { recursive: true });

const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));

const pkgJson = {
  name: 'gui4dsh',
  version: serverPkg.version,
  description: 'web frontend for dsh (DeepSeek Harness) with mobile remote access',
  license: 'MIT',
  type: 'module',
  bin: { gui4dsh: 'bin/gui4dsh.js' },
  engines: { node: '>=20' },
  dependencies: serverPkg.dependencies,
  files: ['bin/', 'server/dist/', 'web/dist/'],
  repository: { type: 'git', url: 'git+https://github.com/SicutEst/gui4dsh.git' },
};
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkgJson, null, 2));

fs.writeFileSync(
  path.join(out, 'bin', 'gui4dsh.js'),
  `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'server', 'dist', 'index.js');
const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
`,
);

fs.cpSync(path.join(root, 'server', 'dist'), path.join(out, 'server', 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'web', 'dist'), path.join(out, 'web', 'dist'), { recursive: true });

console.log('[pack] npm pack …');
run(["pack"], out);
console.log('[pack] done → release/');
