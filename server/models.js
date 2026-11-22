import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const harnesses = ['codex', 'claude', 'gemini', 'pi', 'opencode', 'antigravity'];
export const cliCommands = { codex:'codex', claude:'claude', gemini:'gemini', pi:'pi', opencode:'opencode', antigravity:'agy' };
export const cliCommand = name => cliCommands[name] || name;
// Homebrew's `agy` wrapper execs the `antigravity` binary, so ps reports `antigravity` while direct installs/mocks may report `agy`.
export const cliProcessNames = name => name === 'antigravity' ? ['agy', 'antigravity'] : [cliCommand(name)];

const curated = {
  claude: [
    { id: 'fable', label: 'Fable', description: 'The most capable model: the toughest problems and long, ambitious work.', enabled: true },
    { id: 'opus', label: 'Opus', description: 'Deep reasoning and complex implementation.', enabled: true },
    { id: 'sonnet', label: 'Sonnet', description: 'Balanced coding and everyday tasks.', enabled: true },
    { id: 'haiku', label: 'Haiku', description: 'Fast, simple tasks and lightweight edits.', enabled: true },
  ],
  gemini: [
    { id: 'pro', label: 'Pro', description: 'Complex reasoning and larger tasks.', enabled: true },
    { id: 'flash', label: 'Flash', description: 'Fast, balanced work.', enabled: true },
    { id: 'flash-lite', label: 'Flash Lite', description: 'Fastest for simple requests.', enabled: true },
  ],
  antigravity: [
    { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', description: 'Plans with Gemini 4 Neon and executes with Gemini 4 Hydrogen for everyday development.', enabled: true },
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', description: 'Deep reasoning for complex architecture, debugging, and multi-file work.', enabled: true },
    { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)', description: 'Fast, capable coding for everyday implementation and edits.', enabled: true },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', description: 'Fast, lightweight model for quick tasks and simple edits.', enabled: true },
  ],
  pi: [],
  opencode: [],
};

let antigravityDiscovered = [];
function antigravityDescription(id, label) {
  const lower = `${id} ${label}`.toLowerCase();
  if (lower.includes('orchestrator')) return 'Plans with a frontier planner and executes quickly with Gemini 4 Hydrogen.';
  if (lower.includes('xhigh')) return 'Maximum reasoning depth for the toughest multi-step engineering problems.';
  if (lower.includes('neon') || lower.includes('carbon') || lower.includes('argon') || lower.includes('opus') || lower.includes('pro')) return 'Deep reasoning and complex implementation.';
  if (lower.includes('hydrogen') || lower.includes('sonnet')) return 'Fast, balanced coding and everyday development.';
  if (lower.includes('flash') || lower.includes('low')) return 'Fast, lightweight tasks and quick edits.';
  return 'Antigravity model.';
}
// `agy models` prints "<slug>  <Label>" lines for the models the user's account can run.
// Enable up to 6 distinct default tiers (preferring orchestrator and high/medium tiers) so Laya chooses cleanly;
// remaining effort variants stay listed and can be enabled in Settings.
export function parseAntigravityModels(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const seen = new Set();
  const raw = [];
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.trim().match(/^([a-z0-9][a-z0-9._:/-]*[-/.:][a-z0-9._:/-]{0,98})\s+(.+)$/);
    if (!match) continue;
    const [, id, label] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    raw.push({ id, label:label.trim().slice(0, 100), description:antigravityDescription(id, label) });
  }
  if (!raw.length) return [];
  let enabledCount = 0;
  const enabledFamilies = new Set();
  const familyOf = id => id.replace(/-(xhigh|high|medium|low|max)$/i, '');
  const preferred = id => /orchestrator|-high$|-medium$/i.test(id) || !/-(xhigh|high|medium|low|max)$/i.test(id);
  const all = raw.map(model => {
    const family = familyOf(model.id);
    const pick = raw.length <= 6 || (enabledCount < 6 && preferred(model.id) && !enabledFamilies.has(family));
    if (pick) { enabledCount++; enabledFamilies.add(family); }
    return { ...model, enabled:pick };
  });
  if (!all.some(m => m.enabled)) all[0].enabled = true;
  const enabled = all.filter(m => m.enabled), rest = all.filter(m => !m.enabled);
  return [...enabled, ...rest].slice(0, 24);
}
export function setAntigravityCatalog(models) {
  antigravityDiscovered = Array.isArray(models) ? models.map(m => ({ ...m })) : [];
}
function antigravityModels() {
  return (antigravityDiscovered.length ? antigravityDiscovered : curated.antigravity).map(model => ({ ...model }));
}
function antigravityDefault(home, models) {
  try {
    const configured = String(JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).model || '').trim();
    if (!configured) return '';
    const match = models.find(m => m.enabled && (m.id === configured || m.label.toLowerCase() === configured.toLowerCase()));
    return match?.id || '';
  } catch { return ''; }
}

