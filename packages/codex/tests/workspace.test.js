/** Task-local parallel implementation, using real isolated Git worktrees and hooks. */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('one WORK manages optional worker checkouts, local results, integration and cleanup', () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task workspace 한글 ')));
  const root = path.join(temporary, 'project');
  fs.mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'OWN_HARNESS_CHILD'));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CODEX_THREAD_ID: 'workspace-fixture' });
  const run = (args, { cwd = root, reject = false, input } = {}) => {
    const result = spawnSync(args[0], args.slice(1), { cwd, env, input, encoding: 'utf8', timeout: 45000 });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    if (reject) {
      expect(result.status, output).not.toBe(0);
      if (typeof reject === 'string') expect(output).toContain(reject);
    } else expect(result.status, output).toBe(0);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => run(['git', ...args], { cwd });
  const runtime = path.join(root, '.harness/runtime/work.js');
  const work = (...args) => run([process.execPath, runtime, ...args]);
  const denied = (...args) => run([process.execPath, runtime, ...args], { reject: true });
  const taskRoot = path.join(root, 'work/change');
  const workFile = path.join(taskRoot, 'task.md');
  const lead = path.join(taskRoot, 'project');
  const worker = name => path.join(taskRoot, '.sub-workspace', name, 'project');
  const data = () => JSON.parse(fs.readFileSync(workFile, 'utf8').match(/<!-- own-harness-work:v1 -->\n```json\n([\s\S]*?)\n```/)[1]);
  const evidence = (name, text = 'Executed the fixture checks and inspected the changed user path.\n') => {
    const file = path.join(taskRoot, 'evidence', name + '.md');
    fs.writeFileSync(file, text);
    return '@' + file;
  };
  const result = name => work('result', 'change', name, '--evidence', evidence(name));
  const record = phase => work('record', 'change', phase, '--evidence', evidence(phase), ...(phase === 'verification' ? ['--reviewer', 'independent-fixture'] : []));
  const fork = (name, file) => work('fork', 'change', name, '--repo', 'project', '--owner', name + '-builder', '--scope', file);
  const check = () => work('check', '--cwd', lead, '--delivery');
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Workspace Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'config', 'commit.gpgSign', 'false');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a original\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b original\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
    run([process.execPath, path.join(source, 'harness.js'), 'install', root]);
    work('start', 'change', '--repo', 'project', '--base', 'main', '--branch', 'codex/change');
    expect(fs.existsSync(workFile)).toBe(true);
    expect(fs.existsSync(path.join(taskRoot, 'evidence'))).toBe(true);
    expect(fs.existsSync(path.join(taskRoot, '.codex/hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(taskRoot, '.agents/skills/pstack-codex/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(taskRoot, 'agents'))).toBe(false);
    expect(fs.existsSync(path.join(taskRoot, '.worktrees'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.harness/private/work/change/WORK.md'))).toBe(false);
    const initialWork = fs.readFileSync(workFile, 'utf8');
    const initialMetadata = initialWork.match(/<!-- own-harness-work:v1 -->\n```json\n([\s\S]*?)\n```/)[1];
    const malformed = JSON.parse(initialMetadata);
    const unexpectedCheckout = path.join(temporary, 'unexpected', 'checkout');
    malformed.repos.project.checkout = unexpectedCheckout;
    malformed.repos.project.branch = 'codex/unsafe-recreation';
    fs.writeFileSync(workFile, initialWork.replace(initialMetadata, () => JSON.stringify(malformed, null, 2)));
    denied('start', 'change', '--repo', 'project', '--base', 'main', '--branch', 'codex/unsafe-recreation');
    expect(fs.existsSync(unexpectedCheckout)).toBe(false);
    expect(git(root, 'branch', '--list', 'codex/unsafe-recreation')).toBe('');
    fs.writeFileSync(workFile, initialWork);
    const publicDocument = path.join(temporary, 'public.md');
    for (const content of ['work/change/evidence/report.md', 'work/change/repos/project', 'work/change/.worktrees/first', 'assignment_sha256: copied', '"planning_sha256": "copied"', '- workers_sha256: copied']) {
      fs.writeFileSync(publicDocument, content);
      denied('public-text', publicDocument);
    }
    for (const content of ['work/foo.js', 'work/change/evidence-helper.md', 'work/change/repos-helper.js']) {
      fs.writeFileSync(publicDocument, content);
      work('public-text', publicDocument);
    }
    fs.writeFileSync(workFile, fs.readFileSync(workFile, 'utf8').replaceAll('작성 필요', '독립된 두 파일을 수정하고 전체 조합을 검증한다'));
    denied('fork', 'change', 'first', '--repo', 'project', '--owner', 'first-builder', '--scope', 'a.txt');
    record('research');
    record('design');

    fs.appendFileSync(path.join(lead, 'a.txt'), 'uncommitted\n');
    denied('fork', 'change', 'first', '--repo', 'project', '--owner', 'first-builder', '--scope', 'a.txt');
    git(lead, 'restore', '--', 'a.txt');
    fork('first', 'a.txt');
    fork('second', 'b.txt');
    expect(data().workers.first.owner).toBe('first-builder');
    expect(data().workers.first.scope).toEqual(['a.txt']);
    expect(fs.existsSync(path.join(worker('first'), 'TASK.md'))).toBe(false);
    expect(work('status', 'change')).toContain('first-builder');
    denied('clean', 'change', 'first');
    record('implementation');
    denied('record', 'change', 'verification', '--evidence', evidence('verification'), '--reviewer', 'independent-fixture');

    // A worker cannot use its local commit path to stage changes outside its assignment.
    fs.writeFileSync(path.join(worker('first'), 'b.txt'), 'outside assignment\n');
    git(worker('first'), 'add', 'b.txt');
    denied('result', 'change', 'first', '--evidence', evidence('first'));
    git(worker('first'), 'restore', '--staged', '--worktree', '--', 'b.txt');

    for (const [name, file] of [['first', 'a.txt'], ['second', 'b.txt']]) {
      fs.writeFileSync(path.join(worker(name), file), name + ' implementation\n');
      git(worker(name), 'add', file);
      run(['git', 'commit', '-qm', name], { cwd: worker(name), reject: true });
      denied('result', 'change', name, '--evidence', 'A plain success sentence');
      // Result evidence survives cleanup; a file inside the worker checkout cannot serve as its receipt.
      run([process.execPath, runtime, 'result', 'change', name, '--evidence', '@' + path.join(worker(name), file)], { reject: 'work/TASK/evidence/' });
      result(name);
      const summary = JSON.parse(work('status', 'change')).workers[name].result;
      expect(summary.evidence).toBe('@' + path.join(taskRoot, 'evidence', name + '.md'));
      expect(summary.head_sha).toBe(git(worker(name), 'rev-parse', 'HEAD'));
      // Publishing is reserved for the integrated task even when local checks pass.
      denied('check', '--cwd', worker(name), '--delivery', '--publish');
      git(worker(name), 'commit', '-qm', name);
      denied('integrate', 'change', name); // HEAD changed after the recorded result.
      result(name);
    }

    work('integrate', 'change', 'first');
    expect(fs.readFileSync(path.join(lead, 'a.txt'), 'utf8')).toBe('first implementation\n');
    denied('integrate', 'change', 'second');
    // The second worker replays only its own changes onto the current lead commit.
    git(worker('second'), 'rebase', 'codex/change');
    result('second');
    work('integrate', 'change', 'second');
    expect(fs.readFileSync(path.join(lead, 'b.txt'), 'utf8')).toBe('second implementation\n');
    record('implementation');
    record('verification');
    check();
    // Even a task-level phase receipt must not be deleted with a worker checkout.
    work('record', 'change', 'verification', '--evidence', '@' + path.join(worker('first'), 'a.txt'), '--reviewer', 'independent-fixture');
    run([process.execPath, runtime, 'clean', 'change', 'first'], { reject: '단계 근거' });
    record('verification');

    const firstEvidence = path.join(taskRoot, 'evidence/first.md');
    const originalEvidence = fs.readFileSync(firstEvidence, 'utf8');
    fs.appendFileSync(firstEvidence, 'changed report\n');
    denied('check', '--cwd', lead, '--delivery');
    fs.writeFileSync(firstEvidence, originalEvidence);
    fs.appendFileSync(path.join(worker('first'), 'a.txt'), 'unreported edits\n');
    denied('check', '--cwd', lead, '--delivery');
    denied('clean', 'change', 'first');
    git(worker('first'), 'restore', '--', 'a.txt');
    const firstReceipt = JSON.stringify(data().workers.first.result);
    // Accepted worker commits are historical receipts. A revised plan needs fresh task verification.
    fs.writeFileSync(workFile, fs.readFileSync(workFile, 'utf8').replace('목표: ', '목표: 통합 후 재검토한 '));
    denied('check', '--cwd', lead, '--delivery');
    for (const phase of ['research', 'design', 'implementation', 'verification']) record(phase);
    check();
    expect(JSON.stringify(data().workers.first.result)).toBe(firstReceipt);
    work('clean', 'change', 'first');
    work('clean', 'change', 'second');
    expect(fs.existsSync(worker('first'))).toBe(false);
    expect(data().workers.first.state).toBe('cleaned');
    expect(data().workers.first.result).toBeDefined();
    expect(git(lead, 'rev-parse', '--verify', data().workers.first.branch)).toBeTruthy();
    check(); // Cleanup changes location bookkeeping, not the validated integrated result.
    fs.writeFileSync(workFile, fs.readFileSync(workFile, 'utf8').replace('목표: ', '목표: 정리 후 재검토한 '));
    denied('check', '--cwd', lead, '--delivery');
    for (const phase of ['research', 'design', 'implementation', 'verification']) record(phase);
    check();
    expect(JSON.stringify(data().workers.first.result)).toBe(firstReceipt);
    run([process.execPath, path.join(source, 'harness.js'), 'doctor', root]);
    run([process.execPath, path.join(source, 'harness.js'), 'uninstall', root]);
    expect(fs.existsSync(workFile)).toBe(true);
    expect(fs.existsSync(firstEvidence)).toBe(true);
    expect(fs.existsSync(lead)).toBe(true);
    expect(fs.existsSync(path.join(taskRoot, '.codex/hooks.json'))).toBe(false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}, 120000);
