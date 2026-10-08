import fs from 'node:fs';
import path from 'node:path';

// Files an agent typically makes for a person to look at or keep.
const TYPES = {
  '.mp4':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm', '.m4v':'video/mp4', '.gif':'image/gif',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4',
  '.pdf':'application/pdf', '.zip':'application/zip', '.csv':'text/csv', '.srt':'text/plain',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const SKIP = new Set(['node_modules', '.git', '.next', '.cache', '__pycache__', '.venv', 'venv', '.turbo']);
export const isArtifact = name => Boolean(TYPES[path.extname(name).toLowerCase()]);
export const artifactKind = name => (TYPES[path.extname(name).toLowerCase()] || '').split('/')[0];

// Newest artifact files under the project folder, a few levels deep.
export function listArtifacts(root, limit = 60) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || found.length > 2000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && isArtifact(entry.name)) {
        try { const stat = fs.statSync(full); found.push({ path:path.relative(root, full), size:stat.size, modifiedAt:stat.mtime.toISOString(), kind:artifactKind(entry.name) }); } catch {}
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

// Resolves a requested path and refuses anything outside the project folder, including through symlinks.
export function resolveInside(root, requested) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) return null;
  let realRoot, real;
  try { realRoot = fs.realpathSync(root); real = fs.realpathSync(path.resolve(root, requested)); } catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  const rel = path.relative(realRoot, real);
  if (rel.split(path.sep).some(part => part.startsWith('.') || SKIP.has(part))) return null;
  try { if (!fs.statSync(real).isFile() || !isArtifact(real)) return null; } catch { return null; }
  return real;
}

// Streams a file with byte-range support, so phones can seek in videos.
export function sendFile(req, res, file, download) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const name = path.basename(file).replace(/[^\w.\- ]/g, '_');
  const headers = {
    'Content-Type':type, 'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff',
    'Content-Disposition':`${download ? 'attachment' : 'inline'}; filename="${name}"`,
    // An SVG is shown as an image, never run as a page.
    ...(type === 'image/svg+xml' ? { 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start); end = Math.min(end, stat.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range':`bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range':`bytes ${start}-${end}/${stat.size}`, 'Content-Length':end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length':stat.size });
  fs.createReadStream(file).pipe(res);
}
