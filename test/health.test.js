import test from 'node:test';
import assert from 'node:assert/strict';
import { startFailure } from '../server/health.js';

// What `codex --version` printed on 2026-11-04 after a Homebrew update replaced simdjson under node.
const dyld = `dyld[93377]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.30.dylib
  Referenced from: <08C01B68-B4C2-3C65-9E3F-168E88B062B7> /opt/homebrew/Cellar/node/25.6.1_1/bin/node
  Reason: tried: '/opt/homebrew/opt/simdjson/lib/libsimdjson.30.dylib' (no such file), '/System/Volumes/Preboot/Cryptexes/OS/opt/homebrew/opt/simdjson/lib/libsimdjson.30.dylib' (no such file), '/opt/homebrew/Cellar/simdjson/5.1.1/lib/libsimdjson.30.dylib' (no such file)`;

test('a missing library becomes one line naming the Homebrew fix', () => {
  assert.equal(startFailure(dyld), "Can't start: node is missing libsimdjson.30.dylib after a Homebrew update. Fix it with: brew upgrade node");
});

test('a missing library outside Homebrew still names the binary and library', () => {
  const detail = startFailure('dyld[1]: Library not loaded: @rpath/libfoo.2.dylib\n  Referenced from: <ABC> /usr/local/bin/tool\n  Reason: tried: …');
  assert.equal(detail, "Can't start: tool is missing libfoo.2.dylib. Reinstalling it usually fixes this.");
});

test('a crash keeps the error line, not the stack or the version footer', () => {
  const crash = `node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '/x/cli.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n\nNode.js v26.13.0`;
  assert.equal(startFailure(crash), "Error: Cannot find module '/x/cli.js'");
});

test('long and empty output stay readable', () => {
  assert.equal(startFailure(''), 'CLI did not respond');
  assert.equal(startFailure('x'.repeat(500)).length, 160);
  assert.equal(startFailure('\x1b[31mboom\x1b[0m'), 'boom');
});
