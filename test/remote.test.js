import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanHostname, cleanHttpsUrl, cleanToken, effectiveMode, probeTailscale, resetTailscaleCache, remoteStore } from '../server/remote.js';

test('hostname, https url, and token validation reject unsafe values', () => {
  assert.equal(cleanHostname('https://Shed.Example.com/path'), 'shed.example.com');
  assert.equal(cleanHostname('bad host'), '');
  assert.equal(cleanHostname('localhost'), '');
  assert.equal(cleanHttpsUrl('https://mac.tail123.ts.net/'), 'https://mac.tail123.ts.net');
  assert.equal(cleanHttpsUrl('https://shed.example.com:8443/'), 'https://shed.example.com:8443');
  assert.equal(cleanHttpsUrl('http://shed.example.com'), '');
  assert.equal(cleanHttpsUrl('https://user:pass@shed.example.com'), '');
  assert.equal(cleanToken('eyJhIjoiMSJ9'), 'eyJhIjoiMSJ9');
  assert.equal(cleanToken('has space'), '');
});

test('effectiveMode resolves auto in priority order: cloudflare, tailscale, quick', () => {
  assert.equal(effectiveMode({ mode:'auto', cloudflare:{ hostname:'a.b.com', token:'tok' } }, { running:true, hostname:'m.ts.net' }), 'cloudflare');
  assert.equal(effectiveMode({ mode:'auto', cloudflare:{ hostname:'', token:'' } }, { running:true, hostname:'m.ts.net' }), 'tailscale');
  assert.equal(effectiveMode({ mode:'auto', cloudflare:{ hostname:'', token:'' } }, { running:false, hostname:'' }), 'quick');
  assert.equal(effectiveMode({ mode:'off', cloudflare:{ hostname:'a.b.com', token:'tok' } }, { running:true, hostname:'m.ts.net' }), 'off');
});

test('probeTailscale parses running Tailscale status JSON cleanly', async () => {
  resetTailscaleCache();
  const running = await probeTailscale({
    fresh:true,
    bin:'/usr/local/bin/tailscale',
    run:async () => ({ ok:true, stdout:JSON.stringify({ BackendState:'Running', MagicDNSSuffix:'tail1234.ts.net', Self:{ DNSName:'macbook.tail1234.ts.net.' } }), stderr:'' }),
  });
  assert.equal(running.installed, true);
  assert.equal(running.running, true);
  assert.equal(running.hostname, 'macbook.tail1234.ts.net');
  assert.equal(running.url, 'https://macbook.tail1234.ts.net');

  const stopped = await probeTailscale({
    fresh:true,
    bin:'/usr/local/bin/tailscale',
    run:async () => ({ ok:true, stdout:JSON.stringify({ BackendState:'Stopped', Self:{ DNSName:'' } }), stderr:'' }),
  });
  assert.equal(stopped.installed, true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.url, '');
});

test('remoteStore saves config, hides tokens in publicConfig, supports env overrides and tracks status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-remote-'));
  try {
    const store = remoteStore(dir, { env:{} });
    assert.equal(store.publicConfig().mode, 'auto');
    assert.throws(() => store.saveConfig({ mode:'cloudflare', cloudflare:{ hostname:'shed.example.com' } }), /token/i);
    assert.throws(() => store.saveConfig({ mode:'custom', customUrl:'http://insecure.example.com' }), /https/i);

    const saved = store.saveConfig({ mode:'cloudflare', cloudflare:{ hostname:'shed.example.com', token:'secret-token-123' } });
    assert.equal(saved.mode, 'cloudflare');
    assert.equal(saved.cloudflare.hostname, 'shed.example.com');
    assert.equal(saved.cloudflare.hasToken, true);
    assert.equal(saved.cloudflare.token, undefined, 'raw token must never leak to publicConfig');

    // Keeping hostname without re-entering token preserves the saved token.
    store.saveConfig({ mode:'cloudflare', cloudflare:{ hostname:'dev.example.com' } });
    assert.equal(store.readConfig().cloudflare.token, 'secret-token-123');

    store.writeStatus({ mode:'cloudflare', state:'connected', url:'https://dev.example.com', permanent:true, detail:'Connected' });
    assert.equal(store.url(), 'https://dev.example.com');
    assert.equal(fs.readFileSync(store.urlFile, 'utf8').trim(), 'https://dev.example.com');

    // Custom mode immediately reports connected without needing tunnel.js.
    store.saveConfig({ mode:'custom', customUrl:'https://proxy.example.com/' });
    const customStatus = store.readStatus();
    assert.equal(customStatus.state, 'connected');
    assert.equal(customStatus.permanent, true);
    assert.equal(customStatus.url, 'https://proxy.example.com');

    // Off mode reports off with empty url.
    store.saveConfig({ mode:'off' });
    assert.equal(store.readStatus().state, 'off');
    assert.equal(store.url(), '');

    // Environment override takes precedence cleanly.
    const envStore = remoteStore(dir, { env:{ SHED_PUBLIC_URL:'https://env.example.com' } });
    assert.equal(envStore.publicConfig().envOverride, true);
    assert.equal(envStore.url(), 'https://env.example.com');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
