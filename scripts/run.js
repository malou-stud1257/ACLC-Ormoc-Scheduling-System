import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientRequire = createRequire(path.join(root, 'client', 'package.json'));
let vite;
try {
  vite = path.resolve(path.dirname(clientRequire.resolve('vite')), '../../bin/vite.js');
} catch {
  console.error('Vite is not installed. Run `pnpm install` from the project root first.');
  process.exit(1);
}

const node = process.execPath;
const commands = {
  server: { command: node, args: ['src/index.js'], cwd: path.join(root, 'server') },
  client: { command: node, args: [vite, '--host', '0.0.0.0'], cwd: path.join(root, 'client') },
  seed: { command: node, args: ['src/seed.js'], cwd: path.join(root, 'server') },
  linkInstructors: { command: node, args: ['src/link-instructors.js'], cwd: path.join(root, 'server') },
  provisionInstructors: { command: node, args: ['src/provision-instructor-accounts.js'], cwd: path.join(root, 'server') },
  build: { command: node, args: [vite, 'build'], cwd: path.join(root, 'client') }
};

const requested = process.argv[2] || 'dev';
if (requested !== 'dev') {
  const task = commands[requested];
  if (!task) {
    console.error(`Unknown command: ${requested}. Use dev, server, client, seed, linkInstructors, provisionInstructors, or build.`);
    process.exit(1);
  }
  const child = spawn(task.command, task.args, { cwd: task.cwd, stdio: 'inherit', env: process.env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const children = Object.entries(commands).filter(([name]) => name === 'server' || name === 'client').map(([name, task]) => {
    console.log(`[${name}] starting…`);
    return spawn(task.command, task.args, { cwd: task.cwd, stdio: 'inherit', env: process.env });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (!child.killed) child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const child of children) {
    child.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });
    child.on('exit', (code, signal) => {
      if (!stopping && code !== 0) { console.error(`A development service stopped (${code ?? signal}).`); stop(); process.exitCode = code ?? 1; }
    });
  }
}
