import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { uploadStore, safeFileName, attachmentNote, MAX_UPLOAD_BYTES } from '../server/uploads.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shed-up-'));
const request = (chunks, length) => Object.assign(Readable.from(chunks.map(c => Buffer.from(c))), { headers:length ? { 'content-length':String(length) } : {} });

test('file names are made safe: no folders, no hidden files, readable unicode', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('.env'), 'env');
  assert.equal(safeFileName('screen shot (2).png'), 'screen shot (2).png');
  assert.equal(safeFileName('résumé.pdf'), 'résumé.pdf');
  assert.equal(safeFileName('a;b|c$.txt'), 'a_b_c_.txt');
  assert.equal(safeFileName(''), 'file');
  assert.ok(safeFileName('x'.repeat(300) + '.jpeg').endsWith('.jpeg'));
  assert.ok(safeFileName('x'.repeat(300) + '.jpeg').length <= 120);
});

test('an upload is staged, then moved into the project and kept out of git', async () => {
  const data = tmp(), project = tmp();
  fs.mkdirSync(path.join(project, '.git', 'info'), { recursive:true });
  const store = uploadStore(data);
  const first = await store.stage(request(['hello ', 'world']), 'notes.txt');
  const second = await store.stage(request(['again']), 'notes.txt');
  assert.equal(first.size, 11);
  const placed = store.place([first.id, second.id, 'not-a-real-id-000000'], project);
  assert.deepEqual(placed, [path.join(project, '.shed', 'uploads', 'notes.txt'), path.join(project, '.shed', 'uploads', 'notes-2.txt')]);
  assert.equal(fs.readFileSync(placed[0], 'utf8'), 'hello world');
  assert.match(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.shed\/$/m);
  // Placing again does not add the exclude line twice; staged copies are gone.
  store.place([], project);
  assert.equal(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8').match(/\.shed\//g).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), []);
  assert.match(attachmentNote(placed), /Attached files \(saved on this Mac\):\n- .*notes\.txt\n- .*notes-2\.txt$/);
});

test('without a project the staged path is used as is', async () => {
  const store = uploadStore(tmp());
  const up = await store.stage(request(['x']), 'a.txt');
  const [file] = store.place([up.id], '');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('oversized and empty uploads are refused and leave nothing behind', async () => {
  const data = tmp();
  const store = uploadStore(data);
  await assert.rejects(store.stage(request(['x'], MAX_UPLOAD_BYTES + 1), 'big.bin'), /100 MB/);
  await assert.rejects(store.stage(request([]), 'empty.txt'), /empty/);
  assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), []);
});
