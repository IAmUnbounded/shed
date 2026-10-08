import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.jev-data');
const urlFile = path.join(dataDir, 'remote-url');
fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });
fs.rmSync(urlFile, { force:true });

const child = spawn('/opt/homebrew/bin/cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4378'], {
  cwd:root,
  stdio:['ignore', 'pipe', 'pipe'],
});

const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
function readOutput(chunk) {
  const value = chunk.toString();
  process.stdout.write(value);
  const matches = value.match(pattern);
  if (matches?.length) {
    fs.writeFileSync(urlFile, matches.at(-1) + '\n', { mode:0o600 });
    fs.chmodSync(urlFile, 0o600);
  }
}
child.stdout.on('data', readOutput);
child.stderr.on('data', readOutput);
child.on('error', error => { process.stderr.write(`${error.message}\n`); fs.rmSync(urlFile, { force:true }); process.exitCode = 1; });
child.on('close', code => { fs.rmSync(urlFile, { force:true }); process.exit(code || 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
