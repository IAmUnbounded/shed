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
