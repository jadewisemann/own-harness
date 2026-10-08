import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import extension, { createWork, openWork, nextNamePrefix, startWorkConversation } from './extension.js';

test('멀티 저장소 준비·재개, 원본 보존, 잘못된 입력과 충돌 거절', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-work-'-$-"));
  const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    for (const name of ['frontend', 'backend']) {
      const repo = path.join(root, 'repository', name);
      fs.mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Fixture');
      git(repo, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(repo, 'file.txt'), 'baseline');
      git(repo, 'add', 'file.txt');
      git(repo, 'commit', '-m', 'fixture');
      fs.writeFileSync(path.join(repo, 'file.txt'), 'uncommitted');
    }
    const before = git(path.join(root, 'repository/frontend'), 'status', '--porcelain');
    expect(() => createWork(root, '../escape frontend=HEAD')).toThrow();
    expect(() => createWork(root, 'bad frontend=HEAD backend=missing')).toThrow();
    expect(fs.existsSync(path.join(root, 'work'))).toBe(false);
    expect(() => createWork(root, 'duplicate frontend=HEAD frontend=HEAD')).toThrow();
    const output = createWork(root, 'feature-a frontend=main backend=HEAD');
    const work = path.join(root, 'work/feature-a');
    expect(output).toContain('OMP_WORKTREE_DIR=');
    expect(output).toContain('--session-dir');
    expect(output).not.toContain(' -e ');
    expect(output).toContain("'\\''");
    expect(fs.statSync(path.join(work, '.sub-workspace')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(work, 'frontend/file.txt'), 'utf8')).toBe('baseline');
    expect(git(path.join(root, 'repository/frontend'), 'status', '--porcelain')).toBe(before);
    expect(git(path.join(work, 'backend'), 'branch', '--show-current')).toBe('work/feature-a');
    expect(openWork(path.join(work, 'frontend'), 'feature-a')).toBe(output);
    const task = fs.readFileSync(path.join(work, 'task.md'), 'utf8');
    fs.mkdirSync(path.join(work, 'notes'));
    fs.writeFileSync(path.join(work, 'notes', 'result.md'), '검증 기록');
    expect(openWork(root, 'feature-a')).toBe(output);
    expect(() => createWork(root, 'feature-a frontend=HEAD')).toThrow('덮어쓰지');
    expect(fs.readFileSync(path.join(work, 'task.md'), 'utf8')).toBe(task);
    git(path.join(root, 'repository/frontend'), 'branch', 'work/conflict');
    expect(() => createWork(root, 'conflict frontend=HEAD')).toThrow('브랜치');
    fs.symlinkSync(root, path.join(root, 'work/linked'));
    expect(() => openWork(root, 'linked')).toThrow('디렉터리');
    const commands = new Map();
    const tools = new Map();
    const messages = [];
    // 등록 API 대역. 실제 OMP의 스키마·확장 로딩은 별도 native smoke로 확인한다.
    const zod = { string: () => ({}), object: properties => ({ properties }), array: items => ({ items }) };
    extension({ zod, on: () => {}, registerCommand: (name, options) => commands.set(name, options),
      registerTool: tool => tools.set(tool.name, tool), sendMessage: (...args) => messages.push(args) });
    expect([...commands.keys()]).toEqual(['work-init', 'work-open']);
    let editor;
    const notices = [];
    await commands.get('work-open').handler('feature-a', {
      cwd: root, agent: { kind: 'main' },
      ui: { setEditorText: text => { editor = text; }, notify: (...args) => notices.push(args) },
    });
    expect(editor).toBe(output);
    expect(notices[0][1]).toBe('info');
    expect(nextNamePrefix(root, new Date('2026-10-07T15:05:00Z'))).toBe('26-10-08__01__');
    fs.mkdirSync(path.join(root, 'work/26-10-08__03__older-work'));
    expect(nextNamePrefix(root, new Date('2026-10-07T15:05:00Z'))).toBe('26-10-08__04__');
    const ctx = { cwd: root, agent: { kind: 'main' }, hasUI: true,
      ui: { confirm: async () => false, notify: (...args) => notices.push(args) } };
    const draft = { name: `${nextNamePrefix(root)}improve-login`, repos: [{ name: 'frontend', ref: 'main' }],
      goal: '로그인 오류 안내 개선', scope: '오류 문구', nonGoals: '인증 API 변경', acceptance: '오류별 안내 확인', decisions: '확정: 기존 화면 유지. 미정: 최종 문구.' };
    const create = params => tools.get('work_create').execute('test', params, undefined, undefined, ctx);
    await expect(create(draft)).rejects.toThrow('/work-init');
    await commands.get('work-init').handler('', ctx);
    expect(messages[0][1]).toEqual({ triggerTurn: true });
    expect(messages[0][0].content).toContain('사용자와 대화');
    expect(startWorkConversation(root, '로그인 개선').prompt).toContain('로그인 개선');
    expect(fs.existsSync(path.join(root, 'work', draft.name))).toBe(false);
    expect((await create(draft)).details.created).toBe(false);
    expect(fs.existsSync(path.join(root, 'work', draft.name))).toBe(false);
    await expect(create({ ...draft, name: 'manual-name' })).rejects.toThrow('형식');
    await expect(create({ ...draft, name: '26-01-01__01__old-name' })).rejects.toThrow('다음 작업 번호');
    let preview;
    ctx.ui.confirm = async (_title, content) => { preview = content; return true; };
    expect((await create(draft)).details.created).toBe(true);
    const saved = fs.readFileSync(path.join(root, 'work', draft.name, 'task.md'), 'utf8');
    expect(preview).toContain(draft.name);
    expect(preview).toContain('frontend=main');
    for (const field of ['goal', 'scope', 'nonGoals', 'acceptance', 'decisions']) expect(saved).toContain(draft[field]);
    await expect(create(draft)).rejects.toThrow('/work-init');
    // 두 번째 git worktree add만 실패시켜 첫 번째 작업과 원본이 남는지 검사한다.
    const hook = path.join(root, 'reject-checkout');
    fs.mkdirSync(hook);
    fs.writeFileSync(path.join(hook, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(path.join(root, 'repository/backend'), 'config', 'core.hooksPath', hook);
    expect(() => createWork(root, 'partial frontend=HEAD backend=HEAD')).toThrow('보존');
    expect(fs.existsSync(path.join(root, 'work/partial/frontend/file.txt'))).toBe(true);
    expect(git(path.join(root, 'repository/frontend'), 'status', '--porcelain')).toBe(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
