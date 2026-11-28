import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSimpleYaml, loadWorktreeConfig, safeRepoRel, applyWorktreeSetup, runWorktreeTeardown } from '../server/worktree-config.js';

function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-wtcfg-')));
  const g = (...args) => execFileSync('git', args, { cwd:dir, encoding:'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { dir, g };
}

test('parses flat and nested .shed.yaml configs', () => {
  const shedYaml = parseSimpleYaml(`
# Worktree hooks
copy:
  - .env
  - .env.local
symlink: [node_modules, .cache]
setup:
  - echo "ready"
teardown: echo "bye"
autoSymlink: false
`);
  assert.deepEqual(shedYaml.copy, ['.env', '.env.local']);
  assert.deepEqual(shedYaml.symlink, ['node_modules', '.cache']);
  assert.deepEqual(shedYaml.setup, ['echo "ready"']);
  assert.equal(shedYaml.teardown, 'echo "bye"');
  assert.equal(shedYaml.autoSymlink, false);

  const nestedYaml = parseSimpleYaml(`
worktree:
  copy:
    - .env
hooks:
  setup:
    - npm run prepare
  teardown: rm -f tmp.lock
`);
  assert.deepEqual(nestedYaml.worktree.copy, ['.env']);
  assert.deepEqual(nestedYaml.hooks.setup, ['npm run prepare']);
  assert.equal(nestedYaml.hooks.teardown, 'rm -f tmp.lock');
});

test('safeRepoRel blocks traversal and .git paths', () => {
  const root = '/tmp/project';
  assert.equal(safeRepoRel(root, '.env'), '.env');
  assert.equal(safeRepoRel(root, 'config/local.json'), path.join('config', 'local.json'));
  assert.equal(safeRepoRel(root, '../secrets'), '');
  assert.equal(safeRepoRel(root, '.git/config'), '');
  assert.equal(safeRepoRel(root, '.git'), '');
  assert.equal(safeRepoRel(root, 'a\0b'), '');
});

test('applyWorktreeSetup copies configured files, auto-symlinks gitignored node_modules, and runs setup & teardown hooks', async () => {
  const { dir } = gitRepo();
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-wt-dest-')));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=123\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'demo-pkg'), { recursive:true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'demo-pkg', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, '.shed.yaml'), `
worktree:
  copy:
    - .env
    - ../outside
hooks:
  setup:
    - 'printf "%s|%s" "$SHED_BRANCH" "$SHED_PROJECT" > .setup-ran'
  teardown:
    - 'printf "torn-down" > "$SHED_PROJECT/.teardown-ran"'
`);
    const cfg = loadWorktreeConfig(dir);
    assert.equal(cfg.source, '.shed.yaml');
    assert.deepEqual(cfg.copy, ['.env', '../outside']);

    const setup = await applyWorktreeSetup(dir, wt, 'shed/my-branch');
    assert.deepEqual(setup.copied, ['.env']);
    assert.deepEqual(setup.symlinked, ['node_modules']);
    assert.equal(setup.commands.length, 1);
    assert.equal(setup.commands[0].ok, true);
    assert.ok(setup.warnings.some(w => /unsafe copy path/i.test(w)));
    assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=123\n');
    assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(wt, '.setup-ran'), 'utf8'), `shed/my-branch|${dir}`);

    const td = await runWorktreeTeardown(dir, wt, 'shed/my-branch');
    assert.equal(td.ran.length, 1);
    assert.equal(td.ran[0].ok, true);
    assert.equal(fs.readFileSync(path.join(dir, '.teardown-ran'), 'utf8'), 'torn-down');
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
    fs.rmSync(wt, { recursive:true, force:true });
  }
});
