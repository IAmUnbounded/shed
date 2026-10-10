// Shed Pro relay: turns a paid licence into a permanent https hostname (<name>.<RELAY_DOMAIN>) that points at a
// Cloudflare named tunnel. The Mac runs `cloudflared tunnel run` with the token returned here; traffic never touches
// this function, which only manages the tunnel, its DNS record and its route.
// State lives in Cloudflare itself (one tunnel per licence, named from a hash of the key), so there is no database.
import crypto from 'node:crypto';

const LS = 'https://api.lemonsqueezy.com/v1';
const CF = 'https://api.cloudflare.com/client/v4';
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'mail', 'relay', 'shed', 'status', 'docs', 'blog', 'help', 'support', 'install', 'pro', 'teams']);
export const NAME = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function relayCore(env, fetchImpl = fetch) {
  const cf = async (method, url, body) => {
    const res = await fetchImpl(`${CF}${url}`, { method, headers:{ Authorization:`Bearer ${env.CF_API_TOKEN}`, 'Content-Type':'application/json' }, body:body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!data.success) throw Object.assign(new Error(`Cloudflare: ${data.errors?.[0]?.message || res.status}`), { status:502 });
    return data.result;
  };
  const ls = async (action, fields) => {
    const res = await fetchImpl(`${LS}/licenses/${action}`, { method:'POST', headers:{ Accept:'application/json', 'Content-Type':'application/x-www-form-urlencoded' }, body:new URLSearchParams(fields).toString() });
    return res.json().catch(() => ({}));
  };
  // Any Lemon Squeezy licence would pass `activate`, so the licence must come from this store (and a Shed product).
  const ours = meta => String(meta?.store_id) === String(env.LS_STORE_ID) && (!env.LS_PRODUCT_IDS || env.LS_PRODUCT_IDS.split(',').map(s => s.trim()).includes(String(meta?.product_id)));
  const acct = `/accounts/${env.CF_ACCOUNT_ID}`, zone = `/zones/${env.CF_ZONE_ID}`;
  const tunnelName = key => `shed-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  const findTunnel = async key => (await cf('GET', `${acct}/cfd_tunnel?is_deleted=false&name=${tunnelName(key)}`))[0] || null;
  const recordsFor = async tunnelId => (await cf('GET', `${zone}/dns_records?type=CNAME&content=${tunnelId}.cfargotunnel.com&per_page=50`)) || [];

  async function removeTunnel(key) {
    const tunnel = await findTunnel(key);
    if (!tunnel) return;
    for (const record of await recordsFor(tunnel.id)) await cf('DELETE', `${zone}/dns_records/${record.id}`);
    await cf('DELETE', `${acct}/cfd_tunnel/${tunnel.id}/connections`).catch(() => {});
    await cf('DELETE', `${acct}/cfd_tunnel/${tunnel.id}`);
  }

  async function activate({ licenseKey, instanceId, name, instanceName, port }) {
    if (typeof licenseKey !== 'string' || licenseKey.length < 8 || licenseKey.length > 100) return fail(400, 'Enter your Shed Pro licence key.');
    name = String(name || '').toLowerCase().trim();
    if (!NAME.test(name) || RESERVED.has(name)) return fail(400, 'Pick a name of 3–32 lowercase letters, numbers or dashes.');
    port = Number(port) || 4378;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail(400, 'Invalid port.');
    // A Mac that already activated reuses its instance; a new one takes an activation (the store sets the limit).
    let license;
    if (instanceId) {
      license = await ls('validate', { license_key:licenseKey, instance_id:instanceId });
      if (!license.valid) instanceId = '';
    }
    if (!instanceId) {
      license = await ls('activate', { license_key:licenseKey, instance_name:String(instanceName || 'Mac').slice(0, 60) });
      if (!license.activated) return fail(403, license.error || 'That licence key was not accepted.');
      instanceId = license.instance?.id;
    }
    if (!ours(license.meta) || !['active', 'inactive'].includes(license.license_key?.status)) return fail(403, 'That licence key is not a Shed Pro licence.');

    const hostname = `${name}.${env.RELAY_DOMAIN}`;
    let tunnel = await findTunnel(licenseKey);
    if (!tunnel) tunnel = await cf('POST', `${acct}/cfd_tunnel`, { name:tunnelName(licenseKey), config_src:'cloudflare' });
    const target = `${tunnel.id}.cfargotunnel.com`;
    const taken = (await cf('GET', `${zone}/dns_records?name=${hostname}`))[0];
    if (taken && taken.content !== target) return fail(409, `${hostname} is taken. Try another name.`);
    // One hostname per licence: renaming drops the old record.
    for (const record of await recordsFor(tunnel.id)) if (record.name !== hostname) await cf('DELETE', `${zone}/dns_records/${record.id}`);
    if (!taken) await cf('POST', `${zone}/dns_records`, { type:'CNAME', name:hostname, content:target, proxied:true, comment:'Shed Pro relay' });
    await cf('PUT', `${acct}/cfd_tunnel/${tunnel.id}/configurations`, { config:{ ingress:[{ hostname, service:`http://127.0.0.1:${port}` }, { service:'http_status:404' }] } });
    const token = await cf('GET', `${acct}/cfd_tunnel/${tunnel.id}/token`);
    return { status:200, body:{ hostname, token, instanceId } };
  }

  // Shed checks in once a day. A refunded or disabled licence loses its hostname.
  async function validate({ licenseKey, instanceId }) {
    if (!licenseKey || !instanceId) return fail(400, 'Missing licence.');
    const license = await ls('validate', { license_key:licenseKey, instance_id:instanceId });
    const valid = Boolean(license.valid) && ours(license.meta) && license.license_key?.status !== 'disabled';
    if (!valid && license.license_key) await removeTunnel(licenseKey);
    return { status:200, body:{ valid } };
  }

  async function deactivate({ licenseKey, instanceId }) {
    if (!licenseKey || !instanceId) return fail(400, 'Missing licence.');
    const license = await ls('validate', { license_key:licenseKey, instance_id:instanceId });
    if (!license.valid || !ours(license.meta)) return fail(403, 'That licence is not active on this Mac.');
    await removeTunnel(licenseKey);
    await ls('deactivate', { license_key:licenseKey, instance_id:instanceId });
    return { status:200, body:{ ok:true } };
  }

  return { activate, validate, deactivate };
}

function fail(status, error) { return { status, body:{ error } }; }

export const relayConfigured = env => ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID', 'RELAY_DOMAIN', 'LS_STORE_ID'].every(name => env[name]);
