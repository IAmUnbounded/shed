// POST /api/relay {action:'activate'|'validate'|'deactivate', licenseKey, instanceId?, name?, instanceName?, port?}
import { relayCore, relayConfigured } from './_relay-core.js';

const hits = new Map(); // ip -> recent request times (per warm instance; Cloudflare rate limits sit in front as well)

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error:'Use POST.' });
  if (!relayConfigured(process.env)) return res.status(503).json({ error:'The Shed relay is not open yet.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  const recent = (hits.get(ip) || []).filter(at => Date.now() - at < 60000);
  if (recent.length >= 10) return res.status(429).json({ error:'Too many requests. Try again in a minute.' });
  hits.set(ip, [...recent, Date.now()]);
  const input = typeof req.body === 'object' && req.body ? req.body : {};
  const core = relayCore(process.env);
  const action = { activate:core.activate, validate:core.validate, deactivate:core.deactivate }[input.action];
  if (!action) return res.status(400).json({ error:'Unknown action.' });
  try {
    const { status, body } = await action(input);
    return res.status(status).json(body);
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error:'The relay could not finish that. Try again shortly.' });
  }
}
