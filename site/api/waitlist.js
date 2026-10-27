// POST /api/waitlist {email}: adds someone to the Shed Pro waitlist. Each signup is one private file in the project's
// Vercel Blob store, named by a hash of the address, so signing up twice changes nothing and no one can list the emails
// without the store's token. Read them with: vercel blob list --rw-token <token> (or the Storage tab on Vercel).
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

const hits = new Map(); // ip -> recent request times (per warm instance)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error:'Use POST.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error:'The waitlist is not open yet. Try again soon.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  const recent = (hits.get(ip) || []).filter(at => Date.now() - at < 60000);
  if (recent.length >= 5) return res.status(429).json({ error:'Too many tries. Wait a minute and try again.' });
  hits.set(ip, [...recent, Date.now()]);
  const input = typeof req.body === 'object' && req.body ? req.body : {};
  // The hidden "company" field is left empty by people and filled in by form-filling bots.
  if (input.company) return res.status(200).json({ ok:true });
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) return res.status(400).json({ error:'That doesn’t look like an email address.' });
  const id = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
  try {
    await put(`waitlist/${id}.json`, JSON.stringify({ email, joinedAt:new Date().toISOString() }), { access:'private', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true });
    return res.status(200).json({ ok:true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error:'Something went wrong. Try again in a minute.' });
  }
}
