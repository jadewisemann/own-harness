/** Temporary Git fixtures only: bun test tests/install.test.js. */
import { afterEach, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as harness from '../harness.js';

const SOURCE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Real Git subprocess fixtures can exceed Bun's short default timeout.
const test = (name, body) => bunTest(name, body, 30000);
function git(repo, ...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {};
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (options.check !== false && result.status !== 0) throw new Error(result.stderr);
  return result;
}
function put(p, data, mode = 0o644) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); fs.chmodSync(p, mode); }
function tree_state(root) {
  const result = {};
  function walk(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (item.name === '.git') continue;
      const p = path.join(folder, item.name);
      if (item.isDirectory()) walk(p);
      else if (item.isFile()) result[path.relative(root, p)] = harness.snapshot(p);
    }
  }
  walk(root); return result;
}
function repo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture Author'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  put(path.join(root, 'code.txt'), 'initial\n'); git(root, 'add', 'code.txt'); git(root, 'commit', '-m', 'initial');
  return root;
}

// Preserve the original Python installation format without requiring Python at runtime.
function simulate_legacy(root, { original = null } = {}) {
  const manifest = harness.load_manifest(root), manifest_path = path.join(root, '.harness/private/install.json');
  const pairs = [['harness.js', 'harness.py'], ['runtime/harness_common.js', 'runtime/harness_common.py'], ['runtime/work.js', 'runtime/work.py'], ['runtime/work-hook.js', 'runtime/work-hook.py'], ['runtime/check-workspace.js', 'runtime/check-workspace'], ['runtime/pr-guard.js', 'runtime/pr-guard.py']];
  for (const [current, legacy] of pairs) {
    const current_path = path.join(root, '.harness', current), legacy_path = path.join(root, '.harness', legacy);
    fs.unlinkSync(current_path); delete manifest.files[current_path];
    put(legacy_path, `# old managed ${legacy}\n`);
    manifest.files[legacy_path] = { original: legacy === 'harness.py' ? original : null, installed: harness.digest(harness.snapshot(legacy_path)) };
  }
  put(manifest_path, harness.json_bytes(manifest), 0o600);
}

