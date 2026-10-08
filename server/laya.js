import { Laya } from '@receptron/laya';
import { rankSessions, chooseRoute } from './router.js';

let enginePromise;
let engineState = 'cold';
let engineError = '';

export function layaStatus() {
  return { ready:engineState === 'ready', state:engineState, model:'laya', error:engineError };
}

export function getLaya() {
  if (!enginePromise) {
    engineState = 'loading';
    enginePromise = Laya.load().then(engine => {
      engineState = 'ready';
      engineError = '';
      return engine;
    }).catch(error => {
      enginePromise = undefined;
      engineState = 'error';
      engineError = error.message;
      throw error;
    });
  }
  return enginePromise;
}

async function askChoice(state, name, instructions, criteria, options = {}) {
  const engine = options.engine || await getLaya();
  const data = await engine.systemOne(state, { [name]:{ type:'choice', instructions, criteria } });
  const answer = data.answers?.[name];
  if (answer?.type !== 'choice') throw new Error('Laya did not return a choice.');
  const choice = answer.choice;
  const probability = Number(answer.probabilities?.[choice] ?? answer.confidence ?? 0);
  if (!Object.hasOwn(criteria, choice) || !Number.isFinite(probability)) throw new Error('Laya returned an invalid choice.');
  return { choice, confidence:probability, model:data.model || 'laya' };
}

const harnessDescriptions = {
  codex:'Codex: coding, terminal workflows, and repository work.',
  claude:'Claude Code: coding, analysis, and longer codebase tasks.',
  gemini:'Gemini CLI: coding, research, and multimodal workflows.',
  pi:'Pi: configurable coding agent with provider selection.',
  opencode:'OpenCode: coding agent with configurable providers and models.',
};

export async function decideRoute(prompt, sessions, harness = 'auto', sessionId = null, options = {}) {
  const local = chooseRoute(prompt, sessions, harness, sessionId);
  if (sessionId) return { ...local, source:'selected' };
  if (options.preview) return { ...local, source:'local' };

  const candidates = rankSessions(prompt, sessions, harness).slice(0, 6);
  const availableHarnesses = (options.availableHarnesses || [...new Set(sessions.map(session => session.harness))]).filter(Boolean);
  const newHarnesses = harness === 'auto' ? availableHarnesses : [harness];
  const criteria = Object.fromEntries(newHarnesses.map(name => [`new_${name}`, `Start a new ${name} session. ${harnessDescriptions[name] || ''} Choose this when no existing conversation is a close fit.`]));
  candidates.forEach(({ session }, index) => {
    criteria[`session_${index}`] = `Continue the ${session.harness} conversation about ${session.title.slice(0, 140)} in project ${session.cwd || 'unknown'}. Recent request: ${session.lastPrompt?.slice(0, 150) || 'none'}. Use only when the new request belongs in this conversation.`;
  });
  if (Object.keys(criteria).length < 2) return { ...local, source:'local' };

  try {
    const { choice, confidence } = await askChoice({ request:prompt.slice(0, 8000), allowedHarness:harness, availableHarnesses:newHarnesses, candidates:candidates.map(({ session }, index) => ({ option:`session_${index}`, title:session.title, project:session.cwd, harness:session.harness })) }, 'route', 'Choose the best existing session for this request, or start a new session in the best suited available harness. Prefer a new session if the connection to existing sessions is weak or unclear. Choose only one listed option.', criteria, options);
    if (confidence < 0.42) return { ...local, source:'local', fallbackReason:'Laya was unsure; local matching was used' };
    if (choice.startsWith('new_')) {
      const chosenHarness = choice.slice(4);
      if (!newHarnesses.includes(chosenHarness)) throw new Error('Laya selected an unavailable harness.');
      return { session:null, harness:chosenHarness, reason:`Laya chose a new ${chosenHarness} session for this task`, confidence:'laya', source:'laya', score:confidence };
    }
    const selected = candidates[Number(choice.split('_')[1])]?.session;
    if (!selected) throw new Error('Laya selected an invalid session.');
    return { session:selected, reason:`Laya matched this task to the ${selected.harness} conversation`, confidence:'laya', source:'laya', score:confidence };
  } catch (error) {
    return { ...local, source:'local', fallbackReason:`Laya unavailable: ${error.message}` };
  }
}