// Claude Code keeps the list of models it offers in its own cache, so every model it can run shows up here, new ones
// included, without Shed shipping a list. The newest version of each family goes by its alias (opus, fable, ...), which
// always means the latest; older versions go by their full name. Older versions are listed but off, so Laya only
// chooses among the current ones; turn one on in Settings to pick it.
const FAMILY_BLURB = { fable:'Toughest problems.', opus:'Complex work.', sonnet:'Everyday coding.', haiku:'Quick, simple tasks.' };
function claudeCatalog(home) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  let list = [];
  try {
    const files = fs.readdirSync(dir).filter(name => name.endsWith('-cc.json')).map(name => ({ name, at:fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    if (files.length) list = JSON.parse(fs.readFileSync(path.join(dir, files[0].name), 'utf8')).catalog?.config?.models || [];
  } catch {}
  const models = [];
  for (const m of list) {
    const family = m.runtime?.family;
    if (typeof m.id !== 'string' || !/^claude-/.test(m.id) || !(family in FAMILY_BLURB)) continue;
    const latest = m.section === 'main';
    models.push(latest
      ? { id:family, label:m.short_name || family, description:m.description || FAMILY_BLURB[family], enabled:true }
      : { id:m.id, label:m.name || m.id, description:`Older ${family} version. ${FAMILY_BLURB[family]}`, enabled:false });
  }
  return models;
}
// The built-in Claude models, with Claude Code's own list laid over them.
function claudeModels(home) {
  const fromClaude = claudeCatalog(home);
  const have = new Set(fromClaude.map(m => m.id));
  return [...fromClaude, ...curated.claude.filter(m => !have.has(m.id))].map(model => ({ ...model }));
}

function codexDefaults(home = os.homedir()) {
  let configured = '';
  try { configured = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m)?.[1] || ''; } catch {}
  let models = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
    models = (cache.models || []).filter(m => m.visibility === 'list' && m.supported_in_api !== false)
      .map(m => ({ id:m.slug, label:m.display_name || m.slug, description:m.description || '', enabled:true }));
  } catch {}
  if (configured && !models.some(m => m.id === configured)) models.unshift({ id:configured, label:configured, description:'Current Codex default.', enabled:true });
  const preferred = models.filter(m => /^(gpt-6-astra|gpt-6-sol|gpt-6-luna)$/.test(m.id));
  return { models:(preferred.length >= 2 ? preferred : models.slice(0, 6)), defaultModel:configured };
}

export function defaultModelConfig(harness, home = os.homedir()) {
  if (harness === 'codex') return codexDefaults(home);
  if (harness === 'antigravity') {
    const models = antigravityModels();
    return { models, defaultModel:antigravityDefault(home, models) };
  }
  if (!harnesses.includes(harness)) throw new Error('Unsupported harness.');
  return { models:harness === 'claude' ? claudeModels(home) : curated[harness].map(model => ({ ...model })), defaultModel:'' };
}

export function modelConfig(harness, overrides = {}, home = os.homedir()) {
  if (!harnesses.includes(harness)) throw new Error('Unsupported harness.');
  const saved = overrides?.[harness];
  if (!saved) return defaultModelConfig(harness, home);
  const models = saved.models.map(model => ({ ...model }));
  // Models Claude Code or Antigravity have added since the list was last saved appear in it, so a newer model is never hidden by an old save.
  if (harness === 'claude' || harness === 'antigravity') {
    const known = new Set([...models.map(m => m.id), ...(saved.seen || [])]);
    const available = harness === 'claude' ? claudeModels(home) : antigravityModels();
    for (const model of available) if (!known.has(model.id)) models.push(model);
  }
  return { models:models.slice(0, 24), defaultModel:saved.defaultModel || '' };
}

// What the built-in list offered when a person saved theirs; a model they removed is not added back.
export function offeredModels(harness, home = os.homedir()) {
  if (harness === 'claude') return claudeModels(home).map(m => m.id);
  if (harness === 'antigravity') return antigravityModels().map(m => m.id);
  return [];
}

export function validateModelConfig(harness, input) {
  if (!harnesses.includes(harness)) throw new Error('Unsupported harness.');
  if (!Array.isArray(input.models) || input.models.length > 24) throw new Error('Use at most 24 models per harness.');
  const seen = new Set();
  const models = input.models.map(model => {
    if (!model || typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model.id)) throw new Error('Model IDs must be 1–100 letters, numbers, dots, slashes, colons, dashes, or underscores.');
    if (seen.has(model.id)) throw new Error('Model IDs must be unique within a harness.');
    seen.add(model.id);
    const label = String(model.label || model.id).trim();
    const description = String(model.description || '').trim();
    if (label.length > 100 || description.length > 300) throw new Error('Model label or description is too long.');
    return { id:model.id, label, description, enabled:model.enabled !== false };
  });
  const defaultModel = String(input.defaultModel || '');
  if (defaultModel && !models.some(model => model.id === defaultModel && model.enabled)) throw new Error('Default model must be an enabled model.');
  return { models, defaultModel };
}
