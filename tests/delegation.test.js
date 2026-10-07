import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brief, capture, scaffold } from '../runtime/delegation.js';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('delegation brief rejects empty, duplicate and placeholder fields', () => {
  const delegated = { idea: '작업 현황판' };
  const text = scaffold('# Task', delegated);
  expect(() => brief(text, delegated)).toThrow('대상 사용자');
  const filled = text.replaceAll('작성 필요', '팀원이 사용할 화면과 동작');
  expect(Object.keys(brief(filled, delegated))).toHaveLength(3);
  expect(() => brief(filled + '\n- 대상 사용자: 중복\n', delegated)).toThrow('대상 사용자');
  expect(() => brief(filled + '\n' + filled, delegated)).toThrow('하나');
  expect(() => brief(filled + '\n## 위임 브리프', delegated)).toThrow('하나');
  expect(() => brief(filled.replace('대상 사용자: 팀원이 사용할 화면과 동작', '대상 사용자: '), delegated)).toThrow('대상 사용자');
  expect(brief('', null)).toBeNull();
  expect(capture({ hook_event_name: 'UserPromptSubmit', prompt: '현황판 아이디어가 있어' })).toBeNull();
});

test('explicit user delegation binds brief and file evidence through the installed Bun CLI', () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation 한글 ')));
  const root = path.join(temporary, 'workspace');
  fs.mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'OWN_HARNESS_CHILD'));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CODEX_THREAD_ID: 'delegation-fixture' });
  const run = (args, { cwd = root, input, reject } = {}) => {
    const result = spawnSync(args[0], args.slice(1), { cwd, env, input, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    if (reject) {
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(reject);
    } else expect(result.status, output).toBe(0);
    return result.stdout.trim();
  };
  const git = (...args) => run(['git', ...args]);
  const runtime = path.join(root, '.harness/runtime/work.js');
  const work = (...args) => run([process.execPath, runtime, ...args]);
  const rejected = (args, reject) => run([process.execPath, runtime, ...args], { reject });
  const controlPath = task => path.join(root, '.harness/private/work-control', task + '.json');
  const workPath = task => path.join(root, 'work', task, 'WORK.md');
  let turn = 0;
  const event = (prompt, extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: env.CODEX_THREAD_ID,
    turn_id: String(++turn), cwd: root, prompt, ...extra });
  const hook = value => JSON.parse(run([process.execPath, runtime, 'hook'], { input: JSON.stringify(value) }));
  const start = task => work('start', task, '--repo', 'project', '--base', 'main', '--branch', 'codex/' + task);
  const fill = task => fs.writeFileSync(workPath(task), fs.readFileSync(workPath(task), 'utf8').replaceAll('작성 필요', '임시 현황판의 표시 동작과 검사'));
  const record = (phase, options = {}) => {
    const file = path.join(root, 'work/idea/evidence', phase + '.md');
    fs.writeFileSync(file, `${phase}: isolated fixture inspected and command results checked\n`);
    const args = ['record', 'idea', phase, '--evidence', '@' + file];
    if (phase === 'verification') args.push('--reviewer', 'independent-fixture-reviewer');
    return options.reject ? rejected(args, options.reject) : work(...args);
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Delegation Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    fs.writeFileSync(path.join(root, 'app.txt'), 'fixture\n');
    git('add', 'app.txt');
    git('commit', '-qm', 'initial');
    run([process.execPath, path.join(SOURCE, 'harness.js'), 'install', root]);

    start('normal');
    fill('normal');
    work('record', 'normal', 'research', '--evidence', '실제 사용자 경로의 조사 근거');
    expect(fs.readFileSync(workPath('normal'), 'utf8')).not.toContain('## 위임 브리프');
    rejected(['brief', 'normal'], '명시적으로');
    expect(hook(event('아이디어를 생각 중입니다'))).toEqual({});
    expect(hook(event('아이디어 위임 missing')).hookSpecificOutput.additionalContext).toContain('정확한 명령');
    expect(hook(event('아이디어 위임 child 아이디어', { agent_id: 'child' })).hookSpecificOutput.additionalContext).toContain('하위 에이전트');
    expect(fs.existsSync(controlPath('child'))).toBe(false);

    const request = event('아이디어 위임 idea 팀의 작업 현황판을 만들어 줘');
    expect(hook(request).hookSpecificOutput.additionalContext).toContain('아이디어 위임을 기록');
    const first = fs.readFileSync(controlPath('idea'), 'utf8');
    expect(hook(request)).toEqual({});
    expect(fs.readFileSync(controlPath('idea'), 'utf8')).toBe(first);
    start('idea');
    expect(work('brief', 'idea')).toContain('팀의 작업 현황판을 만들어 줘');
    // A complete ordinary contract cannot satisfy an empty delegation brief.
    const initial = fs.readFileSync(workPath('idea'), 'utf8');
    fs.writeFileSync(workPath('idea'), initial.replace('- 목표: 작성 필요', '- 목표: 현황판')
      .replace('- 범위: 작성 필요', '- 범위: 현황판 표시')
      .replace('- 완료 조건: 작성 필요', '- 완료 조건: 표시 검사 통과'));
    rejected(['record', 'idea', 'research', '--evidence', '실제 조사 내용'], '대상 사용자');
    fill('idea');
    rejected(['record', 'idea', 'research', '--evidence', '실제 조사 내용'], '--evidence @파일');
    record('implementation', { reject: 'research' });
    record('research');
    record('design');
    record('implementation');
    const checkout = path.join(root, 'work/idea/repos/project');
    rejected(['check', '--cwd', checkout, '--delivery'], 'verification');
    record('verification');
    work('check', '--cwd', checkout, '--delivery');

    const research = path.join(root, 'work/idea/evidence/research.md');
    const originalEvidence = fs.readFileSync(research, 'utf8');
    fs.appendFileSync(research, 'changed\n');
    rejected(['check', '--cwd', checkout, '--delivery'], '근거 파일');
    fs.writeFileSync(research, originalEvidence);
    const originalWork = fs.readFileSync(workPath('idea'), 'utf8');
    fs.writeFileSync(workPath('idea'), originalWork.replace('대상 사용자: 임시 현황판의 표시 동작과 검사', '대상 사용자: 다른 대상'));
    rejected(['check', '--cwd', checkout, '--delivery'], '작업 계약이 바뀌');
    fs.writeFileSync(workPath('idea'), originalWork);

    hook(event('작업 통제 idea'));
    expect(JSON.parse(fs.readFileSync(controlPath('idea'))).delegation.idea).toContain('작업 현황판');
    rejected(['record', 'idea', 'implementation', '--evidence', '@' + research], '사용자 통제');
    hook(event('작업 이양 idea'));
    expect(JSON.parse(fs.readFileSync(controlPath('idea'))).delegation.idea).toContain('작업 현황판');
    rejected(['record', 'idea', 'research', '--evidence', '실제 조사 내용'], '--evidence @파일');
    // Re-delegating an existing task changes its contract and keeps human control.
    hook(event('작업 통제 idea'));
    const decision = work('decision', 'idea');
    expect(decision).toContain('팀의 작업 현황판을 만들어 줘');
    expect(decision).toContain('대상 사용자: 임시 현황판의 표시 동작과 검사');
    expect(decision).toContain('위임한 결정: 임시 현황판의 표시 동작과 검사');
    expect(decision).toContain('제약·비목표: 임시 현황판의 표시 동작과 검사');
    hook(event('아이디어 위임 idea 다른 현황판으로 바꿔 줘'));
    const control = JSON.parse(fs.readFileSync(controlPath('idea')));
    expect(control.mode).toBe('human');
    expect(control.proposal).toBeUndefined();
    expect(control.approval).toBeUndefined();
    rejected(['check', '--cwd', checkout], '작업 계약이 바뀌');

    // Existing ordinary tasks opt in too, and old text-only evidence becomes stale.
    hook(event('아이디어 위임 normal 기존 작업도 맡길게'));
    expect(fs.readFileSync(workPath('normal'), 'utf8')).toContain('## 위임 브리프');
    fill('normal');
    rejected(['record', 'normal', 'design', '--evidence', '@' + research], '--evidence @파일');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}, 120000);