// Existing sessions keep their native harness and context. Only an explicit user
// handoff may start a different harness; Laya chooses models, never this route.
export async function decideFollowup(prompt, session, options = {}) {
  const mode = options.mode || 'auto';
  if (!['auto', 'stay', session.harness].includes(mode)) {
    if (!(options.availableHarnesses || []).includes(mode)) throw new Error(`${mode} is not ready.`);
    return { session:null, harness:mode, handoff:true, reason:`Handing this session off to ${mode} as you selected`, source:'selected' };
  }
  if (options.currentReady === false) {
    throw new Error(`${options.currentDetail || `${session.harness} is not ready.`} This session stays on ${session.harness}; restore it or explicitly choose a handoff.`);
  }
  return { session, harness:session.harness, handoff:false, reason:`Continuing in the same ${session.harness} session`, source:'selected' };
}

export function sessionModel(id, models) {
  if (!id) return null;
  const value = id.toLowerCase();
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Aliases like "opus" match full IDs like "claude-opus-5-5"; the longest alias wins so "flash-lite" beats "flash".
  return [...models].sort((a, b) => b.id.length - a.id.length)
    .find(model => new RegExp(`(^|[^a-z0-9])${escape(model.id.toLowerCase())}($|[^a-z0-9])`).test(value)) || null;
}

export async function decideModel(prompt, harness, config, options = {}) {
  const enabled = config.models.filter(model => model.enabled);
  const defaultModel = config.defaultModel && enabled.some(model => model.id === config.defaultModel) ? config.defaultModel : '';
  // When continuing a session, its current model is the natural fallback and the option Laya sees first.
  const current = options.session?.harness === harness ? sessionModel(options.session.currentModel, enabled) : null;
  const fallback = current ? { model:current.id, source:'session', reason:`Keeping the session's current model, ${current.label}` }
    : { model:defaultModel || null, source:defaultModel ? 'default' : 'harness-default', reason:defaultModel ? 'Using the configured default model' : 'Using the harness default model' };
  if (options.override) {
    const selected = enabled.find(model => model.id === options.override);
    if (!selected) throw new Error('The selected model is not enabled for this harness.');
    return { model:selected.id, source:'selected', reason:'Using the model you selected' };
  }
  if (enabled.length === 0) return fallback;
  if (enabled.length === 1) return { model:enabled[0].id, source:'single-option', reason:'Only one model is enabled for this harness' };
  if (options.preview) return fallback;
  const criteria = Object.fromEntries(enabled.map((model, index) => [`model_${index}`, `${model.label} (${model.id}): ${model.description || 'No description supplied.'}${model === current ? ' This is the model the conversation is already using; prefer it unless the request clearly needs a different one.' : ''}`]));
  try {
    const { choice, confidence } = await askChoice({ request:prompt.slice(0, 8000), harness, currentModel:current?.id || '', sessionTopic:options.session?.title || '', recentConversation:options.session?.lastPrompt || '', models:enabled.map(model => ({ id:model.id, description:model.description })) }, 'model', 'Choose the best model for this task within the selected harness. Consider difficulty, speed, and the model descriptions. Pick one listed option.', criteria, options);
    if (confidence < 0.42) return { ...fallback, fallbackReason:'Laya was unsure about the model' };
    const selected = enabled[Number(choice.split('_')[1])];
    if (!selected) throw new Error('Laya selected an invalid model.');
    if (selected === current) return { model:selected.id, source:'laya', reason:`Laya kept the session on ${selected.label}`, score:confidence };
    return { model:selected.id, source:'laya', reason:current ? `Laya switched this session from ${current.label} to ${selected.label}` : `Laya chose ${selected.label} for this task`, score:confidence };
  } catch (error) {
    return { ...fallback, fallbackReason:`Laya model choice unavailable: ${error.message}` };
  }
}

export async function probeLaya(options = {}) {
  const result = await askChoice({ message:'Connection check from Shed.' }, 'connection', 'Choose ready to confirm the local model is working.', { ready:'The model is working.', unavailable:'The model is not working.' }, options);
  if (result.choice !== 'ready') throw new Error('Laya did not confirm the connection.');
  return { ok:true, model:result.model, local:true };
}
