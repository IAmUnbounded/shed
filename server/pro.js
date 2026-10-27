import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shed Pro: a permanent https address from the Shed relay. The licence and tunnel token are kept in relay.json
// (private to this user); tunnel.js notices the file change and switches from the Quick Tunnel to the named tunnel.
export const RELAY_API = process.env.SHED_RELAY_API || 'https://shed-sigma.vercel.app/api/relay';
export const RELAY_DOMAIN = process.env.SHED_RELAY_DOMAIN || 'shed.link';

export function proStore(dataDir, { fetchImpl = fetch, port = 4378 } = {}) {
  const file = path.join(dataDir, 'relay.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const write = value => { fs.writeFileSync(file, JSON.stringify(value), { mode:0o600 }); fs.chmodSync(file, 0o600); };
  const call = async payload => {
    const res = await fetchImpl(RELAY_API, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload), signal:AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The Shed relay answered ${res.status}.`);
    return data;
  };
  return {
    status() {
      const relay = read();
      return relay ? { active:true, hostname:relay.hostname, url:`https://${relay.hostname}`, checkedAt:relay.checkedAt || null, domain:RELAY_DOMAIN } : { active:false, domain:RELAY_DOMAIN };
    },
    async activate(licenseKey, name) {
      const previous = read();
      const sameKey = previous?.licenseKey === licenseKey;
      const result = await call({ action:'activate', licenseKey, name, instanceId:sameKey ? previous.instanceId : undefined, instanceName:os.hostname().slice(0, 60), port });
      write({ licenseKey, instanceId:result.instanceId, hostname:result.hostname, token:result.token, checkedAt:new Date().toISOString() });
      return this.status();
    },
    async deactivate() {
      const relay = read();
      if (!relay) return this.status();
      await call({ action:'deactivate', licenseKey:relay.licenseKey, instanceId:relay.instanceId }).catch(() => {}); // the address goes away locally either way
      fs.rmSync(file, { force:true });
      return this.status();
    },
    // Once a day: a refunded or disabled licence goes back to the free Quick Tunnel. Network errors keep Pro on.
    async check() {
      const relay = read();
      if (!relay || (relay.checkedAt && Date.now() - Date.parse(relay.checkedAt) < 20 * 3600 * 1000)) return;
      try {
        const { valid } = await call({ action:'validate', licenseKey:relay.licenseKey, instanceId:relay.instanceId });
        if (valid) write({ ...relay, checkedAt:new Date().toISOString() });
        else fs.rmSync(file, { force:true });
      } catch { /* offline or relay down: try again later */ }
    },
  };
}
