import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import extension, { createWork, openWork, nextNamePrefix, startWorkConversation } from './extension.js';

test('멀티 저장소 준비·재개, 원본 보존, 잘못된 입력과 충돌 거절', async () => {
  const previousTerminal = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = 'test';
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-work-'-$-")));
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
    const handlers = new Map();
    const messages = [];
    const launches = [];
    let launchResult = { code: 0, stderr: '', killed: false };
    // 등록 API 대역. 실제 OMP의 스키마·확장 로딩은 별도 native smoke로 확인한다.
    const zod = { string: () => ({ optional: () => ({}) }), object: properties => ({ properties }), array: items => ({ items }) };
    extension({ zod, on: (name, handler) => handlers.set(name, handler), registerCommand: (name, options) => commands.set(name, options),
      registerTool: tool => tools.set(tool.name, tool), sendMessage: (...args) => messages.push(args),
      exec: async (...args) => { launches.push(args); return launchResult; } });
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
    const draft = { name: `${nextNamePrefix(root)}improve-login`, title: '로그인 오류 안내 개선', repos: [{ name: 'frontend', ref: 'main' }],
      goal: '로그인 오류 안내 개선', scope: '오류 문구', nonGoals: '인증 API 변경', acceptance: '오류별 안내 확인', decisions: '확정: 기존 화면 유지. 미정: 최종 문구.' };
    const create = async params => {
      const transport = handlers.get('tool_call')({ toolName: 'write', input: { path: 'xd://work_create', content: JSON.stringify(params) } }, ctx);
      if (transport?.block) throw new Error(transport.reason);
      const direct = handlers.get('tool_call')({ toolName: 'work_create', input: params }, ctx);
      if (direct?.block) throw new Error(direct.reason);
      return tools.get('work_create').execute('test', params, undefined, undefined, ctx);
    };
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
    await expect(create({ ...draft, title: '제목\n추가 내용' })).rejects.toThrow('한 줄');
    let preview;
    process.env.TERM_PROGRAM = 'tern';
    ctx.ui.select = async (_title, options) => options[0];
    ctx.ui.confirm = async (_title, content) => { preview = content; return true; };
    const created = await create(draft);
    expect(created.details.created).toBe(true);
    expect(created.content[0].text).toContain('새 탭을 열었습니다');
    expect(launches).toEqual([['tern', ['new', 'tab', '--cwd', path.join(root, 'work', draft.name, 'frontend'), '--',
      '/usr/bin/env', `PATH=${process.env.PATH}`, `OMP_WORKTREE_DIR=${path.join(root, 'work', draft.name, '.sub-workspace')}`, 'omp',
      '--cwd', path.join(root, 'work', draft.name, 'frontend'), '--session-dir', path.join(root, 'work', draft.name, '.sessions/frontend'),
      `@${path.join(root, 'work', draft.name, 'task.md')}`], { timeout: 10000 }]]);
    const saved = fs.readFileSync(path.join(root, 'work', draft.name, 'task.md'), 'utf8');
    expect(saved.startsWith(`# ${draft.title}\n`)).toBe(true);
    expect(saved).not.toContain('이 문서는');
    expect(saved).not.toContain('저장소 기준');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'work', draft.name, '.harness-state.json'), 'utf8'));
    expect(Object.keys(state.repos)).toEqual(['frontend']);
    expect(state.task_id).toBe(draft.name);
    expect(state.repos.frontend).toMatchObject({ base_ref: 'main', base_sha: git(path.join(root, 'repository/frontend'), 'rev-parse', 'main'), branch: `work/${draft.name}` });
    expect(preview).toContain(draft.name);
    expect(preview).toContain('frontend=main');
    for (const field of ['goal', 'scope', 'nonGoals', 'acceptance', 'decisions']) expect(saved).toContain(draft[field]);
    await expect(create(draft)).rejects.toThrow('/work-init');
    ctx.ui.setEditorText = text => { editor = text; };
    ctx.ui.select = async () => undefined;
    await commands.get('work-open').handler('feature-a', ctx);
    expect(launches.length).toBe(1);
    expect(editor).toBe(output);
    ctx.ui.select = async (_title, options) => options.find(s => s.endsWith('backend'));
    await commands.get('work-open').handler('feature-a', ctx);
    expect(launches[1][1][3]).toBe(path.join(work, 'backend'));
    expect(editor).toContain('backend 작업용 새 탭');
    launchResult = { code: 1, stderr: 'daemon unavailable', killed: false };
    await commands.get('work-open').handler('feature-a', ctx);
    expect(editor).toContain('daemon unavailable');
    expect(editor).toContain(output);
    expect(fs.readFileSync(path.join(work, 'task.md'), 'utf8')).toBe(task);
    const launchCount = launches.length;
    await commands.get('work-open').handler('feature-a', { ...ctx, agent: { kind: 'sub' } });
    expect(launches.length).toBe(launchCount);
    expect(notices.at(-1)[1]).toBe('error');
    launchResult = { code: 0, stderr: '', killed: false };
    const selections = [];
    ctx.ui.select = async (title, options) => {
      selections.push({ title, options });
      return undefined;
    };
    editor = '입력 중인 내용';
    const open = commands.get('work-open').handler;
    await open('', ctx);
    expect(selections[0].options).toEqual(['feature-a', draft.name].sort().reverse());
    expect(editor).toBe('입력 중인 내용');
    expect(launches.length).toBe(launchCount);
    // 작업 선택 취소와 목록 조회는 작업 문서를 보완하거나 실행하지 않는다.
    const draftAgents = path.join(root, 'work', draft.name, 'AGENTS.md');
    fs.unlinkSync(draftAgents);
    await open('', ctx);
    expect(fs.existsSync(draftAgents)).toBe(false);
    selections.length = 0;
    ctx.ui.select = async (title, options) => {
      selections.push({ title, options });
      return draft.name;
    };
    await open('  ', { ...ctx, cwd: path.join(work, 'frontend') });
    expect(selections.length).toBe(1);
    expect(launches.length).toBe(launchCount + 1);
    expect(launches.at(-1)[1][3]).toBe(path.join(root, 'work', draft.name, 'frontend'));
    expect(fs.existsSync(draftAgents)).toBe(true);
    selections.length = 0;
    ctx.ui.select = async (title, options) => {
      selections.push({ title, options });
      return selections.length === 1 ? 'feature-a' : options.find(s => s.endsWith('backend'));
    };
    await open('', ctx);
    expect(selections.length).toBe(2);
    expect(launches.at(-1)[1][3]).toBe(path.join(work, 'backend'));
    const afterSelection = launches.length;
    await open('', { ...ctx, hasUI: false });
    expect(notices.at(-1)).toEqual(['대화형 omp 세션에서 실행하거나 /work-open 작업명으로 지정하세요.', 'error']);
    const empty = path.join(root, 'empty');
    fs.mkdirSync(path.join(empty, 'repository'), { recursive: true });
    await open('', { ...ctx, cwd: empty });
    expect(notices.at(-1)).toEqual(['기존 작업이 없습니다. /work-init으로 먼저 작업을 만드세요.', 'info']);
    expect(fs.existsSync(path.join(empty, 'work'))).toBe(false);
    fs.mkdirSync(path.join(empty, 'work/notes'), { recursive: true });
    await open('', { ...ctx, cwd: empty });
    expect(notices.at(-1)[0]).toContain('기존 작업이 없습니다');
    expect(launches.length).toBe(afterSelection);
    // 두 번째 git worktree add만 실패시켜 첫 번째 작업과 원본이 남는지 검사한다.
    const hook = path.join(root, 'reject-checkout');
    fs.mkdirSync(hook);
    fs.writeFileSync(path.join(hook, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(path.join(root, 'repository/backend'), 'config', 'core.hooksPath', hook);
    expect(() => createWork(root, 'partial frontend=HEAD backend=HEAD')).toThrow('보존');
    expect(fs.existsSync(path.join(root, 'work/partial/frontend/file.txt'))).toBe(true);
    expect(git(path.join(root, 'repository/frontend'), 'status', '--porcelain')).toBe(before);
  } finally {
    if (previousTerminal === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = previousTerminal;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
