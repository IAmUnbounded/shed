import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractUrl, fetchesMedia, sharePrompt, shortcutPlist, siteName } from '../server/share.js';

test('finds the link in what the share sheet sends', () => {
  assert.equal(extractUrl('Check this out https://www.instagram.com/reel/Abc123/?igsh=xyz.'), 'https://www.instagram.com/reel/Abc123/?igsh=xyz');
  assert.equal(extractUrl('no link here'), '');
  assert.equal(extractUrl('javascript:alert(1)'), '');
});

test('only downloads from known social sites, never from the local network', () => {
  assert.equal(fetchesMedia('https://www.instagram.com/p/x/'), true);
  assert.equal(fetchesMedia('https://vm.tiktok.com/abc'), true);
  assert.equal(fetchesMedia('http://127.0.0.1:4378/api/sessions'), false);
  assert.equal(fetchesMedia('https://evil-instagram.com/p/x'), false);
  assert.equal(siteName('https://www.instagram.com/p/x/'), 'Instagram');
});

test('the prompt leads with the note and carries the caption', () => {
  const prompt = sharePrompt({ url:'https://www.instagram.com/p/x/', text:'https://www.instagram.com/p/x/', note:'Make a recipe card from this', fetched:{ caption:'Pasta night', author:'chef', date:'2026-10-01' } });
  assert.match(prompt, /^Make a recipe card from this\n/);
  assert.match(prompt, /Posted by: chef on 2026-10-01/);
  assert.match(prompt, /Pasta night/);
  assert.match(sharePrompt({ url:'https://www.instagram.com/p/x/', text:'', note:'' }), /^Take a look at this Instagram post/);
});

test('the Shortcut is a valid property list that posts to Shed with its key', () => {
  const xml = shortcutPlist('https://a.example', 'k<&>ey');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-plist-')), 's.plist');
  fs.writeFileSync(file, xml);
  assert.equal(spawnSync('plutil', ['-lint', file]).status, 0);
  assert.match(xml, /https:\/\/a\.example\/api\/share/);
  assert.match(xml, /Bearer k&lt;&amp;&gt;ey/);
  assert.match(xml, /ActionExtension/);
});
