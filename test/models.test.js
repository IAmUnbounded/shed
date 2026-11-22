import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelConfig, modelConfig } from '../server/models.js';

test('model roster accepts harness model IDs and rejects duplicates', () => {
  const saved = validateModelConfig('opencode', {
    models:[{id:'openai/gpt-6-sol',label:'Sol',description:'Everyday coding',enabled:true}],
    defaultModel:'openai/gpt-6-sol',
  });
  assert.equal(modelConfig('opencode', {opencode:saved}).defaultModel, 'openai/gpt-6-sol');
  assert.throws(() => validateModelConfig('opencode', {
    models:[{id:'same',enabled:true},{id:'same',enabled:true}], defaultModel:'same',
  }), /unique/);
  assert.throws(() => validateModelConfig('codex', {
    models:[{id:'safe;touch /tmp/bad',enabled:true}], defaultModel:'',
  }), /Model IDs/);
});

test('Claude lists every model Claude Code offers, the newest of each family by alias and older ones off', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { modelConfig, offeredModels } = await import('../server/models.js');
  const { sessionModel } = await import('../server/laya.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-models-'));
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  fs.mkdirSync(dir, { recursive:true });
  const row = (id, name, family, section) => ({ id, name, short_name:name.split(' ')[0], section, runtime:{ family } });
  fs.writeFileSync(path.join(dir, 'x-cc.json'), JSON.stringify({ catalog:{ config:{ models:[row('claude-opus-5-5', 'Opus 5.5', 'opus', 'main'), row('claude-fable-5-1', 'Fable 5.1', 'fable', 'main'), row('claude-opus-5', 'Opus 5', 'opus', 'overflow'), row('claude-mystery-1', 'Mystery', 'mystery', 'main')] } } }));
  try {
    const fresh = modelConfig('claude', {}, home).models;
    assert.deepEqual(fresh.map(m => [m.id, m.enabled]), [['opus', true], ['fable', true], ['claude-opus-5', false], ['sonnet', true], ['haiku', true]]);
    // A list saved before Fable existed gains it; one saved afterwards does not get back what its owner removed.
    const old = { claude:{ models:[{ id:'opus', label:'Opus', description:'', enabled:true }], defaultModel:'' } };
    assert.deepEqual(modelConfig('claude', old, home).models.map(m => m.id), ['opus', 'fable', 'claude-opus-5', 'sonnet', 'haiku']);
    const saved = { claude:{ ...old.claude, seen:offeredModels('claude', home) } };
    assert.deepEqual(modelConfig('claude', saved, home).models.map(m => m.id), ['opus']);
    // A session on Opus 5.5 is Opus, not the older Opus 5 whose name it starts with.
    assert.equal(sessionModel('claude-opus-5-5', fresh).id, 'opus');
    assert.equal(sessionModel('claude-opus-5', fresh).id, 'claude-opus-5');
  } finally { fs.rmSync(home, { recursive:true, force:true }); }
});

test('Antigravity parses `agy models` output, enables distinct defaults, and reads settings default', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { parseAntigravityModels, setAntigravityCatalog, modelConfig, offeredModels } = await import('../server/models.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-agy-models-'));
  const output = [
    'Fetching available models...',
    '\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
    'gemini-4-neon-high Gemini 4 Neon (High)',
    'gemini-4-neon-low Gemini 4 Neon (Low)',
    'gemini-4-hydrogen-high Gemini 4 Hydrogen (High)',
    'gemini-pro-orchestrator-neon Orchestrator (Neon)',
    'gemini-3.8-flash-medium Gemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low Gemini 3.8 Flash (Low)',
  ].join('\n');
  const parsed = parseAntigravityModels(output);
  assert.equal(parsed.length, 7);
  assert.equal(parsed.find(m => m.id === 'gemini-4-neon-high')?.enabled, true);
  assert.equal(parsed.find(m => m.id === 'gemini-4-neon-low')?.enabled, false);
  assert.equal(parsed.find(m => m.id === 'gemini-pro-orchestrator-neon')?.enabled, true);
  try {
    setAntigravityCatalog(parsed);
    const cliDir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(cliDir, { recursive:true });
    fs.writeFileSync(path.join(cliDir, 'settings.json'), JSON.stringify({ model:'Gemini 4 Neon (High)' }));
    const fresh = modelConfig('antigravity', {}, home);
    assert.equal(fresh.defaultModel, 'gemini-4-neon-high');
    assert.equal(fresh.models.length, 7);
    const saved = { antigravity:{ models:[{ id:'gemini-4-neon-high', label:'Neon', description:'', enabled:true }], defaultModel:'', seen:offeredModels('antigravity', home) } };
    assert.deepEqual(modelConfig('antigravity', saved, home).models.map(m => m.id), ['gemini-4-neon-high']);
  } finally {
    setAntigravityCatalog([]);
    fs.rmSync(home, { recursive:true, force:true });
  }
});
