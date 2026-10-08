import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute, decideFollowup, decideModel, probeLaya, sessionModel } from '../server/laya.js';

const sessions = [
  { id:'codex:one', nativeId:'one', harness:'codex', title:'Lunar dashboard', lastPrompt:'Add moon charts', cwd:'/tmp/lunar', updatedAt:new Date().toISOString() },
  { id:'codex:two', nativeId:'two', harness:'codex', title:'Billing service', lastPrompt:'Fix invoices', cwd:'/tmp/billing', updatedAt:new Date().toISOString() },
];

function engine(answer, capture = () => {}) {
  return { systemOne:async (state, questions) => {
    capture({ state, questions });
    const name = Object.keys(questions)[0];
    return { model:'laya', answers:{ [name]:{ type:'choice', choice:answer, probabilities:{ [answer]:0.92 } } } };
  } };
}

test('Laya choice is checked against the listed sessions before routing', async () => {
  let request;
  const result = await decideRoute('Improve the lunar dashboard', sessions, 'auto', null, { engine:engine('session_0', value => { request = value; }), availableHarnesses:['codex'] });
  assert.equal(result.session.id, 'codex:one');
  assert.equal(result.source, 'laya');
  assert.deepEqual(Object.keys(request.questions.route.criteria), ['new_codex','session_0','session_1']);
});

test('Laya can choose a harness for a fresh task', async () => {
  const result = await decideRoute('Research this architecture', [], 'auto', null, { engine:engine('new_gemini'), availableHarnesses:['codex','gemini'] });
  assert.equal(result.harness, 'gemini');
  assert.equal(result.session, null);
  assert.equal(result.source, 'laya');
});

test('invalid Laya choice falls back to local matching', async () => {
  const result = await decideRoute('Improve the lunar dashboard', sessions, 'auto', null, { engine:engine('unlisted'), availableHarnesses:['codex'] });
  assert.equal(result.source, 'local');
  assert.equal(result.session.id, 'codex:one');
});

test('Laya selects an enabled model for the chosen harness', async () => {
  let request;
  const config = { models:[
    {id:'fast',label:'Fast',description:'Simple edits',enabled:true},
    {id:'deep',label:'Deep',description:'Complex reasoning',enabled:true},
    {id:'off',label:'Off',description:'Disabled',enabled:false},
  ], defaultModel:'fast' };
  const result = await decideModel('Design a complex parser', 'codex', config, { engine:engine('model_1', value => { request = value; }) });
  assert.equal(result.model, 'deep');
  assert.equal(result.source, 'laya');
  assert.deepEqual(Object.keys(request.questions.model.criteria), ['model_0','model_1']);
});

test('model preview uses the configured default without loading Laya', async () => {
  const config = { models:[{id:'fast',label:'Fast',enabled:true},{id:'deep',label:'Deep',enabled:true}], defaultModel:'fast' };
  const result = await decideModel('Simple fix', 'codex', config, { preview:true });
  assert.equal(result.model, 'fast');
  assert.equal(result.source, 'default');
});

test('local Laya probe validates an actual typed decision', async () => {
  const result = await probeLaya({ engine:engine('ready') });
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
});

function engineAt(answer, probability) {
  return { systemOne:async (state, questions) => ({ model:'laya', answers:{ [Object.keys(questions)[0]]:{ type:'choice', choice:answer, probabilities:{ [answer]:probability } } } }) };
}

test('automatic follow-ups keep the original session without asking Laya for a harness', async () => {
  let calls = 0;
  const switchEngine = engine('switch_gemini', () => { calls++; });
  for (const mode of [undefined, 'auto', 'stay', 'codex']) {
    const result = await decideFollowup('Research charting libraries with screenshots', sessions[0], { mode, engine:switchEngine, availableHarnesses:['codex','claude','gemini'] });
    assert.equal(result.handoff, false);
    assert.equal(result.session, sessions[0]);
    assert.equal(result.harness, 'codex');
  }
  assert.equal(calls, 0);
});

test('an unavailable session harness never triggers an automatic handoff', async () => {
  for (const availableHarnesses of [[], ['gemini'], ['claude', 'gemini']]) {
    for (const preview of [false, true]) {
      await assert.rejects(decideFollowup('Keep going', sessions[0], { currentReady:false, currentDetail:'Sign in to Codex.', availableHarnesses, preview }), /Sign in to Codex.*This session stays on codex/);
    }
  }
});

test('Laya can change the model while the follow-up keeps its session and harness', async () => {
  const session = { ...sessions[0], currentModel:'deep' };
  const route = await decideFollowup('Rename a variable', session, { availableHarnesses:['codex','gemini'] });
  const config = { models:[{id:'fast',label:'Fast',enabled:true},{id:'deep',label:'Deep',enabled:true}], defaultModel:'deep' };
  const result = await decideModel('Rename a variable', route.harness, config, { session:route.session, engine:engine('model_0') });
  assert.equal(result.model, 'fast');
  assert.equal(result.source, 'laya');
  assert.equal(route.session, session);
  assert.equal(route.handoff, false);
});

test('explicit follow-up modes skip Laya', async () => {
  const fail = { systemOne:async () => { throw new Error('should not be called'); } };
  assert.equal((await decideFollowup('x', sessions[0], { mode:'stay', engine:fail, availableHarnesses:['gemini'] })).handoff, false);
  const handoff = await decideFollowup('x', sessions[0], { mode:'gemini', engine:fail, availableHarnesses:['codex','gemini'] });
  assert.equal(handoff.harness, 'gemini');
  assert.equal(handoff.source, 'selected');
  await assert.rejects(decideFollowup('x', sessions[0], { mode:'pi', engine:fail, availableHarnesses:['gemini'] }), /not ready/);
});

test('session model IDs map onto roster aliases', () => {
  const roster = [{id:'flash'},{id:'flash-lite'},{id:'opus'}];
  assert.equal(sessionModel('gemini-2.5-flash-lite', roster).id, 'flash-lite');
  assert.equal(sessionModel('claude-opus-5-5', roster).id, 'opus');
  assert.equal(sessionModel('sonnet', roster), null);
});

test('an unsure model choice keeps the session on its current model', async () => {
  const config = { models:[{id:'sonnet',label:'Sonnet',enabled:true},{id:'opus',label:'Opus',enabled:true}], defaultModel:'sonnet' };
  const session = { ...sessions[0], harness:'claude', currentModel:'claude-opus-5-5' };
  const unsure = await decideModel('Keep going', 'claude', config, { session, engine:engineAt('model_0', 0.3) });
  assert.equal(unsure.model, 'opus');
  assert.equal(unsure.source, 'session');
  const switched = await decideModel('Rename a variable', 'claude', config, { session, engine:engine('model_0') });
  assert.equal(switched.model, 'sonnet');
  assert.match(switched.reason, /switched this session from Opus to Sonnet/);
});
