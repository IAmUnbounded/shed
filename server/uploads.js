import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Files attached to a message from the phone. An upload is staged in Shed's data folder under a random id; when the
// message is sent, its files move into the project as <project>/.shed/uploads/<name>, and the message tells the
// agent their full paths on this Mac. Staged files that are never sent are removed after a day.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const UPLOAD_ID = /^[A-Za-z0-9_-]{16,40}$/;

export function safeFileName(name) {
  let base = path.basename(String(name || '')).normalize('NFC').replace(/[^\p{L}\p{N} ._()+@,-]/gu, '_').replace(/^[.\s]+/, '').trim();
  if (base.length > 120) { const ext = path.extname(base).slice(0, 16); base = base.slice(0, 120 - ext.length) + ext; }
  return base || 'file';
}

export function uploadStore(dataDir) {
  const stageRoot = path.join(dataDir, 'uploads');
  const stageDir = id => path.join(stageRoot, id);

  function sweep() {
    let names = [];
    try { names = fs.readdirSync(stageRoot); } catch { return; }
    for (const id of names) {
      try { if (Date.now() - fs.statSync(stageDir(id)).mtimeMs > 24 * 3600 * 1000) fs.rmSync(stageDir(id), { recursive:true, force:true }); } catch { /* already gone */ }
    }
  }

  // Streams the request body to disk, stopping at the size limit.
  async function stage(req, name) {
    sweep();
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Files can be up to 100 MB.'), { status:413 });
    const id = crypto.randomBytes(18).toString('base64url');
    const file = path.join(stageDir(id), safeFileName(name));
    fs.mkdirSync(stageDir(id), { recursive:true, mode:0o700 });
    const out = fs.createWriteStream(file, { mode:0o600 });
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Files can be up to 100 MB.'), { status:413 });
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
    } catch (error) {
      out.destroy();
      fs.rmSync(stageDir(id), { recursive:true, force:true });
      throw error;
    }
    if (!size) { fs.rmSync(stageDir(id), { recursive:true, force:true }); throw Object.assign(new Error('That file is empty.'), { status:400 }); }
    return { id, name:path.basename(file), size };
  }

  function discard(id) {
    if (UPLOAD_ID.test(id)) fs.rmSync(stageDir(id), { recursive:true, force:true });
  }

  // Moves staged uploads into <cwd>/.shed/uploads (kept out of git) and returns their absolute paths.
  // Without a usable project folder the files stay where they are staged, which is still a path on this Mac.
  function place(ids, cwd) {
    const placed = [];
    const target = cwd && cwd !== '/' && fs.existsSync(cwd) ? path.join(cwd, '.shed', 'uploads') : '';
    if (target) {
      fs.mkdirSync(target, { recursive:true });
      ignoreInGit(cwd);
    }
    for (const id of ids) {
      if (!UPLOAD_ID.test(id)) continue;
      let name;
      try { name = fs.readdirSync(stageDir(id))[0]; } catch { continue; }
      if (!name) continue;
      const source = path.join(stageDir(id), name);
      if (!target) { placed.push(source); continue; }
      const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
      let dest = path.join(target, name);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(target, `${stem}-${n}${ext}`);
      try { fs.renameSync(source, dest); } catch { fs.copyFileSync(source, dest); }
      fs.rmSync(stageDir(id), { recursive:true, force:true });
      placed.push(dest);
    }
    return placed;
  }

  return { stage, discard, place };
}

// Adds .shed/ to the repository's local exclude list (never to its .gitignore), so uploads are not committed.
function ignoreInGit(cwd) {
  const exclude = path.join(cwd, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.join(cwd, '.git'))) return;
  try {
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (/^\/?\.shed\/?$/m.test(current)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive:true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Files sent to agents from Shed\n.shed/\n`);
  } catch { /* a worktree's .git is a file; leaving it alone is fine */ }
}

export function attachmentNote(paths) {
  return paths.length ? `\n\nAttached file${paths.length > 1 ? 's' : ''} (saved on this Mac):\n${paths.map(p => `- ${p}`).join('\n')}` : '';
}
