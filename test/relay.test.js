import test from 'node:test';
import assert from 'node:assert/strict';
import { relayCore } from '../site/api/_relay-core.js';

const env = { CF_API_TOKEN:'t', CF_ACCOUNT_ID:'acct', CF_ZONE_ID:'zone', RELAY_DOMAIN:'shed.example', LS_STORE_ID:'42', LS_PRODUCT_IDS:'7' };

// An in-memory Cloudflare (tunnels, DNS) and Lemon Squeezy (licences) behind a fake fetch.
function fakeWorld() {
  const tunnels = [], dns = [], configs = {}, licenses = { 'GOOD-KEY-1234':{ store:42, product:7, status:'inactive', instances:[] }, 'OTHER-STORE-99':{ store:1, product:7, status:'inactive', instances:[] } };
  let n = 0;
  const ok = result => ({ json:async () => ({ success:true, result }) });
  async function fetchImpl(url, { method, body }) {
    const u = new URL(url);
    if (u.host === 'api.lemonsqueezy.com') {
      const f = Object.fromEntries(new URLSearchParams(body));
      const lic = licenses[f.license_key];
      const meta = lic && { store_id:lic.store, product_id:lic.product };
      const action = u.pathname.split('/').pop();
      if (!lic) return { json:async () => ({ activated:false, valid:false, error:'license_key not found.' }) };
      if (action === 'activate') { const id = `inst-${++n}`; lic.instances.push(id); lic.status = 'active'; return { json:async () => ({ activated:true, instance:{ id }, license_key:{ status:lic.status }, meta }) }; }
      if (action === 'validate') return { json:async () => ({ valid:lic.status !== 'disabled' && lic.instances.includes(f.instance_id), license_key:{ status:lic.status }, meta }) };
      if (action === 'deactivate') { lic.instances = lic.instances.filter(i => i !== f.instance_id); return { json:async () => ({ deactivated:true }) }; }
    }
    const p = u.pathname.replace('/client/v4', ''), q = u.searchParams, data = body && JSON.parse(body);
    if (p === '/accounts/acct/cfd_tunnel' && method === 'GET') return ok(tunnels.filter(t => t.name === q.get('name')));
    if (p === '/accounts/acct/cfd_tunnel' && method === 'POST') { const t = { id:`tun-${++n}`, name:data.name }; tunnels.push(t); return ok(t); }
    let m = p.match(/^\/accounts\/acct\/cfd_tunnel\/([\w-]+)(\/\w+)?$/);
    if (m) {
      if (m[2] === '/configurations') { configs[m[1]] = data.config; return ok({}); }
      if (m[2] === '/token') return ok(`token-for-${m[1]}`);
      if (m[2] === '/connections') return ok({});
      if (!m[2] && method === 'DELETE') { tunnels.splice(tunnels.findIndex(t => t.id === m[1]), 1); return ok({}); }
    }
    if (p === '/zones/zone/dns_records' && method === 'GET') return ok(dns.filter(r => (!q.get('name') || r.name === q.get('name')) && (!q.get('content') || r.content === q.get('content'))));
    if (p === '/zones/zone/dns_records' && method === 'POST') { const r = { id:`dns-${++n}`, ...data }; dns.push(r); return ok(r); }
    m = p.match(/^\/zones\/zone\/dns_records\/([\w-]+)$/);
    if (m && method === 'DELETE') { dns.splice(dns.findIndex(r => r.id === m[1]), 1); return ok({}); }
    throw new Error(`unexpected ${method} ${url}`);
  }
  return { fetchImpl, tunnels, dns, configs, licenses };
}

test('activating a licence creates one tunnel, one hostname and a route to the Mac', async () => {
  const world = fakeWorld();
  const relay = relayCore(env, world.fetchImpl);
  const result = await relay.activate({ licenseKey:'GOOD-KEY-1234', name:'sukhad', instanceName:'MacBook', port:4378 });
  assert.equal(result.status, 200);
  assert.equal(result.body.hostname, 'sukhad.shed.example');
  assert.match(result.body.token, /^token-for-tun-/);
  assert.equal(world.tunnels.length, 1);
  assert.deepEqual(world.dns.map(r => [r.name, r.content]), [['sukhad.shed.example', `${world.tunnels[0].id}.cfargotunnel.com`]]);
  assert.equal(world.configs[world.tunnels[0].id].ingress[0].service, 'http://127.0.0.1:4378');

  // Re-activating from the same Mac reuses the instance and the tunnel; renaming moves the hostname.
  const again = await relay.activate({ licenseKey:'GOOD-KEY-1234', instanceId:result.body.instanceId, name:'sukhad-mac' });
  assert.equal(again.body.instanceId, result.body.instanceId);
  assert.equal(world.tunnels.length, 1);
  assert.deepEqual(world.dns.map(r => r.name), ['sukhad-mac.shed.example']);
});

test('names are validated and cannot be taken from another licence', async () => {
  const world = fakeWorld();
  world.licenses['SECOND-KEY-5678'] = { store:42, product:7, status:'inactive', instances:[] };
  const relay = relayCore(env, world.fetchImpl);
  assert.equal((await relay.activate({ licenseKey:'GOOD-KEY-1234', name:'www' })).status, 400);
  assert.equal((await relay.activate({ licenseKey:'GOOD-KEY-1234', name:'Bad Name' })).status, 400);
  assert.equal((await relay.activate({ licenseKey:'GOOD-KEY-1234', name:'taken' })).status, 200);
  const clash = await relay.activate({ licenseKey:'SECOND-KEY-5678', name:'taken' });
  assert.equal(clash.status, 409);
});

test('licences from other stores and unknown keys are refused', async () => {
  const world = fakeWorld();
  const relay = relayCore(env, world.fetchImpl);
  assert.equal((await relay.activate({ licenseKey:'OTHER-STORE-99', name:'abc' })).status, 403);
  assert.equal((await relay.activate({ licenseKey:'NOPE-NOPE-NOPE', name:'abc' })).status, 403);
  assert.equal(world.tunnels.length, 0);
});

test('a disabled licence loses its tunnel on the daily check, and deactivation cleans up', async () => {
  const world = fakeWorld();
  const relay = relayCore(env, world.fetchImpl);
  const { body } = await relay.activate({ licenseKey:'GOOD-KEY-1234', name:'abc' });
  assert.equal((await relay.validate({ licenseKey:'GOOD-KEY-1234', instanceId:body.instanceId })).body.valid, true);
  world.licenses['GOOD-KEY-1234'].status = 'disabled';
  assert.equal((await relay.validate({ licenseKey:'GOOD-KEY-1234', instanceId:body.instanceId })).body.valid, false);
  assert.equal(world.tunnels.length, 0);
  assert.equal(world.dns.length, 0);

  world.licenses['GOOD-KEY-1234'].status = 'active';
  const second = await relay.activate({ licenseKey:'GOOD-KEY-1234', instanceId:body.instanceId, name:'abc' });
  assert.equal((await relay.deactivate({ licenseKey:'GOOD-KEY-1234', instanceId:second.body.instanceId })).status, 200);
  assert.equal(world.tunnels.length, 0);
  assert.equal(world.dns.length, 0);
});
