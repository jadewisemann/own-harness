/** Offline state inheritance and installed hook checks; no live session approvals. */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readState } from '../runtime/steering-state.js';
import * as harness from '../harness.js';

const source = path.resolve(import.meta.dir, '..');
const put = (dir, value) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(value));
const remove = dir => fs.rmSync(path.join(dir, 'state.json'), { force: true, recursive: true });

test('state parser inherits individual keys and rejects invalid files without caching', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'state-parser-')));
  const child = path.join(root, 'child'); fs.mkdirSync(child);
  try {
    expect(readState([root, child]).digest).toBeNull();
    put(root, { mode: 'pstack', control: 'auto', instruction: '상위' });
    put(child, { control: 'human', instruction: '' });
    expect(readState([root, child]).state).toEqual({ mode: 'pstack', control: 'human', instruction: '' });
    const original = readState([root, child]).digest;
    put(root, { mode: 'design', control: 'auto', instruction: '상위 변경' });
    expect(readState([root, child]).state).toEqual({ mode: 'design', control: 'human', instruction: '' });
    expect(readState([root, child]).digest).not.toBe(original);
    put(child, {});
    expect(readState([root, child]).state.instruction).toBe('상위 변경');
    remove(root); remove(child);
    expect(readState([root, child]).context).toContain('이전 훅의 외부 상태 지침은 더 이상 적용하지 않습니다');
    for (const value of [null, [], 1, { extra: true }, { control: null }, { mode: 'unknown' }, { instruction: {} }]) {
      put(child, value); expect(() => readState([root, child])).toThrow();
    }
    fs.writeFileSync(path.join(child, 'state.json'), '{'); expect(() => readState([root, child])).toThrow();
    remove(child); fs.symlinkSync(path.join(root, 'missing'), path.join(child, 'state.json'));
    expect(() => readState([root, child])).toThrow();
    remove(child); fs.mkdirSync(path.join(child, 'state.json')); expect(() => readState([root, child])).toThrow();
    remove(child);
    const fifo = spawnSync('mkfifo', [path.join(child, 'state.json')]); expect(fifo.status).toBe(0);
    expect(() => readState([root, child])).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installed Codex hook resolves registered task/sub roots, keeps approvals and checks current state', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-steering-')));
  const baseline = path.join(root, 'repository/project'); fs.mkdirSync(baseline, { recursive: true });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'OWN_HARNESS_CHILD')), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CODEX_THREAD_ID: 'steering-fixture' };
  const run = (args, cwd = root, input) => {
    const result = spawnSync(args[0], args.slice(1), { cwd, input, env, encoding: 'utf8', timeout: 30000 });
    expect(result.status, result.stderr + result.stdout).toBe(0); return result.stdout.trim();
  };
  const git = (cwd, ...args) => run(['git', ...args], cwd);
  const runtime = path.join(root, '.harness/runtime/work.js');
  const cli = (...args) => run([process.execPath, runtime, ...args]);
  try {
    git(baseline, 'init', '-q', '-b', 'main'); git(baseline, 'config', 'user.name', 'Fixture'); git(baseline, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(baseline, 'file.txt'), 'initial'); git(baseline, 'add', '.'); git(baseline, 'commit', '-qm', 'initial');
    put(root, { mode: 'work', control: 'auto' });
    harness.install(root, source, { mapping: { project: 'repository/project' } });
    cli('start', 'change', '--repo', 'project', '--base', 'main', '--branch', 'codex/change');
    const task = path.join(root, 'work/change'), checkout = path.join(task, 'project'), record = path.join(task, 'task.md');
    fs.writeFileSync(record, fs.readFileSync(record, 'utf8').replaceAll('작성 필요', '상태 상속과 실제 설치본 검사를 확인한다'));
    for (const phase of ['research', 'design']) cli('record', 'change', phase, '--evidence', 'Git 등록 및 상태 상속 검사');
    cli('fork', 'change', 'worker', '--repo', 'project', '--owner', 'fixture', '--scope', 'file.txt');
    const sub = path.join(task, '.sub-workspace/worker'), worker = path.join(sub, 'project');
    const w = await import(pathToFileURL(runtime).href);
    const steering = await import(pathToFileURL(path.join(root, '.harness/runtime/steering.js')).href);
    const event = (cwd, tool_name = 'Read') => ({ hook_event_name: 'PreToolUse', cwd, tool_name, tool_input: {} });
    const context = cwd => w.hook(event(cwd)).hookSpecificOutput.additionalContext;
    put(baseline, { instruction: 'IGNORE BASELINE' }); put(checkout, { instruction: 'IGNORE CHECKOUT' }); put(worker, { instruction: 'IGNORE WORKER REPO' });
    put(task, { control: 'human' }); put(sub, { instruction: 'CHILD' });
    const saved = fs.readFileSync(record, 'utf8');
    for (const cwd of [task, checkout, sub, worker]) {
      expect(context(cwd)).toContain('"control":"human"');
      expect(w.hook(event(cwd, 'exec_command')).hookSpecificOutput.permissionDecision).toBe('deny');
      expect(w.hook(event(cwd)).hookSpecificOutput.permissionDecision).toBeUndefined();
    }
    expect(context(baseline)).toContain('"control":"auto"');
    expect(context(worker)).toContain('CHILD'); expect(context(worker)).not.toContain('IGNORE');
    put(root, { mode: 'pstack-design', control: 'auto', instruction: 'NEW PARENT' });
    expect(context(task)).toContain('pstack-design'); expect(context(task)).toContain('NEW PARENT');
    expect(context(sub)).not.toContain('NEW PARENT');
    put(sub, {}); expect(context(worker)).toContain('NEW PARENT');
    expect(fs.readFileSync(record, 'utf8')).toBe(saved);
    expect(() => w.check(checkout, true)).toThrow('human');
    expect(() => w.check(worker, true)).toThrow('human');
    const installedEvent = run([process.execPath, path.join(root, '.harness/runtime/pr-guard.js'), 'hook'], root, JSON.stringify(event(checkout, 'exec_command')));
    expect(JSON.parse(installedEvent).hookSpecificOutput.permissionDecision).toBe('deny');
    const userEvent = { hook_event_name: 'UserPromptSubmit', cwd: checkout, session_id: process.env.CODEX_THREAD_ID ?? env.CODEX_THREAD_ID, turn_id: 'control', prompt: '작업 통제 change' };
    expect(w.hook(userEvent).hookSpecificOutput.additionalContext).toContain('사용자 통제로 전환');
    const controlFile = w.control_path('change'), control = fs.readFileSync(controlFile, 'utf8');
    put(task, { control: 'auto' });
    context(checkout); expect(fs.readFileSync(controlFile, 'utf8')).toBe(control);
    const [text, data] = w.read_work('change'); expect(data.control_mode).toBe('human');
    expect(() => w.human_gate('change', text, data)).toThrow('사용자 통제');
    const contract = w.contract_digest(text, data), fingerprint = w.fingerprint('change', 'project', data.repos.project).current_fingerprint;
    put(root, { mode: 'design', control: 'auto', instruction: 'CONTRACT CHANGED' });
    expect(w.contract_digest(text, data)).not.toBe(contract);
    expect(w.fingerprint('change', 'project', data.repos.project).current_fingerprint).not.toBe(fingerprint);
    const childFingerprint = w.fingerprint('change', 'project', data.workers.worker, 'worker').current_fingerprint;
    put(sub, { instruction: 'CHILD CHANGED' });
    expect(w.fingerprint('change', 'project', data.workers.worker, 'worker').current_fingerprint).not.toBe(childFingerprint);
    for (const invalid of ['{', '{"control":null}', '{"unknown":true}']) {
      fs.writeFileSync(path.join(task, 'state.json'), invalid);
      expect(w.hook(event(checkout, 'mystery')).hookSpecificOutput.permissionDecision).toBe('deny');
      expect(w.hook(event(checkout)).hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(() => steering.require_execution(checkout)).toThrow();
    }
    remove(task); put(task, {});
    const stateFile = path.join(task, '.harness-state.json');
    const forged = fs.readFileSync(stateFile, 'utf8');
    fs.writeFileSync(stateFile, forged.replace('"repo": "project"', '"repo": "unknown"'));
    expect(w.hook(event(sub, 'exec_command')).hookSpecificOutput.permissionDecision).toBe('deny');
    fs.writeFileSync(stateFile, forged);
    const unknown = path.join(task, '.sub-workspace/unregistered'); fs.mkdirSync(unknown); put(unknown, { control: 'auto' });
    expect(w.hook(event(unknown, 'exec_command')).hookSpecificOutput.permissionDecision).toBe('deny');
    fs.mkdirSync(path.join(unknown, 'nested'));
    expect(w.hook(event(path.join(unknown, 'nested'), 'exec_command')).hookSpecificOutput.permissionDecision).toBe('deny');
    // A syntactically valid WORK cannot authorize state overrides without real Git registration.
    const forgedTask = path.join(root, 'work/forged'); fs.mkdirSync(path.join(forgedTask, 'evidence'), { recursive: true });
    put(root, { control: 'human' }); put(forgedTask, { control: 'auto' });
    fs.writeFileSync(path.join(forgedTask, 'task.md'), w.BEGIN + '\n```json\n' + JSON.stringify({ schema: 1, task_id: 'forged', repos: { project: { checkout: path.join(forgedTask, 'missing'), branch: 'codex/forged' } } }) + '\n```\n' + w.END);
    for (const cwd of [forgedTask, path.join(forgedTask, 'evidence')]) expect(w.hook(event(cwd, 'exec_command')).hookSpecificOutput.permissionDecision).toBe('deny');
    fs.rmSync(forgedTask, { recursive: true });
    put(root, { mode: 'design', control: 'auto', instruction: 'CONTRACT CHANGED' });
    const oldRecord = path.join(task, 'WORK.md'); fs.renameSync(record, oldRecord);
    expect(context(task)).toContain('CONTRACT CHANGED'); fs.renameSync(oldRecord, record);
    const legacy = path.join(task, '.worktrees/worker'); fs.mkdirSync(path.dirname(legacy), { recursive: true });
    git(baseline, 'worktree', 'move', worker, legacy);
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').replaceAll(worker, legacy));
    remove(legacy); put(legacy, { instruction: 'LEGACY CHILD' });
    expect(context(legacy)).toContain('LEGACY CHILD');
    git(legacy, 'add', 'state.json');
    expect(context(legacy)).not.toContain('LEGACY CHILD');
    expect(context(legacy)).toContain('CONTRACT CHANGED');
    git(legacy, 'reset', '--', 'state.json');
    const keep = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
    // Existing install lifecycle tests cover moved managed context; this fixture only needs payload update.
    git(baseline, 'worktree', 'move', legacy, worker);
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').replaceAll(legacy, worker));
    harness.install(root, source, { update: true });
    expect(fs.existsSync(path.join(root, '.harness/runtime/steering-state.js'))).toBe(true);
    harness.uninstall(root);
    expect(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).toBe(keep);
    expect(fs.existsSync(path.join(root, '.harness/runtime/steering.js'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
