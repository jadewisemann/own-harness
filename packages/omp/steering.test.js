import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWork } from './extension.js';
import { checkTool, policyContext, policyFor, registerPolicy } from './policy.js';

const put = (dir, value) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(value));
test('OMP rereads inherited state and verifies actual isolate registration before adopting child state', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omp-steering-')));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const event = toolName => ({ toolName, input: { path: 'file.txt' } });
  try {
    for (const repo of ['front', 'other']) {
      const baseline = path.join(root, 'repository', repo); fs.mkdirSync(baseline, { recursive: true });
      git(baseline, 'init', '-q', '-b', 'main'); git(baseline, 'config', 'user.name', 'Fixture'); git(baseline, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(baseline, 'file.txt'), 'initial'); git(baseline, 'add', '.'); git(baseline, 'commit', '-qm', 'initial');
    }
    createWork(root, 'change front=HEAD other=HEAD');
    const task = path.join(root, 'work/change'), checkout = path.join(task, 'front');
    fs.writeFileSync(path.join(task, 'task.md'), ['목표', '범위', '비목표', '완료 조건', '설계 결정과 미정 사항'].map(h => `## ${h}\n\n구체적인 내용`).join('\n\n'));
    const main = { cwd: checkout, agent: { id: 'lead', kind: 'main' } };
    policyFor(main);
    const childRoot = path.join(task, '.sub-workspace/arbitrary/deep/checkout'); fs.mkdirSync(path.dirname(childRoot), { recursive: true });
    git(checkout, 'worktree', 'add', '--detach', childRoot, 'HEAD');
    const stale = path.join(root, 'stale'); git(checkout, 'worktree', 'add', '--detach', stale, 'HEAD'); fs.rmSync(stale, { recursive: true });
    const child = { cwd: childRoot, agent: { id: 'worker', parentId: 'lead', kind: 'sub' } };
    expect(checkTool(event('write'), child)?.block).toBeUndefined(); // An unrelated prunable worktree does not block this registered child.
    const handlers = new Map(); registerPolicy({ on: (name, handler) => handlers.set(name, handler) });
    put(root, { mode: 'pstack', control: 'auto', instruction: 'ROOT' });
    put(task, { control: 'human' }); put(childRoot, { instruction: 'CHILD' });
    put(checkout, { control: 'auto', instruction: 'IGNORE REPO' });
    put(path.join(root, 'repository/front'), { instruction: 'IGNORE BASELINE' });
    expect(policyContext(main)).toContain('"control":"human"'); expect(policyContext(main)).not.toContain('IGNORE');
    expect(policyContext(child)).toContain('CHILD');
    for (const ctx of [main, child, { cwd: task }]) {
      for (const name of ['bash', 'write', 'work_create', 'task', 'unknown']) expect(checkTool(event(name), ctx)?.block).toBe(true);
      expect(checkTool(event('read'), ctx)?.block).toBeUndefined();
      expect(checkTool(event('read'), ctx)?.additionalContext).toContain('human');
    }
    const subBlock = handlers.get('before_subagent_spawn')({}, main);
    expect(subBlock.block).toBe(true); expect(subBlock.reason).toContain('"mode":"pstack"');
    const docs = fs.readFileSync(path.join(task, 'task.md'), 'utf8');
    put(root, { mode: 'design', instruction: 'CHANGED' });
    expect(handlers.get('tool_call')(event('read'), child).additionalContext).toContain('"mode":"design"');
    put(childRoot, { instruction: '' }); expect(policyContext(child)).not.toContain('CHANGED');
    put(childRoot, {}); expect(policyContext(child)).toContain('CHANGED');
    put(task, { control: 'auto' });
    expect(checkTool(event('bash'), main)?.block).toBeUndefined();
    expect(checkTool(event('write'), child)?.block).toBeUndefined();
    expect(fs.readFileSync(path.join(task, 'task.md'), 'utf8')).toBe(docs);
    const startup = handlers.get('before_agent_start')({ systemPrompt: ['base'] }, child);
    expect(startup.systemPrompt[0]).toBe('base'); expect(startup.systemPrompt[1]).toContain('CHANGED');
    fs.writeFileSync(path.join(task, 'state.json'), '{');
    expect(checkTool(event('bash'), main)?.block).toBe(true);
    expect(checkTool(event('read'), main)?.block).toBeUndefined();
    expect(checkTool(event('read'), main)?.additionalContext).toContain('검사 실패');
    put(task, {});
    // Product-owned root state is ignored, including attempts to override parent control.
    put(childRoot, { control: 'auto', instruction: 'PRODUCT DATA' });
    git(childRoot, 'add', 'state.json');
    put(task, { control: 'human' });
    expect(checkTool(event('bash'), child)?.block).toBe(true);
    expect(checkTool(event('read'), child)?.additionalContext).not.toContain('PRODUCT DATA');
    put(task, { control: 'auto' });
    expect(checkTool(event('bash'), child)?.block).toBeUndefined();
    expect(checkTool(event('read'), child)?.block).toBeUndefined();
    git(childRoot, 'reset', '--', 'state.json');
    // A different repository cannot inherit the parent's binding even inside .sub-workspace.
    const wrong = path.join(task, '.sub-workspace/wrong'); git(path.join(task, 'other'), 'worktree', 'add', '--detach', wrong, 'HEAD');
    const wrongCtx = { cwd: wrong, agent: { id: 'wrong', parentId: 'lead', kind: 'sub' } };
    expect(checkTool(event('write'), wrongCtx)?.reason).toContain('등록된 격리 worktree');
    // Copying .git creates no registered worktree and cannot authorize child state.
    const fake = path.join(task, '.sub-workspace/fake'); fs.mkdirSync(fake); fs.copyFileSync(path.join(childRoot, '.git'), path.join(fake, '.git'));
    expect(checkTool(event('write'), { cwd: fake, agent: { id: 'fake', parentId: 'lead', kind: 'sub' } })?.block).toBe(true);
    policyFor({ cwd: path.join(task, 'other'), agent: main.agent });
    expect(checkTool(event('write'), child)?.block).toBe(true);
    for (const dir of [root, task, childRoot]) fs.rmSync(path.join(dir, 'state.json'));
    expect(checkTool(event('read'), main).additionalContext).toContain('현재 외부 상태 지정 없음');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
