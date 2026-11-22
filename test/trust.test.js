import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trustShedWorkspace, shedWorkspace } from '../server/trust.js';

function home() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-trust-')));
  fs.mkdirSync(path.join(dir, 'Shed Workspaces', 'find-video-stocks'), { recursive:true });
  return dir;
}

test('a folder Shed made is trusted for Claude, keeping everything else Claude saved', () => {
  const dir = home(), file = path.join(dir, '.claude.json');
  const folder = path.join(dir, 'Shed Workspaces', 'find-video-stocks');
  fs.writeFileSync(file, JSON.stringify({ numStartups:5, projects:{ '/elsewhere':{ allowedTools:['Bash'] }, [folder]:{ lastCost:1.5 } } }));
  try {
    assert.equal(trustShedWorkspace('claude', folder, { home:dir }), true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved, { numStartups:5, projects:{ '/elsewhere':{ allowedTools:['Bash'] }, [folder]:{ lastCost:1.5, hasTrustDialogAccepted:true } } });
    assert.equal(trustShedWorkspace('claude', folder, { home:dir }), false, 'already trusted: nothing written');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.shed-')), [], 'no temporary files left behind');
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('folders outside Shed Workspaces, and a config Claude is halfway through writing, are left alone', () => {
  const dir = home(), file = path.join(dir, '.claude.json');
  try {
    assert.equal(trustShedWorkspace('claude', path.join(dir, 'Downloads'), { home:dir }), false);
    assert.equal(shedWorkspace(path.join(dir, 'Shed Workspaces-other', 'x'), dir), false);
    assert.equal(shedWorkspace(path.join(dir, 'Shed Workspaces', '..', 'Downloads'), dir), false);
    assert.equal(shedWorkspace(path.join(dir, 'Shed Workspaces'), dir), false, 'only folders inside it');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '{"projects": {');
    assert.equal(trustShedWorkspace('claude', path.join(dir, 'Shed Workspaces', 'find-video-stocks'), { home:dir }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"projects": {');
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('a folder Shed made is trusted for Codex once', () => {
  const dir = home(), file = path.join(dir, '.codex', 'config.toml');
  const folder = path.join(dir, 'Shed Workspaces', 'find-video-stocks');
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, 'model = "gpt-5"');
  try {
    assert.equal(trustShedWorkspace('codex', folder, { home:dir }), true);
    assert.equal(trustShedWorkspace('codex', folder, { home:dir }), false);
    assert.equal(fs.readFileSync(file, 'utf8'), `model = "gpt-5"\n\n[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('a folder Shed made is trusted for Antigravity, keeping existing CLI settings', () => {
  const dir = home(), file = path.join(dir, '.gemini', 'antigravity-cli', 'settings.json');
  const folder = path.join(dir, 'Shed Workspaces', 'find-video-stocks');
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, JSON.stringify({ agentMode:'auto', trustedWorkspaces:['/existing'] }));
  try {
    assert.equal(trustShedWorkspace('antigravity', folder, { home:dir }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agentMode:'auto', trustedWorkspaces:['/existing', folder] });
    assert.equal(trustShedWorkspace('antigravity', folder, { home:dir }), false);
    assert.equal(trustShedWorkspace('antigravity', path.join(dir, 'Downloads'), { home:dir }), false);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
