/** Offline integration regression using copied runtime and temporary Git only. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');
const read = file => fs.readFileSync(file, 'utf8');
const write = (file, text) => fs.writeFileSync(file, text);
const quote = text => "'" + text.replace(/'/g, "'\\''") + "'";
function run(cwd, args, { ok = true, data, env = process.env } = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd, env, input: data, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status === 0, ok, JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
  return result.stdout.trim();
}
function git(cwd, ...args) { return run(cwd, ['git', ...args]); }
function reject(fn, message = '') {
  assert.throws(fn, error => { assert.ok(error.message.includes(message), error.message); return true; });
}
async function module(file) { return import(pathToFileURL(file).href); }
function repository(directory) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Runtime Test');
  git(directory, 'config', 'user.email', 'runtime@example.invalid');
  git(directory, 'config', 'commit.gpgSign', 'false');
  git(directory, 'config', 'core.hooksPath', '/dev/null');
  write(path.join(directory, '.gitignore'), '.harness/\n.worktrees/\nwork/\n.codex/\napi/\n');
  write(path.join(directory, 'a.txt'), 'initial\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'test: initial');
}

test('runtime guards preserve offline work, approval, Git hook and delivery regressions', async () => {
  const previous_env = { ...process.env };
  const log = console.log;
  let count = 0;
  const passed = label => { count++; log(`PASS ${String(count).padStart(2, '0')} ${label}`); };
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-harness-')));
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') || key === 'OWN_HARNESS_CHILD') delete process.env[key];
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CODEX_THREAD_ID: 'runtime-fixture' });
    console.log = () => {};
    const root = path.join(directory, '공백 workspace');
    repository(root);
    repository(path.join(root, 'api'));
    const runtime = path.join(root, '.harness/runtime');
    fs.cpSync(SOURCE, runtime, { recursive: true });
    const config = path.join(root, '.harness/config.json');
    write(config, JSON.stringify({ schema: 1, repos: { project: '.', workspace: 'api' } }));
    write(path.join(root, '.harness/harness.js'), "import fs from 'node:fs'; import path from 'node:path';\nif (process.argv[2] !== 'prepare') throw new Error('Expected prepare');\nconst file = path.join(process.argv[3], '.codex/config.toml');\nfs.mkdirSync(path.dirname(file), {recursive: true});\nfs.writeFileSync(file, '[memories]\\nuse_memories = false\\n');\n");
    const w = await module(path.join(runtime, 'work.js'));
    const pr = await module(path.join(runtime, 'pr-guard.js'));
    const c = w.common;
    const alternative = path.join(root, 'package/runtime');
    fs.cpSync(runtime, alternative, { recursive: true });
    const copied = await module(path.join(alternative, 'harness_common.js'));
    reject(() => copied.load_config(), '실제 설치 위치');
    fs.rmSync(path.join(root, 'package'), { recursive: true });

    function task(name, repo = 'project', scopes = [], external = null) {
      let target;
      if (external || scopes.length) {
        target = external ? path.join(external, '.worktrees', name, repo) : path.join(root, 'work', name, 'repos', repo);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        git(c.repo_paths()[repo], 'worktree', 'add', '-b', name, target, 'main');
        w.init(name, target, 'main', scopes);
      } else {
        w.start(name, repo, 'main', name);
        target = path.join(root, 'work', name, 'repos', repo);
      }
      const file = w.work_path(name);
      write(file, read(file).replace('목표: 작성 필요', '목표: 경로와 승인을 검증한다').replace('범위: 작성 필요', '범위: 등록된 파일과 검사').replace('완료 조건: 작성 필요', '완료 조건: 회귀 검사 통과'));
      return target;
    }
    function phases(name, through = 'verification') {
      for (const phase of w.PHASES) {
        w.record(name, phase, phase + ': 실제 경로와 결과 검사', phase === 'verification' ? 'independent' : null);
        if (phase === through) break;
      }
    }
    const event = (prompt, turn = 'fixture-turn', extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'runtime-fixture', turn_id: turn, cwd: root, prompt, ...extra });

    for (const baseline of [root, path.join(root, 'api')]) reject(() => w.check(baseline), 'baseline');
    const tree = task('sample');
    w.start('sample', 'project', 'main', 'sample');
    assert.equal(read(path.join(tree, '.codex/config.toml')), '[memories]\nuse_memories = false\n');
    w.check(tree);
    reject(() => w.record('sample', 'implementation', '구현 결과'), 'research');
    phases('sample');
    w.check(tree, true);
    passed('single repository, non-ASCII path, safe start/reuse and stage order');

    write(path.join(tree, 'a.txt'), 'changed\n');
    reject(() => w.check(tree, true), '검증 뒤 바뀌었습니다');
    w.snapshot('sample');
    reject(() => w.check(tree, true), '검증 뒤 바뀌었습니다');
    w.record('sample', 'verification', '변경된 내용 재검증', 'independent');
    reject(() => w.check(tree, true), 'index와 작업 내용');
    git(tree, 'add', 'a.txt');
    w.record('sample', 'verification', 'index 변경 재검증', 'independent');
    w.check(tree, true);
    git(tree, 'commit', '-m', 'test: change');
    reject(() => w.check(tree, true), '검증 뒤 바뀌었습니다');
    w.record('sample', 'verification', 'commit 뒤 재검증', 'independent');
    passed('content, index and HEAD changes invalidate evidence; snapshot cannot renew it');

    const index = git(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    Object.assign(process.env, { GIT_INDEX_FILE: index + '.temporary', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
    reject(() => w.check(tree, true), '임시 Git index');
    assert.equal(c.git(tree, 'rev-parse', '--is-bare-repository'), 'false');
    for (const key of ['GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[key];
    const old_config = read(config);
    write(config, old_config + '\n');
    reject(() => w.check(tree, true), '계약이 바뀌었습니다');
    write(config, old_config);
    const engine = path.join(runtime, 'work.js');
    const old_engine = read(engine);
    write(engine, old_engine + '\n// policy change\n');
    reject(() => w.check(tree, true), '계약이 바뀌었습니다');
    write(engine, old_engine);
    w.check(tree, true);
    passed('temporary index and Git config injection reject; config/runtime policy changes stale evidence');

    const second = task('multi', 'workspace');
    const first = task('multi');
    phases('multi');
    w.check(first, true);
    write(path.join(second, 'a.txt'), 'other repository change');
    reject(() => w.check(first, true), '검증 뒤 바뀌었습니다');
    const external = task('external', 'project', [], path.join(directory, '외부 위치'));
    const legacy_record = path.join(root, '.harness/private/work/external/WORK.md');
    fs.mkdirSync(path.dirname(legacy_record), { recursive: true });
    fs.renameSync(w.work_path('external'), legacy_record);
    assert.equal(w.work_path('external'), legacy_record);
    phases('external');
    w.check(external, true);
    reject(() => w.init('wrong', tree, 'main', []), '작업 ID');
    write(config, JSON.stringify({ schema: 1, repos: { one: '.', two: '.' } }));
    reject(() => c.load_config(), '중복');
    write(config, old_config);
    passed('repo names have no special meaning, multi-repo invalidation, external legacy checkout and WORK record');

    const human = task('human');
    const control_event = event('작업 통제 human');
    w.hook(control_event);
    const held = read(w.control_path('human'));
    assert.deepEqual(w.hook(control_event), {});
    assert.equal(read(w.control_path('human')), held);
    phases('human', 'design');
    reject(() => w.record('human', 'implementation', '구현 결과'), '사용자 통제');
    w.decision('human');
    const code = w.read_control('human').proposal.code;
    const approve = event('작업 승인 human ' + code, 'approval-turn');
    for (const bad of [{ ...approve, turn_id: null }, { ...approve, agent_id: 'child' }, { ...approve, session_id: 'other' }]) assert.ok(JSON.stringify(w.hook(bad)).includes('적용하지 못했습니다'));
    w.hook(approve);
    const human_state = read(w.control_path('human'));
    assert.deepEqual(w.hook(approve), {});
    assert.equal(read(w.control_path('human')), human_state);
    phases('human');
    w.check(human, true);
    write(config, old_config + '\n');
    reject(() => w.check(human, true), '사용자 통제');
    assert.equal(w.read_control('human').mode, 'human');
    write(config, old_config);
    passed('human control, root event proof, duplicate events and policy approval invalidation');

    const scoped = task('scope', 'project', ['a.txt']);
    write(path.join(scoped, 'outside.txt'), 'outside scope');
    git(scoped, 'add', 'outside.txt');
    git(scoped, 'commit', '-m', 'test: outside scope');
    git(scoped, 'rm', 'outside.txt');
    git(scoped, 'commit', '-m', 'test: remove outside scope');
    phases('scope');
    reject(() => w.check(scoped, true), 'scope 밖 커밋');
    const actual = git(scoped, 'rev-parse', 'HEAD');
    git(scoped, 'replace', actual, 'main');
    reject(() => w.check(scoped, true), 'scope 밖 커밋');
    passed('fixed base scope covers removed history and ignores replacement refs');

    const bin_dir = path.join(directory, 'bin');
    fs.mkdirSync(bin_dir);
    const sent = path.join(directory, 'sent.json');
    const gh = path.join(bin_dir, 'gh');
    write(gh, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] === 'api') { console.log(process.env.FIXTURE_PRIVATE || 'false'); process.exit(0); }\nif (args[0] !== 'pr' || args[1] !== 'create') throw new Error('Unexpected gh call');\nfs.writeFileSync(process.env.FIXTURE_SENT, JSON.stringify({args, body: fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8')}));\nconsole.log('https://github.com/example/project/pull/1');\n`);
    fs.chmodSync(gh, 0o755);
    Object.assign(process.env, { PATH: bin_dir + path.delimiter + process.env.PATH, FIXTURE_SENT: sent });
    git(tree, 'remote', 'add', 'origin', 'https://github.com/example/project.git');
    const document = path.join(directory, 'PR.md');
    write(document, '# PR.md\n\n## 제목\nfix: literal $(text) and `code`\n\n## 본문\n수정과 검증 결과를 기록했습니다.\n');
    pr.review(document, tree, 'main');
    const state_file = pr.state_path('runtime-fixture');
    const approval = event('PR 승인 ' + pr.load(state_file).token, 'pr-approval');
    for (const bad of [{ ...approval, agent_id: 'child' }, { ...approval, parent_session_id: 'parent' }, { ...approval, turn_id: null }, { ...approval, session_id: null }]) {
      reject(() => pr.hook(bad));
      assert.ok(!pr.load(state_file).approved);
    }
    pr.hook(approval);
    const pr_state = read(state_file);
    pr.hook(approval);
    assert.equal(read(state_file), pr_state);
    const command = 'bun ' + quote(path.join(runtime, 'pr-guard.js')) + ' create';
    const tool_event = { hook_event_name: 'PreToolUse', session_id: 'runtime-fixture', turn_id: 'pr-approval', tool_name: 'exec_command', tool_input: { cmd: command } };
    for (const bad of [{ ...tool_event, agent_id: 'child' }, { ...tool_event, turn_id: null }, { ...tool_event, turn_id: 'next-turn' }]) reject(() => pr.hook(bad));
    pr.hook(tool_event);
    pr.create();
    assert.ok(JSON.parse(read(sent)).args.includes('--draft'));
    assert.equal(JSON.parse(read(sent)).args[JSON.parse(read(sent)).args.indexOf('--title') + 1], 'fix: literal $(text) and `code`');
    reject(() => pr.create(), '승인');
    passed('PR child/missing turn/session reject, duplicate approval and one-time exact Draft create');

    pr.review(document, tree, 'main');
    pr.hook(event('PR 승인 ' + pr.load(state_file).token, 'pr-approval-2'));
    pr.hook(event('별도 요청입니다', 'other-turn'));
    reject(() => pr.create(), '승인');
    pr.review(document, tree, 'main');
    pr.hook(event('PR 승인 ' + pr.load(state_file).token, 'pr-approval-3'));
    write(config, old_config + '\n');
    reject(() => pr.create());
    write(config, old_config);
    assert.ok(pr.load(state_file).invalidated);
    for (const text of ['WORK.md', '<!-- own-harness-work:v1 -->', '.harness/private/records/key.json', 'contract_sha256: abc123', path.join(root, '.worktrees'), path.join(root, 'work/sample/repos/project'), 'work/sample/evidence/research.md', 'work/sample/.worktrees/worker', 'task_workspace: local']) {
      write(document, '# PR.md\n## 제목\nfix: example\n## 본문\n' + text);
      reject(() => pr.read_document(document));
    }
    passed('new user input/policy changes invalidate PR approval; private metadata rejected');

    const previous = path.join(root, '.githooks');
    fs.mkdirSync(previous);
    const hook_log = path.join(directory, 'hook-log');
    write(path.join(previous, 'pre-commit'), '#!/bin/sh\nprintf "original\\n" >> "$FIXTURE_HOOK_LOG"\nexit 7\n');
    fs.chmodSync(path.join(previous, 'pre-commit'), 0o755);
    const wrapper = path.join(root, '.harness/private/hooks/project');
    fs.mkdirSync(wrapper, { recursive: true });
    const hook_config = path.join(wrapper, 'config.json');
    write(hook_config, JSON.stringify({ workspace: root, common_dir: git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), previous_path: previous, previous_configured: true }));
    process.env.FIXTURE_HOOK_LOG = hook_log;
    const result = spawnSync(process.execPath, [path.join(runtime, 'work-hook.js'), hook_config, 'pre-commit'], { cwd: tree, encoding: 'utf8' });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(read(hook_log), 'original\n');
    write(path.join(previous, 'pre-commit'), '#!/bin/sh\nprintf "changed by original hook\\n" > a.txt\ngit add a.txt\n');
    fs.chmodSync(path.join(previous, 'pre-commit'), 0o755);
    const wrapper_command = '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(path.join(runtime, 'work-hook.js')) + ' ' + quote(hook_config) + ' pre-commit "$@"\n';
    write(path.join(wrapper, 'pre-commit'), wrapper_command);
    fs.chmodSync(path.join(wrapper, 'pre-commit'), 0o755);
    git(tree, 'config', 'core.hooksPath', wrapper);
    const before = git(tree, 'rev-parse', 'HEAD');
    run(tree, ['git', 'commit', '--allow-empty', '-m', 'test: reject hook mutation'], { ok: false });
    assert.equal(git(tree, 'rev-parse', 'HEAD'), before);
    assert.equal(read(path.join(tree, 'a.txt')), 'changed by original hook\n');
    w.record('sample', 'verification', '원본 hook이 stage한 최종 내용 재검증', 'independent');
    git(tree, 'commit', '-m', 'test: verified hook mutation');
    w.record('sample', 'verification', 'commit 이후 HEAD 재검증', 'independent');
    git(tree, 'config', 'core.hooksPath', '/dev/null');
    fs.unlinkSync(path.join(previous, 'pre-commit'));
    write(path.join(previous, 'pre-push'), '#!/bin/sh\nprintf "%s|%s|%s\\n" "$PWD" "$1" "$2" > "$FIXTURE_HOOK_LOG"\ncat >> "$FIXTURE_HOOK_LOG"\n');
    fs.chmodSync(path.join(previous, 'pre-push'), 0o755);
    let sha = git(tree, 'rev-parse', 'HEAD');
    let update = `HEAD ${sha} refs/heads/sample ${'0'.repeat(40)}\n`;
    run(tree, [process.execPath, path.join(runtime, 'work-hook.js'), hook_config, 'pre-push', 'origin', '/ordinary/remote.git'], { data: update });
    assert.equal(read(hook_log), `${tree}|origin|/ordinary/remote.git\n` + update);
    run(tree, [process.execPath, path.join(runtime, 'check-workspace.js'), 'pre-commit'], { env: { ...process.env, GIT_AUTHOR_EMAIL: 'other@example.invalid' }, ok: false });
    passed('original hook failure/cwd/argv/stdin preserved; hook index mutation and identity override rejected');

    const internal = path.join(tree, 'WORK.md');
    write(internal, 'internal record');
    git(tree, 'add', 'WORK.md');
    git(tree, 'commit', '-m', 'test: internal record');
    git(tree, 'rm', 'WORK.md');
    git(tree, 'commit', '-m', 'test: remove internal record');
    w.record('sample', 'verification', '내부 경로 이력 검사', 'independent');
    sha = git(tree, 'rev-parse', 'HEAD');
    update = `HEAD ${sha} refs/heads/sample ${'0'.repeat(40)}\n`;
    const args = [process.execPath, path.join(runtime, 'work-hook.js'), hook_config, 'pre-push', 'origin'];
    run(tree, [...args, '/ordinary/remote.git'], { data: update, ok: false });
    run(tree, [...args, 'https://github.com/example/public.git'], { data: update, ok: false });
    process.env.FIXTURE_PRIVATE = 'true';
    run(tree, [...args, 'https://github.com/example/private.git'], { data: update });
    run(tree, [...args, 'https://other.example/project.git'], { data: update, ok: false });
    passed('internal deleted history requires private=true on the actual GitHub push URL');

    assert.equal(c.canonical_json({ z: '한글', '10': true, '2': false, a: { z: null, b: [2, 1] } }), '{"10":true,"2":false,"a":{"b":[2,1],"z":null},"z":"한글"}');
    reject(() => c.safe_path(root, '.harness', '..', 'outside'), '밖 경로');
    reject(() => w.task_name('sample\n'), '작업 ID');
    const lock = path.join(root, '.harness/private/test.lock.d');
    reject(() => c.with_lock(lock, () => { throw new Error('fixture failure'); }), 'fixture failure');
    assert.ok(!fs.existsSync(lock));
    assert.equal(c.with_lock(lock, () => 42), 42);
    fs.symlinkSync(root, lock);
    reject(() => c.with_lock(lock, () => assert.fail('unsafe lock acquired')), '잠금 경로');
    fs.unlinkSync(lock);
    passed('canonical JSON, strict IDs, path traversal and lock release/symlink rejection');
    log(`runtime: ${count} regression groups passed (temporary repositories and fake gh only)`);
  } finally {
    console.log = log;
    for (const key of Object.keys(process.env)) if (!(key in previous_env)) delete process.env[key];
    Object.assign(process.env, previous_env);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test('directory locks serialize concurrent Bun processes without losing updates', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-harness-lock-')));
  try {
    const counter = path.join(directory, 'counter.json');
    const lock = path.join(directory, 'counter.lock.d');
    const worker = path.join(directory, 'worker.js');
    write(counter, '0');
    write(worker, `import fs from 'node:fs';\nimport {with_lock} from ${JSON.stringify(pathToFileURL(path.join(SOURCE, 'harness_common.js')).href)};\nfor (let i = 0; i < 12; i++) with_lock(process.argv[2], () => {\n  const value = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);\n  fs.writeFileSync(process.argv[3], JSON.stringify(value + 1));\n});\n`);
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, lock, counter], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}: ${stderr}`)));
    })));
    assert.equal(JSON.parse(read(counter)), 48);
    assert.ok(!fs.existsSync(lock));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

test('invalid UTF-8 Git filenames fail closed before recording or checking evidence', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-harness-git-bytes-')));
  const previous_env = { ...process.env };
  const log = console.log;
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    console.log = () => {};
    const root = path.join(directory, 'workspace');
    repository(root);
    const runtime = path.join(root, '.harness/runtime');
    fs.cpSync(SOURCE, runtime, { recursive: true });
    write(path.join(root, '.harness/config.json'), JSON.stringify({ schema: 1, repos: { project: '.' } }));
    const checkout = path.join(root, 'work/bytes/repos/project');
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    git(root, 'worktree', 'add', '-b', 'bytes', checkout, 'main');
    const w = await module(path.join(runtime, 'work.js'));
    w.init('bytes', checkout, 'main', []);
    const file = w.work_path('bytes');
    write(file, read(file).replace('목표: 작성 필요', '목표: 실제 파일 내용을 검증한다').replace('범위: 작성 필요', '범위: 저장소 파일').replace('완료 조건: 작성 필요', '완료 조건: 지원하지 않는 파일명은 차단한다'));
    const bom_name = '\ufeffvalid.txt';
    const bom_file = path.join(checkout, bom_name);
    write(bom_file, 'initial BOM-named content\n');
    git(checkout, 'add', '--', bom_name);
    const bom_entry = { ...w.read_work('bytes')[1].repos.project, scope: [bom_name] };
    const before = w.fingerprint('bytes', 'project', bom_entry).current_fingerprint;
    write(bom_file, 'changed BOM-named content\n');
    assert.notEqual(w.fingerprint('bytes', 'project', bom_entry).current_fingerprint, before, 'A leading U+FEFF in a valid filename must be preserved when hashing its content');
    const invalid_name = Buffer.concat([Buffer.from('invalid-'), Buffer.from([0xff]), Buffer.from('.txt')]);
    const invalid_file = Buffer.concat([Buffer.from(checkout + '/'), invalid_name]);
    let physical_file = true;
    const index_file = contents => {
      const blob = run(checkout, ['git', 'hash-object', '-w', '--stdin'], { data: contents });
      run(checkout, ['git', 'update-index', '--add', '-z', '--index-info'], { data: Buffer.concat([Buffer.from(`100644 ${blob}\t`), invalid_name, Buffer.from([0])]) });
    };
    try { fs.writeFileSync(invalid_file, 'initial content\n'); }
    catch (error) {
      // macOS filesystems/sandboxes can reject invalid byte paths; Git still accepts them in its index.
      if (!['EPERM', 'EINVAL', 'EILSEQ'].includes(error.code)) throw error;
      physical_file = false;
    }
    if (physical_file) git(checkout, 'add', '--', '.');
    else index_file('initial content\n');
    assert.ok(w.common.git(checkout, 'ls-files', '-z', { binary: true }).includes(0xff), 'Git fixture must retain the invalid filename byte');
    reject(() => w.record('bytes', 'research', '파일 내용 조사'), 'UTF-8');
    reject(() => w.snapshot('bytes'), 'UTF-8');
    if (physical_file) fs.writeFileSync(invalid_file, 'changed without staging\n');
    else index_file('changed content\n');
    reject(() => w.check(checkout), 'UTF-8');
    reject(() => w.check(checkout, true), 'UTF-8');
    assert.deepEqual(w.read_work('bytes')[1].phases, {});
  } finally {
    console.log = log;
    for (const key of Object.keys(process.env)) if (!(key in previous_env)) delete process.env[key];
    Object.assign(process.env, previous_env);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

test('task workspace privacy recognizes internal paths without blocking ordinary work source', async () => {
  const guard = await module(path.join(SOURCE, 'pr-guard.js'));
  const hooks = await module(path.join(SOURCE, 'work-hook.js'));
  for (const file of ['work/feature/WORK.md', 'work/feature/evidence/test.log', 'work/feature/.worktrees/worker', 'work/feature/repos/project']) {
    assert.ok(hooks.internal_path(file), file);
    reject(() => guard.reject_internal_metadata('검증 기록: `' + file + '`'), 'PR.md');
  }
  for (const file of ['work/foo.js', 'work/feature/handler.js', 'src/work/feature/evidence/test.js', 'work/feature/evidence.md']) {
    assert.ok(!hooks.internal_path(file), file);
  }
  for (const text of ['work/foo.js에서 처리합니다.', 'payload.worker_id를 반환합니다.', '작업 폴더의 일반 소스 work/feature/handler.js']) {
    guard.reject_internal_metadata(text);
  }
  reject(() => guard.reject_internal_metadata('검사: `work/feature/evidence`'), 'PR.md');
  reject(() => guard.reject_internal_metadata('worker_id: child-one'), '메타데이터');
});
