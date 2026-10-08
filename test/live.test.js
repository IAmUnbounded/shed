import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenFiles } from '../server/live.js';

test('links open transcript files to their owning agent processes', () => {
  const files = parseOpenFiles('p101\nn/tmp/first.jsonl\np202\nn/tmp/second.jsonl\n');
  assert.equal(files.get('/tmp/first.jsonl'), 101);
  assert.equal(files.get('/tmp/second.jsonl'), 202);
});
