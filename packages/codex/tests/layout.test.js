/** Canonical multi-repository task layout plus legacy records and checkout safety. */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repository baselines, task and sub-workspace contexts retain lifecycle and legacy safety', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-layout-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outside-')));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (args, reject = false, cwd = root) => {
    const result = spawnSync(args[0], args.slice(1), { cwd, env, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    if (reject) { expect(result.status, output).not.toBe(0); if (typeof reject === 'string') expect(output).toContain(reject); }
    else expect(result.status, output).toBe(0);
    return result.stdout.trim();
  };
  const git = (repo, ...args) => run(['git', ...args], false, repo);
  const harness = (...args) => run([process.execPath, path.join(source, 'harness.js'), ...args]);
  const work = (...args) => run([process.execPath, path.join(root, '.harness/runtime/work.js'), ...args]);
  const denied = (...args) => run([process.execPath, path.join(root, '.harness/runtime/work.js'), ...args], true);
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const front = path.join(root, 'repository/frontend'), back = path.join(root, 'repository/backend'), reserved = path.join(root, 'repository/evidence'), reservedCase = path.join(root, 'repository/case-reserved');
  const task = path.join(root, 'work/feature-a'), record = path.join(task, 'task.md'), sub = path.join(task, '.sub-workspace/ui'), worker = path.join(sub, 'frontend');
  const mutate = transform => {
    const text = fs.readFileSync(record, 'utf8');
    const json = text.match(/<!-- own-harness-work:v1 -->\n```json\n([\s\S]*?)\n```/)[1];
    const data = JSON.parse(json); transform(data);
    fs.writeFileSync(record, text.replace(json, () => JSON.stringify(data, null, 2)));
  };
  try {
    for (const baseline of [front, back, reserved, reservedCase]) {
      fs.mkdirSync(baseline, { recursive: true });
      git(baseline, 'init', '-q', '-b', 'main');
      git(baseline, 'config', 'user.name', 'Fixture'); git(baseline, 'config', 'user.email', 'fixture@example.invalid');
      put(path.join(baseline, 'code.txt'), 'original\n'); git(baseline, 'add', '.'); git(baseline, 'commit', '-qm', 'initial');
    }
    harness('install', root, '--repo', 'frontend=repository/frontend', '--repo', 'backend=repository/backend', '--repo', 'evidence=repository/evidence', '--repo', 'rEpOs=repository/case-reserved');
    const external = path.join(outside, 'work/external/frontend'); fs.mkdirSync(path.dirname(external), { recursive: true });
    git(front, 'worktree', 'add', '-b', 'codex/external', external, 'main');
    denied('init', 'external', '--cwd', external, '--base', 'main');
    git(front, 'worktree', 'remove', external);
    for (const [name, baseline] of [['evidence', reserved], ['rEpOs', reservedCase]]) {
      const collision = path.join(root, 'work/reserved', name); fs.mkdirSync(path.dirname(collision), { recursive: true });
      git(baseline, 'worktree', 'add', '-b', 'codex/manual-reserved', collision, 'main');
      run([process.execPath, path.join(root, '.harness/harness.js'), 'prepare', collision], 'reserved repository name');
      denied('init', 'reserved', '--cwd', collision, '--base', 'main');
      expect(fs.existsSync(path.join(root, 'work/reserved/task.md'))).toBe(false);
      git(baseline, 'worktree', 'remove', collision); fs.rmdirSync(path.dirname(collision));
    }
    denied('start', 'reserved-case', '--repo', 'rEpOs', '--base', 'main', '--branch', 'codex/reserved-case');
    expect(fs.existsSync(path.join(root, 'work/reserved-case'))).toBe(false);
    denied('start', 'reserved', '--repo', 'evidence', '--base', 'main', '--branch', 'codex/reserved');
    expect(fs.existsSync(path.join(root, 'work/reserved'))).toBe(false);
    for (const repo of ['frontend', 'backend']) work('start', 'feature-a', '--repo', repo, '--base', 'main', '--branch', 'codex/feature-a');
    expect(fs.existsSync(record)).toBe(true);
    expect(fs.existsSync(path.join(task, 'repos'))).toBe(false);
    fs.writeFileSync(record, fs.readFileSync(record, 'utf8').replaceAll('작성 필요', '두 저장소 경로와 작업 context를 검증한다'));
    for (const phase of ['research', 'design']) work('record', 'feature-a', phase, '--evidence', '실제 fixture 구조와 Git 등록을 확인했다');
    work('fork', 'feature-a', 'ui', '--repo', 'frontend', '--owner', 'builder', '--scope', 'code.txt');
    const targets = [root, front, back, reserved, reservedCase, task, path.join(task, 'frontend'), path.join(task, 'backend'), sub, worker];
    for (const target of targets) for (const file of ['.codex/hooks.json', '.agents/skills/pstack-codex/SKILL.md', 'AGENTS.override.md']) expect(fs.existsSync(path.join(target, file))).toBe(true);
    work('check', '--cwd', worker);
    denied('check', '--cwd', worker, '--publish');
    const original = fs.readFileSync(record, 'utf8');
    for (const change of [data => data.workers.ui.repo = 'backend', data => data.workers.ui.checkout = path.join(task, 'frontend'), data => data.workers.ui.branch = 'main']) {
      mutate(change); denied('check', '--cwd', worker); fs.writeFileSync(record, original);
    }
    for (const legacy of [path.join(task, 'WORK.md'), path.join(root, '.harness/private/work/feature-a/WORK.md')]) {
      put(legacy, original); denied('status', 'feature-a'); fs.unlinkSync(legacy);
      fs.renameSync(record, legacy); expect(work('status', 'feature-a')).toContain(legacy); work('check', '--cwd', worker);
      expect(fs.existsSync(record)).toBe(false); fs.renameSync(legacy, record);
    }
    const publicFile = path.join(root, 'public.txt');
    for (const text of ['work/feature-a/state.json', 'work/feature-a/task.md', 'work/feature-a/frontend', 'work/feature-a/backend/code.txt', 'work/feature-a/.sub-workspace/ui/frontend']) {
      put(publicFile, text); denied('public-text', publicFile);
      const checkPrivacy = `import * as guard from ${JSON.stringify(path.join(root, '.harness/runtime/pr-guard.js'))}; import * as hook from ${JSON.stringify(path.join(root, '.harness/runtime/work-hook.js'))}; const value = ${JSON.stringify(text)}; if (!hook.internal_path(value)) throw new Error('private path missed'); try { guard.reject_internal_metadata(value); } catch { process.exit(0); } throw new Error('PR privacy missed');`;
      run([process.execPath, '-e', checkPrivacy]);
    }
    put(publicFile, '일반 소스 work/foo.js 및 work/feature-a/handler.js'); work('public-text', publicFile);
    // Legacy nested checkout and reserved repository mappings can still resume an existing registration.
    const old = path.join(root, 'work/old/repos/evidence'); fs.mkdirSync(path.dirname(old), { recursive: true });
    git(reserved, 'worktree', 'add', '-b', 'codex/old', old, 'main'); work('init', 'old', '--cwd', old, '--base', 'main');
    const oldRecord = path.join(root, 'work/old/task.md'); fs.renameSync(oldRecord, path.join(root, 'work/old/WORK.md'));
    work('start', 'old', '--repo', 'evidence', '--base', 'main', '--branch', 'codex/old'); expect(fs.existsSync(oldRecord)).toBe(false);
    // A previously registered worker remains valid at the old .worktrees location.
    const legacyWorker = path.join(task, '.worktrees/ui'); fs.mkdirSync(path.dirname(legacyWorker), { recursive: true });
    git(front, 'worktree', 'move', worker, legacyWorker);
    // The fixture emulates an old checkout; moved managed context is not adopted as unowned input.
    for (const local of ['.codex', '.agents', 'AGENTS.override.md']) fs.rmSync(path.join(legacyWorker, local), { recursive: true, force: true });
    mutate(data => data.workers.ui.checkout = legacyWorker);
    work('check', '--cwd', legacyWorker);
    harness('update', root); expect(JSON.parse(harness('doctor', root)).status).toBe('ok');
    expect(fs.existsSync(path.join(sub, '.codex/hooks.json'))).toBe(true);
    // The child context is retained after checkout removal, then removed by uninstall.
    harness('uninstall', root);
    for (const target of targets.filter(value => value !== worker)) expect(fs.existsSync(path.join(target, '.codex/hooks.json'))).toBe(false);
    expect(fs.existsSync(record)).toBe(true); expect(fs.existsSync(legacyWorker)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
}, 120000);
