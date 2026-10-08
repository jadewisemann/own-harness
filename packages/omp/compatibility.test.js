import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { install, doctor } from '../codex/harness.js';
import { createWork, openWork, workspace } from './extension.js';
import { policyContext } from './policy.js';

test('OMP and installed Codex share mapped repositories, task state and legacy checkout paths', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-common-')));
  const repo = path.join(root, 'frontend');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    fs.mkdirSync(repo); git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repo, 'code.txt'), 'initial'); git('add', '.'); git('commit', '-m', 'initial');
    install(root, path.resolve(import.meta.dir, '../codex'), { mapping: { frontend: 'frontend' } });
    expect(workspace(repo)).toBe(root);
    expect(() => createWork(root, 'invalid frontend=main', undefined, undefined, '-bad')).toThrow('브랜치');
    expect(fs.existsSync(path.join(root, 'work/invalid'))).toBe(false);
    createWork(root, 'feature-a frontend=main', ['목표', '범위', '하지 않을 일', '완료 조건', '결정 사항'].map(h => `## ${h}\n\n두 실행기의 작업 연결 검사`).join('\n\n'), '공통 작업 연결', 'update/feature-a');
    const task = path.join(root, 'work/feature-a'), checkout = path.join(task, 'frontend');
    const work = (...args) => execFileSync(process.execPath, [path.join(root, '.harness/runtime/work.js'), ...args], { encoding: 'utf8' });
    expect(work('status', 'feature-a')).toContain('feature-a');
    expect(execFileSync('git', ['-C', checkout, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('update/feature-a');
    expect(work('check', '--cwd', checkout)).toContain('OK');
    expect(policyContext({ cwd: checkout, agent: { id: 'parent' } })).toContain('담당 저장소: frontend');
    expect(doctor(root).status).toBe('ok');
    // Previously created tasks retain their real checkout path in the shared state.
    const legacy = path.join(root, '.worktrees/feature-a/frontend'); fs.mkdirSync(path.dirname(legacy), { recursive: true });
    git('worktree', 'move', checkout, legacy);
    const state = path.join(task, '.harness-state.json');
    fs.writeFileSync(state, fs.readFileSync(state, 'utf8').replaceAll(checkout, legacy));
    expect(openWork(root, 'feature-a')).toContain(legacy);
    expect(policyContext({ cwd: legacy, agent: { id: 'legacy' } })).toContain(legacy);
    expect(work('check', '--cwd', legacy)).toContain('OK');
    fs.writeFileSync(state, fs.readFileSync(state, 'utf8').replaceAll(legacy, repo));
    expect(() => openWork(root, 'feature-a')).toThrow('작업 경로');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