describe('installation', () => {
  let base, home, package_root, root, old_env;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own harness 한글 ')));
    home = path.join(base, 'home'); fs.mkdirSync(home);
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    old_env = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
    package_root = path.join(base, 'package');
    for (const relative of harness.PAYLOAD) {
      const actual = path.join(SOURCE, relative), data = fs.existsSync(actual) ? fs.readFileSync(actual) : `// fixture ${relative}\n`;
      put(path.join(package_root, relative), data, ['harness.js', 'runtime/check-workspace.js'].includes(relative) ? 0o755 : 0o644);
    }
    put(path.join(package_root, 'templates/AGENTS.fragment.md'), 'Run `{{HARNESS_ROOT}}/.harness/runtime/work.js`.\n');
    put(path.join(package_root, 'not-distributed-private.txt'), 'must not be copied');
    root = repo(path.join(base, 'workspace 공백'));
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(old_env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const install = (options = {}, workspace = root) => harness.install(workspace, package_root, options);

  test('explicit legacy work adoption preserves existing tracked records but refuses new tracked task data', () => {
    const record = path.join(root, 'work/old/WORK.md'); put(record, 'historical record');
    git(root, 'add', 'work'); git(root, 'commit', '-m', 'history');
    expect(() => install()).toThrow('tracked workspace work');
    install({ adopt_legacy_work: true });
    expect(harness.load_manifest(root).legacy_work).toEqual(['work/old/WORK.md']);
    install({ update: true });
    expect(fs.readFileSync(record, 'utf8')).toBe('historical record');
    put(path.join(root, 'work/new/task.md'), 'new private record'); git(root, 'add', '-f', 'work/new/task.md');
    expect(() => install({ update: true })).toThrow('tracked workspace work');
    git(root, 'reset', '--', 'work/new/task.md');
    harness.uninstall(root); expect(fs.readFileSync(record, 'utf8')).toBe('historical record');
  });

  test('round trip and update preserve first values', () => {
    const old_hooks = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo fixture' }] }] }, other: 3 };
    put(path.join(root, '.codex/hooks.json'), JSON.stringify(old_hooks) + '\n', 0o640);
    put(path.join(root, '.codex/config.toml'), '# keep\n[other]\nx = 1\n[memories]\nuse_memories = true # keep\n', 0o640);
    put(path.join(root, 'AGENTS.md'), 'Existing tracked instructions.\n', 0o640);
    put(path.join(root, 'AGENTS.override.md'), 'Existing local instructions.\n', 0o640);
    git(root, 'add', 'AGENTS.md'); git(root, 'commit', '-m', 'instructions');
    fs.mkdirSync(path.join(root, '.husky')); git(root, 'config', '--local', 'core.hooksPath', '.husky');
    const before = tree_state(root), exclude = harness.snapshot(path.join(root, '.git/info/exclude'));
    install(); const installed = tree_state(root);
    expect(git(root, 'status', '--short').stdout).toBe('');
    install(); expect(tree_state(root)).toEqual(installed);
    expect(fs.existsSync(path.join(root, '.harness/not-distributed-private.txt'))).toBe(false);
    expect(harness.doctor(root).status).toBe('ok');
    put(path.join(package_root, 'runtime/work.js'), '// fixture next revision\n');
    expect(() => install()).toThrow('use update');
    install({ update: true });
    expect(harness.load_manifest(root).git.project.original_local).toEqual(['.husky']);
    harness.uninstall(root);
    expect(tree_state(root)).toEqual(before);
    expect(harness.snapshot(path.join(root, '.git/info/exclude'))).toEqual(exclude);
    expect(git(root, 'config', '--local', '--get', 'core.hooksPath').stdout.trim()).toBe('.husky');
  });

  test('non-Git multi-repo, existing worktree, and installed prepare CLI', () => {
    const workspace = path.join(base, 'multi root'), api = repo(path.join(workspace, 'api')), web = repo(path.join(workspace, 'web'));
    const external = path.join(base, '.worktrees/old-task/service'); fs.mkdirSync(path.dirname(external), { recursive: true });
    git(api, 'worktree', 'add', '-b', 'old-task', external);
    install({ mapping: { service: 'api', web: 'web' } }, workspace);
    expect(fs.existsSync(path.join(workspace, '.codex/hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(external, '.agents/skills/pstack-codex/SKILL.md'))).toBe(true);
    const fresh = path.join(workspace, '.worktrees/new-task/web'); fs.mkdirSync(path.dirname(fresh), { recursive: true });
    git(web, 'worktree', 'add', '-b', 'new-task', fresh);
    expect(harness.doctor(workspace).unprepared_checkouts).toEqual([fresh]);
    const result = spawnSync(process.execPath, [path.join(workspace, '.harness/harness.js'), 'prepare', fresh], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(fresh, '.codex/config.toml'))).toBe(true);
    expect(harness.doctor(workspace).status).toBe('ok');
    harness.uninstall(workspace);
    expect(fs.existsSync(external)).toBe(true); expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(external, '.codex'))).toBe(false); expect(fs.existsSync(path.join(fresh, '.codex'))).toBe(false);
  });

  test('conflicts have no partial writes', () => {
    for (const [relative, data] of [['.codex/config.toml', '[hooks]\nvalue = 1\n'], ['.codex/config.toml', 'x = { a = 2 }\n'], ['.codex/config.toml', Buffer.from([0xff])], ['.codex/hooks.json', '[]'], ['.codex/hooks.json', '{"hooks":null}'], ['.codex/hooks.json', '{"hooks":{"PreToolUse":null}}'], ['AGENTS.override.md', harness.BEGIN + '\n']]) {
      put(path.join(root, relative), data); const before = tree_state(root);
      expect(() => install()).toThrow(); expect(tree_state(root)).toEqual(before); expect(fs.existsSync(path.join(root, '.harness'))).toBe(false);
      fs.unlinkSync(path.join(root, relative));
    }
    put(path.join(root, '.agents/skills/pstack-codex/user.txt'), 'existing skill'); const before = tree_state(root);
    expect(() => install()).toThrow('existing pstack'); expect(tree_state(root)).toEqual(before);
  });

  test('symlink and tracked local files reject before writing', () => {
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(root, '.codex'), 'dir');
    expect(() => install()).toThrow('symlink'); expect(fs.readdirSync(outside)).toEqual([]); fs.unlinkSync(path.join(root, '.codex'));
    put(path.join(root, '.codex/config.toml'), '[memories]\nuse_memories = true\n'); git(root, 'add', '.codex/config.toml');
    const before = tree_state(root); expect(() => install()).toThrow('tracked'); expect(tree_state(root)).toEqual(before);
  });

  test('drift blocks update, uninstall, and doctor', () => {
    install(); const p = path.join(root, '.codex/config.toml'); put(p, fs.readFileSync(p, 'utf8') + '# user change\n');
    const before = tree_state(root);
    for (const action of [() => install({ update: true }), () => harness.uninstall(root), () => harness.doctor(root)]) {
      expect(action).toThrow('drift'); expect(tree_state(root)).toEqual(before);
    }
  });

  test('existing empty directories survive', () => {
    for (const name of ['.codex', '.agents/skills']) fs.mkdirSync(path.join(root, name), { recursive: true });
    install(); harness.uninstall(root);
    expect(fs.existsSync(path.join(root, '.codex'))).toBe(true); expect(fs.existsSync(path.join(root, '.agents/skills'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.agents/skills/pstack-codex'))).toBe(false);
  });

  test('global hooks inheritance is restored', () => {
    const hooks = path.join(home, 'original hooks'); fs.mkdirSync(hooks); put(path.join(home, '.gitconfig'), '[core]\n\thooksPath = ' + hooks + '\n');
    install(); harness.uninstall(root);
    expect(git(root, 'config', '--get', 'core.hooksPath').stdout.trim()).toBe(hooks);
    expect(git(root, 'config', '--local', '--get', 'core.hooksPath', { check: false }).status).toBe(1);
  });

  test('duplicate and worktree hook overrides reject', () => {
    git(root, 'config', '--add', 'core.hooksPath', 'one'); git(root, 'config', '--add', 'core.hooksPath', 'two');
    expect(() => install()).toThrow('multiple'); expect(fs.existsSync(path.join(root, '.harness'))).toBe(false);
    git(root, 'config', '--unset-all', 'core.hooksPath'); git(root, 'config', 'extensions.worktreeConfig', 'true'); git(root, 'config', '--worktree', 'core.hooksPath', 'other');
    expect(() => install()).toThrow('override'); expect(fs.existsSync(path.join(root, '.harness'))).toBe(false);
  });

  test('failed second repository Git write rolls back everything', () => {
    const workspace = path.join(base, 'rollback root'), first = repo(path.join(workspace, 'first')), second = repo(path.join(workspace, 'second'));
    // A real config lock fails only the second settings write, after the first succeeded.
    put(path.join(second, '.git/config.lock'), 'fixture lock');
    const before = tree_state(workspace), excludes = [first, second].map(p => harness.snapshot(path.join(p, '.git/info/exclude')));
    expect(() => install({ mapping: { one: 'first', two: 'second' } }, workspace)).toThrow('lock');
    expect(tree_state(workspace)).toEqual(before); expect(fs.existsSync(path.join(workspace, '.harness'))).toBe(false);
    for (const [index, p] of [first, second].entries()) { expect(harness.snapshot(path.join(p, '.git/info/exclude'))).toEqual(excludes[index]); expect(harness.values(p, '--local')).toEqual([]); }
  });

  test('ignore negation rolls back', () => {
    put(path.join(root, '.gitignore'), '!/.codex/\n!/.codex/config.toml\n'); const before = tree_state(root), exclude = harness.snapshot(path.join(root, '.git/info/exclude'));
    expect(() => install()).toThrow('not excluded'); expect(tree_state(root)).toEqual(before); expect(harness.snapshot(path.join(root, '.git/info/exclude'))).toEqual(exclude);
  });

  test('private state survives but PR approvals do not', () => {
    install(); const private_dir = path.join(root, '.harness/private');
    put(path.join(private_dir, 'work/task/WORK.md'), 'private fixture\n'); put(path.join(private_dir, 'work-control/task.json'), '{"mode":"human"}\n');
    put(path.join(private_dir, 'pr-approvals/fixture.json'), '{"approved":true}\n'); put(path.join(private_dir, 'pr-approvals/fixture.lock'), '');
    install({ update: true }); expect(fs.existsSync(path.join(private_dir, 'pr-approvals/fixture.json'))).toBe(false);
    expect(fs.readFileSync(path.join(private_dir, 'work-control/task.json'), 'utf8')).toBe('{"mode":"human"}\n');
    harness.uninstall(root); expect(fs.existsSync(path.join(private_dir, 'work/task/WORK.md'))).toBe(true);
    expect(git(root, 'check-ignore', '.harness/private/work/task/WORK.md').status).toBe(0);
    install(); expect(fs.existsSync(path.join(private_dir, 'work/task/WORK.md'))).toBe(true);
  });

  test('newly tracked local files block removal', () => {
    install(); git(root, 'add', '-f', '.codex/config.toml'); expect(() => harness.uninstall(root)).toThrow('tracked');
    expect(fs.existsSync(path.join(root, '.codex/config.toml'))).toBe(true);
  });

  test('Git-owned root must be explicitly mapped', () => {
    repo(path.join(root, 'api')); const before = tree_state(root);
    expect(() => install({ mapping: { api: 'api' } })).toThrow('Git-owned workspace'); expect(tree_state(root)).toEqual(before);
    const nested = path.join(root, 'nested'); repo(path.join(nested, 'other'));
    expect(() => install({ mapping: { other: 'other' } }, nested)).toThrow('Git-owned workspace'); expect(fs.existsSync(path.join(nested, '.harness'))).toBe(false);
  });

  test('removed worktrees do not block update or uninstall', () => {
    const old = path.join(base, '.worktrees/removed/project'); fs.mkdirSync(path.dirname(old), { recursive: true });
    git(root, 'worktree', 'add', '-b', 'removed', old); install(); git(root, 'worktree', 'remove', old);
    expect(harness.doctor(root).status).toBe('ok'); install({ update: true });
    expect(Object.keys(harness.load_manifest(root).files).some(p => p.includes(old))).toBe(false);
    harness.uninstall(root); expect(fs.existsSync(old)).toBe(false);
  });

  test('TOML preserves comments and CRLF', () => {
    expect(harness.memory_config('[memories]\r\nuse_memories = true # preserve\r\n')).toBe('[memories]\r\nuse_memories = false # preserve\r\n');
    expect(harness.memory_config('')).toBe('[memories]\nuse_memories = false\n');
  });

  test('legacy Python payload migrates only through update and restores originals', () => {
    const before = tree_state(root); install();
    const original = harness.encoded('original user script\n', 0o640); simulate_legacy(root, { original });
    expect(() => install()).toThrow('use update'); install({ update: true });
    expect(fs.readFileSync(path.join(root, '.harness/harness.py'), 'utf8')).toBe('original user script\n');
    expect(fs.existsSync(path.join(root, '.harness/runtime/work.py'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.harness/runtime/work.js'))).toBe(true);
    expect(Object.keys(harness.load_manifest(root).files).some(p => p.endsWith('.py'))).toBe(false);
    expect(harness.doctor(root).status).toBe('ok');
    const hook = fs.readFileSync(path.join(root, '.harness/private/hooks/project/pre-commit'), 'utf8');
    expect(hook).toContain(process.execPath); expect(hook).toContain('work-hook.js'); expect(hook).not.toContain('python3');
    harness.uninstall(root);
    expect(tree_state(root)).toEqual({ ...before, '.harness/harness.py': original });
  });

  test('legacy payload drift stops migration before any writes', () => {
    install(); simulate_legacy(root); put(path.join(root, '.harness/runtime/work.py'), '# user change\n');
    const before = tree_state(root); expect(() => install({ update: true })).toThrow('drift'); expect(tree_state(root)).toEqual(before);
  });

  test('legacy migration rolls back removed files on a verification failure', () => {
    install(); simulate_legacy(root); put(path.join(root, '.gitignore'), '!/.codex/\n!/.codex/config.toml\n');
    const before = tree_state(root); expect(() => install({ update: true })).toThrow('not excluded'); expect(tree_state(root)).toEqual(before);
  });

  test('preparing an integration checkout installs task context and preserves task records', () => {
    install();
    const task = path.join(root, 'work/feature'), checkout = path.join(task, 'repos/project');
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    git(root, 'worktree', 'add', '-b', 'feature', checkout);
    expect(harness.doctor(root).unprepared_task_roots).toEqual([task]);
    install({ selected: checkout });
    for (const relative of ['.codex/config.toml', '.codex/hooks.json', '.agents/skills/pstack-codex/SKILL.md', 'AGENTS.override.md']) {
      expect(fs.existsSync(path.join(task, relative))).toBe(true);
      expect(fs.existsSync(path.join(checkout, relative))).toBe(true);
    }
    expect(fs.existsSync(path.join(task, 'WORK.md'))).toBe(false);
    expect(fs.existsSync(path.join(task, 'agents'))).toBe(false);
    expect(harness.load_manifest(root).task_roots).toEqual([task]);
    expect(harness.load_manifest(root).checkouts[task]).toBeNull();
    expect(harness.doctor(root).status).toBe('ok');
    put(path.join(task, 'WORK.md'), 'task contract stays here\n', 0o600);
    put(path.join(task, 'evidence/design.md'), 'task evidence stays here\n', 0o600);
    expect(git(root, 'status', '--short').stdout).toBe('');
    install({ update: true });
    const result = harness.uninstall(root);
    expect(result.retained_excludes).toContain('/work/');
    expect(fs.readFileSync(path.join(task, 'WORK.md'), 'utf8')).toBe('task contract stays here\n');
    expect(fs.readFileSync(path.join(task, 'evidence/design.md'), 'utf8')).toBe('task evidence stays here\n');
    expect(fs.existsSync(path.join(task, '.codex'))).toBe(false);
    expect(fs.existsSync(path.join(task, 'AGENTS.override.md'))).toBe(false);
    expect(fs.existsSync(checkout)).toBe(true);
    expect(git(root, 'check-ignore', 'work/feature/WORK.md').status).toBe(0);
  });

  test('prepare accepts only task roots proven by a registered checkout', () => {
    install();
    for (const relative of ['arbitrary', 'work/not-registered']) {
      const folder = path.join(root, relative); fs.mkdirSync(folder, { recursive: true });
      const before = tree_state(root);
      expect(() => install({ selected: folder })).toThrow('registered checkout or its task root');
      expect(tree_state(root)).toEqual(before);
    }
    const task = path.join(root, 'work/proven'), checkout = path.join(task, 'repos/project');
    fs.mkdirSync(path.dirname(checkout), { recursive: true }); git(root, 'worktree', 'add', '-b', 'proven', checkout);
    const result = spawnSync(process.execPath, [path.join(root, '.harness/harness.js'), 'prepare', task], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(task, '.codex/hooks.json'))).toBe(true);
    expect(harness.doctor(root).unprepared_checkouts).toEqual([checkout]);
    install({ selected: checkout }); expect(harness.doctor(root).status).toBe('ok');
  });

  test('worker checkout prepares its owning task root without requiring a WORK file', () => {
    install();
    const task = path.join(root, 'work/parallel'), checkout = path.join(task, '.worktrees/reviewer');
    fs.mkdirSync(path.dirname(checkout), { recursive: true }); git(root, 'worktree', 'add', '-b', 'reviewer', checkout);
    install({ selected: checkout });
    expect(fs.existsSync(path.join(task, '.agents/skills/pstack-codex/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(checkout, '.codex/hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(task, 'WORK.md'))).toBe(false);
    expect(harness.doctor(root).status).toBe('ok');
  });

  test('unowned task context collisions fail before writing and managed drift still blocks', () => {
    install();
    const task = path.join(root, 'work/collision'), checkout = path.join(task, 'repos/project');
    fs.mkdirSync(path.dirname(checkout), { recursive: true }); git(root, 'worktree', 'add', '-b', 'collision', checkout);
    for (const relative of ['.codex/config.toml', '.codex/hooks.json', 'AGENTS.override.md']) {
      put(path.join(task, relative), relative.endsWith('.json') ? '{}' : '# existing local context\n');
      const before = tree_state(root);
      expect(() => install({ selected: checkout })).toThrow('unowned file');
      expect(tree_state(root)).toEqual(before);
      fs.unlinkSync(path.join(task, relative));
    }
    install({ selected: checkout });
    fs.appendFileSync(path.join(task, 'AGENTS.override.md'), '\nUser changes\n');
    const before = tree_state(root);
    for (const action of [() => install({ update: true }), () => harness.uninstall(root), () => harness.doctor(root)]) {
      expect(action).toThrow('drift'); expect(tree_state(root)).toEqual(before);
    }
  });

  test('archived task contexts survive checkout removal and retire after the task folder disappears', () => {
    install();
    const task = path.join(root, 'work/archive'), checkout = path.join(task, 'repos/project');
    fs.mkdirSync(path.dirname(checkout), { recursive: true }); git(root, 'worktree', 'add', '-b', 'archive', checkout);
    install({ selected: checkout }); put(path.join(task, 'WORK.md'), 'archived work\n');
    git(root, 'worktree', 'remove', checkout);
    expect(harness.doctor(root).status).toBe('ok');
    install({ update: true });
    expect(fs.existsSync(path.join(task, '.codex/hooks.json'))).toBe(true);
    expect(harness.load_manifest(root).task_roots).toEqual([task]);
    expect(() => install({ selected: task })).toThrow('registered checkout or its task root');
    fs.rmSync(task, { recursive: true });
    expect(harness.doctor(root).status).toBe('ok');
    install({ update: true });
    expect(harness.load_manifest(root).task_roots).toEqual([]);
    expect(Object.keys(harness.load_manifest(root).files).some(p => p.startsWith(task + path.sep))).toBe(false);
    harness.uninstall(root);
  });

  test('only a workspace-root baseline excludes work and tracked root work is refused', () => {
    const workspace = path.join(base, 'multiple baselines'), api = repo(path.join(workspace, 'api')), web = repo(path.join(workspace, 'web'));
    put(path.join(api, 'work/source.js'), 'export const legitimate = true;\n');
    git(api, 'add', 'work/source.js'); git(api, 'commit', '-m', 'legitimate source directory');
    install({ mapping: { api: 'api', web: 'web' } }, workspace);
    const task = path.join(workspace, 'work/example'), checkout = path.join(task, 'repos/api');
    fs.mkdirSync(path.dirname(checkout), { recursive: true }); git(api, 'worktree', 'add', '-b', 'example', checkout);
    install({ selected: checkout }, workspace);
    for (const baseline of [api, web]) {
      expect(fs.readFileSync(path.join(baseline, '.git/info/exclude'), 'utf8').split('\n')).not.toContain('/work/');
      expect(git(baseline, 'check-ignore', '--no-index', 'work/new-source.js', { check: false }).status).toBe(1);
    }
    expect(harness.doctor(workspace).status).toBe('ok');
    harness.uninstall(workspace);
    expect(fs.existsSync(path.join(api, 'work/source.js'))).toBe(true);
    for (const baseline of [api, web]) expect(fs.readFileSync(path.join(baseline, '.git/info/exclude'), 'utf8').split('\n')).not.toContain('/work/');
    put(path.join(root, 'work/existing-source.js'), 'tracked source\n'); git(root, 'add', 'work/existing-source.js');
    const before = tree_state(root);
    expect(() => install()).toThrow('tracked workspace work directory');
    expect(tree_state(root)).toEqual(before);
  });

  test('root work ignore negation rolls back the complete install', () => {
    put(path.join(root, '.gitignore'), '!/work/\n!/work/**\n');
    const before = tree_state(root), exclude = harness.snapshot(path.join(root, '.git/info/exclude'));
    expect(() => install()).toThrow('local task path is not excluded');
    expect(tree_state(root)).toEqual(before); expect(harness.snapshot(path.join(root, '.git/info/exclude'))).toEqual(exclude);
  });

  test('task context cannot overwrite context belonging to an unrelated nested Git repository', () => {
    install();
    const task = repo(path.join(root, 'work/nested')), checkout = path.join(task, 'repos/project');
    fs.mkdirSync(path.dirname(checkout), { recursive: true }); git(root, 'worktree', 'add', '-b', 'nested', checkout);
    const before = tree_state(root);
    expect(() => install({ selected: checkout })).toThrow('task context conflicts with an existing Git repository');
    expect(tree_state(root)).toEqual(before);
    expect(fs.existsSync(path.join(task, '.codex'))).toBe(false);
  });
  test('sub-workspace contexts reject Git ancestors, unowned files, symlinks and mismatched repos before writing', () => {
    install();
    const task = path.join(root, 'work/nested-worker'), sub = path.join(task, '.sub-workspace/reviewer'), checkout = path.join(sub, 'project');
    fs.mkdirSync(sub, { recursive: true }); git(root, 'worktree', 'add', '-b', 'nested-worker', checkout);
    for (const collision of [path.join(task, '.sub-workspace'), sub]) {
      git(collision, 'init', '-q');
      const before = tree_state(root);
      expect(() => install({ selected: checkout })).toThrow('task context conflicts');
      expect(tree_state(root)).toEqual(before);
      fs.rmSync(path.join(collision, '.git'), { recursive: true });
    }
    for (const relative of ['.codex/config.toml', '.codex/hooks.json', 'AGENTS.override.md']) {
      const file = path.join(sub, relative); put(file, relative.endsWith('.json') ? '{}' : '# user file');
      const before = tree_state(root);
      expect(() => install({ selected: checkout })).toThrow('unowned file'); expect(tree_state(root)).toEqual(before); fs.unlinkSync(file);
    }
    expect(() => harness.task_root_for(root, path.join(sub, 'wrong'), 'project')).toThrow('repository name');
    expect(() => harness.task_root_for(root, path.join(task, 'wrong'), 'project')).toThrow('repository name');
    for (const name of ['evidence', 'repos', 'Evidence', 'rEpOs']) expect(() => harness.task_root_for(root, path.join(task, name), name)).toThrow('reserved repository name');
    const link = path.join(task, '.sub-workspace/alias'); fs.symlinkSync(sub, link);
    expect(() => install({ selected: path.join(link, 'project') })).toThrow('registered checkout'); fs.unlinkSync(link);
    install({ selected: checkout });
    expect(harness.load_manifest(root).task_roots).toEqual([task, sub]);
    fs.appendFileSync(path.join(sub, 'AGENTS.override.md'), '\nchanged');
    expect(() => harness.doctor(root)).toThrow('drift');
  });

});
