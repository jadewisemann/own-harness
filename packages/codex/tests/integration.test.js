/** Offline flows use temporary repositories, local bare remotes, and fake gh.
 * Synthetic events are inputs to a copied module, never live Codex approval evidence.
 */
import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function write(file, text, mode = 0o644) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, text, 'utf8');
    fs.chmodSync(file, mode);
}
function run(cwd, args, {reject = null, data = undefined, env = process.env} = {}) {
    const result = spawnSync(String(args[0]), args.slice(1).map(String), {cwd, input: data, encoding: 'utf8', timeout: 45000, env});
    if (result.error) throw result.error;
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    if (reject === null) assert.equal(result.status, 0, `${args.join(' ')}\n${output}`);
    else assert.ok(result.status !== 0 && output.includes(reject), `${args.join(' ')}\n${result.status}\n${output}`);
    return result.stdout.trim();
}
async function protocol_hook(tree) {
    const wrapper = path.join(run(tree, ['git', 'config', '--get', 'core.hooksPath']), 'proc-receive');
    const child = spawn(wrapper, ['fixture-token'], {cwd: tree, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', errors = '', responded = false;
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Protocol hook buffered stdin instead of streaming its greeting')); }, 10000);
        child.stdout.on('data', chunk => {
            output += chunk.toString();
            if (!responded && output.includes('hello fixture-token\n')) {
                responded = true;
                child.stdin.end('fixture-response\n');
            }
        });
        child.stderr.on('data', chunk => { errors += chunk.toString(); });
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', code => {
            clearTimeout(timeout);
            if (code === 0) resolve(); else reject(new Error(`Protocol hook exited ${code}: ${errors}`));
        });
    });
    assert.equal(output, 'hello fixture-token\ndone\n');
}
function saved(file) { return fs.existsSync(file) ? [fs.readFileSync(file), fs.statSync(file).mode & 0o7777] : null; }
function repository(repo, tracked_agents = false) {
    fs.mkdirSync(repo, {recursive: true});
    run(repo, ['git', 'init', '-q', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Integration Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false']]) {
        run(repo, ['git', 'config', key, value]);
    }
    write(path.join(repo, 'a.txt'), 'original\n');
    write(path.join(repo, 'b.txt'), 'outside scope\n');
    write(path.join(repo, 'AGENTS.md'), '# Local instructions\n\nKeep the existing instructions.\n', 0o640);
    write(path.join(repo, '.husky/pre-commit'), '#!/bin/sh\npwd >> "$FIXTURE_COMMIT_CWD"\n' +
        '[ ! -e "$FIXTURE_FAIL_HOOK" ] || { echo "fixture hook failure" >&2; exit 23; }\n', 0o755);
    write(path.join(repo, '.husky/pre-push'), '#!/bin/sh\npwd >> "$FIXTURE_PUSH_CWD"\n' +
        'printf "%s\\n%s\\n" "$1" "$2" >> "$FIXTURE_PUSH_ARGS"\ncat >> "$FIXTURE_PUSH_INPUT"\n', 0o755);
    write(path.join(repo, '.husky/proc-receive'), '#!/bin/sh\nprintf "hello %s\\n" "$1"\n' +
        'IFS= read -r reply\n[ "$reply" = "fixture-response" ] || exit 19\nprintf "done\\n"\n', 0o755);
    run(repo, ['git', 'add', 'a.txt', 'b.txt', '.husky']);
    if (tracked_agents) run(repo, ['git', 'add', 'AGENTS.md']);
    run(repo, ['git', 'commit', '-qm', 'test: initial fixture']);
    run(repo, ['git', 'config', 'core.hooksPath', '.husky']);
    write(path.join(repo, '.codex/config.toml'), 'model = "fixture-model"\n', 0o640);
    write(path.join(repo, '.codex/hooks.json'), JSON.stringify({hooks: {UserPromptSubmit: [{hooks: [{type: 'command', command: 'printf fixture-existing-hook'}]}]}}) + '\n', 0o640);
    write(path.join(repo, '.agents/skills/existing/SKILL.md'), '# Existing skill\n', 0o640);
    write(path.join(repo, '.git/info/exclude'), '# Existing excludes\nlocal-note.txt\n', 0o640);
    return Object.fromEntries(['AGENTS.md', '.codex/config.toml', '.codex/hooks.json', '.agents/skills/existing/SKILL.md', '.husky/pre-commit', '.husky/pre-push', '.husky/proc-receive', '.git/info/exclude']
        .map(name => [name, saved(path.join(repo, name))]));
}
function fill_contract(file) {
    let text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('own-harness-work:v1'));
    for (const [label, value] of [['목표', '임시 파일 전달 흐름을 확인한다'], ['범위', '임시 저장소와 검사'], ['완료 조건', '실제 CLI와 로컬 Git 전달 검사 통과']]) {
        assert.ok(text.includes(label + ': 작성 필요'), text);
        text = text.replace(label + ': 작성 필요', label + ': ' + value);
    }
    fs.writeFileSync(file, text, 'utf8');
}
function restore_check(repo, originals, retained = ['/.harness/']) {
    for (const [name, original] of Object.entries(originals)) {
        if (name === '.git/info/exclude') {
            const [current, mode] = saved(path.join(repo, name));
            assert.equal(mode, original[1]);
            assert.deepEqual(current.subarray(0, original[0].length), original[0]);
            const appended = current.subarray(original[0].length).toString().split('\n').filter(Boolean);
            assert.deepEqual(new Set(appended), new Set(retained));
        } else assert.deepEqual(saved(path.join(repo, name)), original, `original bytes/mode changed: ${path.join(repo, name)}`);
    }
    assert.equal(run(repo, ['git', 'config', '--get', 'core.hooksPath']), '.husky');
    const probes = retained.map(relative => relative.slice(1) + 'retained');
    if (probes.length) assert.deepEqual(run(repo, ['git', 'check-ignore', ...probes]).split('\n'), probes);
}
async function single_flow(package_root, temp) {
    const workspace = path.join(temp, '낯선 이름 single repo');
    const originals = repository(workspace);
    const harness = path.join(package_root, 'harness.js');
    run(temp, [process.execPath, harness, 'install', workspace]);
    const installed = path.join(workspace, '.harness');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installed, 'config.json'), 'utf8')), {schema: 1, repos: {project: '.'}});
    run(temp, [process.execPath, harness, 'install', workspace]);
    run(temp, [process.execPath, harness, 'doctor', workspace]);
    assert.ok(fs.readFileSync(path.join(workspace, '.codex/hooks.json'), 'utf8').includes('fixture-existing-hook'));
    assert.ok(fs.readFileSync(path.join(workspace, '.codex/config.toml'), 'utf8').includes('use_memories = false'));
    run(workspace, ['git', 'commit', '--allow-empty', '-qm', 'test: baseline rejected'], {reject: 'baseline'});
    const runtime = path.join(installed, 'runtime');
    const task = 'single-flow';
    const work = (args, reject = null) => run(workspace, [process.execPath, path.join(runtime, 'work.js'), ...args], {reject});
    const record = (phase, evidence = null, reject = null) => {
        const args = ['record', task, phase, '--evidence', evidence ?? phase + ': temporary file and contract inspected'];
        if (phase === 'verification') args.push('--reviewer', 'integration-fixture-checker');
        return work(args, reject);
    };
    work(['start', task, '--repo', 'project', '--base', 'main', '--branch', 'test/single-flow']);
    const tree = path.join(workspace, 'work', task, 'project');
    const document = path.join(workspace, 'work', task, 'task.md');
    fill_contract(document);
    assert.ok(fs.statSync(path.join(tree, '.git')).isFile());
    for (const checkout of [workspace, tree]) {
        assert.ok(fs.readFileSync(path.join(checkout, '.codex/config.toml'), 'utf8').includes('use_memories = false'));
        assert.equal(run(checkout, ['git', 'check-ignore', '.codex/config.toml']), '.codex/config.toml');
        assert.ok(fs.existsSync(path.join(checkout, '.agents/skills/pstack-codex/SKILL.md')));
        assert.ok(fs.existsSync(path.join(checkout, 'AGENTS.override.md')));
    }
    await protocol_hook(tree);
    // Import only the installed fixture copy; do not invoke a real hook entrypoint.
    const guard = await import(pathToFileURL(path.join(runtime, 'pr-guard.js')).href);
    assert.ok(guard.STATE_DIR.startsWith(temp + path.sep));
    let event_number = 0;
    const event = (prompt, {reject = null, ...extra} = {}) => {
        const payload = {hook_event_name: 'UserPromptSubmit', session_id: process.env.CODEX_THREAD_ID,
            turn_id: `fixture-turn-${++event_number}`, cwd: tree, prompt, ...extra};
        const output = [];
        const previous = console.log;
        console.log = (...values) => output.push(values.join(' '));
        try {
            guard.hook(payload);
            assert.equal(reject, null, 'Synthetic event should have been rejected');
        } catch (error) {
            assert.ok(reject !== null && error.message.includes(reject), error.message);
            return error.message;
        } finally { console.log = previous; }
        return output.join('\n');
    };
    assert.ok(event('작업 통제 ' + task).includes('사용자 통제로'));
    record('research');
    record('design');
    record('implementation', null, '사용자 통제');
    let decision = work(['decision', task]);
    let code = decision.match(new RegExp('작업 승인 ' + task + ' ([a-f0-9]{12})'))[1];
    const approval = '작업 승인 ' + task + ' ' + code;
    event(approval, {turn_id: null, reject: 'turn_id'});
    record('implementation', null, '사용자 통제');
    event(approval, {agent_id: 'fixture-child', reject: '하위 에이전트'});
    record('implementation', null, '사용자 통제');
    assert.ok(event(approval).includes('현재 작업 계약 승인'));
    write(path.join(tree, 'a.txt'), 'verified product change\n');
    record('implementation');
    record('verification');
    run(tree, ['git', 'add', 'a.txt']);
    work(['check', '--cwd', tree, '--delivery'], '검증 뒤 바뀌었습니다');
    run(tree, ['git', 'diff', '--check']);
    record('verification', 'git diff --check succeeded; staged a.txt contains the expected product change');
    work(['check', '--cwd', tree, '--delivery']);
    const head = run(tree, ['git', 'rev-parse', 'HEAD']);
    write(path.join(tree, 'a.txt'), 'unverified change\n');
    run(tree, ['git', 'commit', '-qm', 'test: stale rejected'], {reject: '검증 뒤 바뀌었습니다'});
    assert.equal(run(tree, ['git', 'rev-parse', 'HEAD']), head);
    run(tree, ['git', 'restore', 'a.txt']);
    fs.writeFileSync(process.env.FIXTURE_FAIL_HOOK, '');
    run(tree, ['git', 'commit', '-qm', 'test: hook rejected'], {reject: 'fixture hook failure'});
    assert.equal(run(tree, ['git', 'rev-parse', 'HEAD']), head);
    fs.unlinkSync(process.env.FIXTURE_FAIL_HOOK);
    run(tree, ['git', 'diff', '--check']);
    run(tree, ['git', 'commit', '-qm', 'test: actual product change']);
    const tip = run(tree, ['git', 'rev-parse', 'HEAD']);
    assert.notEqual(tip, head);
    assert.equal(fs.readFileSync(process.env.FIXTURE_COMMIT_CWD, 'utf8').trim().split('\n').at(-1), tree);
    const remote = path.join(temp, 'local remote.git');
    run(temp, ['git', 'init', '--bare', '-q', remote]);
    run(tree, ['git', 'remote', 'add', 'local', remote]);
    run(tree, ['git', 'remote', 'add', 'origin', 'https://github.com/fixture/integration.git']);
    run(tree, ['git', 'push', 'local', 'HEAD:refs/heads/test/single-flow'], {reject: '검증 뒤 바뀌었습니다'});
    work(['snapshot', task]);
    work(['check', '--cwd', tree, '--delivery'], '검증 뒤 바뀌었습니다');
    run(tree, ['git', 'diff', '--check', 'HEAD^', 'HEAD']);
    assert.equal(fs.readFileSync(path.join(tree, 'a.txt'), 'utf8'), 'verified product change\n');
    record('verification', 'Post-commit git diff --check HEAD^ HEAD succeeded; a.txt matches expected bytes');
    run(tree, ['git', 'push', 'local', 'HEAD:refs/heads/test/single-flow']);
    assert.equal(run(remote, ['git', 'rev-parse', 'refs/heads/test/single-flow']), tip);
    assert.equal(fs.readFileSync(process.env.FIXTURE_PUSH_CWD, 'utf8').trim().split('\n').at(-1), tree);
    assert.deepEqual(fs.readFileSync(process.env.FIXTURE_PUSH_ARGS, 'utf8').trim().split('\n').slice(-2), ['local', remote]);
    assert.deepEqual(fs.readFileSync(process.env.FIXTURE_PUSH_INPUT, 'utf8').trim().split('\n').at(-1).split(/\s+/), ['HEAD', tip, 'refs/heads/test/single-flow', '0'.repeat(40)]);
    const pr = path.join(temp, 'PR.md');
    write(pr, '# PR.md\n\n## 제목\n\nfix: isolated integration\n\n## 본문\n\nTemporary file change and local verification.\n');
    const pr_cli = (args, reject = null) => run(tree, [process.execPath, path.join(runtime, 'pr-guard.js'), ...args], {reject});
    const review = () => {
        pr_cli(['review', pr, '--cwd', tree, '--base', 'main']);
        const name = createHash('sha256').update(process.env.CODEX_THREAD_ID).digest('hex') + '.json';
        return JSON.parse(fs.readFileSync(path.join(installed, 'private/pr-approvals', name), 'utf8')).token;
    };
    let token = review();
    pr_cli(['create'], '승인');
    event('PR 승인 ' + token, {turn_id: null, reject: 'turn_id'});
    pr_cli(['create'], '승인');
    token = review();
    event('PR 승인 ' + token, {agent_id: 'fixture-child', reject: '하위 에이전트'});
    pr_cli(['create'], '승인');
    token = review();
    event('PR 승인 ' + token);
    write(path.join(tree, 'a.txt'), 'changed after approval\n');
    pr_cli(['create'], 'delivery');
    assert.ok(!fs.existsSync(process.env.FIXTURE_GH_LOG));
    run(tree, ['git', 'restore', 'a.txt']);
    pr_cli(['create'], '승인');
    token = review();
    event('PR 승인 ' + token);
    pr_cli(['create']);
    pr_cli(['create'], '승인');
    const sent = fs.readFileSync(process.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].cwd, tree);
    assert.ok(sent[0].args.includes('--draft'));
    assert.equal(sent[0].body, 'Temporary file change and local verification.\n');
    // Internal paths require proven private visibility for the actual push URL.
    write(path.join(tree, 'work/private-fixture/evidence/check.md'), 'private fixture evidence\n');
    run(tree, ['git', 'add', '-f', 'work/private-fixture/evidence/check.md']);
    record('verification', 'Private fixture is staged for local history transfer rejection check');
    run(tree, ['git', 'commit', '-qm', 'test: private fixture history']);
    record('verification', 'Post-commit private history and product file were inspected');
    run(tree, ['git', 'push', 'local', 'HEAD:refs/heads/test/single-flow'], {reject: 'internal'});
    assert.equal(run(remote, ['git', 'rev-parse', 'refs/heads/test/single-flow']), tip);
    const new_tip = run(tree, ['git', 'rev-parse', 'HEAD']);
    const push_hook = path.join(run(tree, ['git', 'config', '--get', 'core.hooksPath']), 'pre-push');
    const public_refs = `HEAD ${new_tip} refs/heads/test/single-flow ${'0'.repeat(40)}\n`;
    run(tree, [push_hook, 'origin', 'https://github.com/fixture/integration.git'], {data: public_refs, reject: 'private=true'});
    assert.ok(fs.readFileSync(process.env.FIXTURE_API_LOG, 'utf8').includes('repos/fixture/integration'));
    token = review();
    event('PR 승인 ' + token);
    const changed = path.join(temp, 'updated package');
    fs.cpSync(package_root, changed, {recursive: true, filter: item => !['.git', 'node_modules', '__pycache__'].includes(path.basename(item))});
    fs.appendFileSync(path.join(changed, 'runtime/work.js'), '\n// Integration fixture: changed runtime policy bytes.\n');
    run(temp, [process.execPath, path.join(changed, 'harness.js'), 'update', workspace]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'private/work-control', task + '.json'), 'utf8')).mode, 'human');
    work(['check', '--cwd', tree, '--delivery'], '사용자 통제');
    pr_cli(['create'], '승인');
    assert.equal(fs.readFileSync(process.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').length, 1);
    decision = work(['decision', task]);
    code = decision.match(new RegExp('작업 승인 ' + task + ' ([a-f0-9]{12})'))[1];
    assert.ok(event('작업 승인 ' + task + ' ' + code).includes('현재 작업 계약 승인'));
    work(['check', '--cwd', tree, '--delivery'], '작업 계약이 바뀌었습니다');
    const kept_record = fs.readFileSync(document);
    run(temp, [process.execPath, path.join(changed, 'harness.js'), 'uninstall', workspace]);
    restore_check(workspace, originals, ['/.harness/', '/work/']);
    assert.deepEqual(fs.readFileSync(document), kept_record);
    assert.ok(fs.statSync(tree).isDirectory());
    assert.equal(run(tree, ['git', 'rev-parse', 'HEAD']), new_tip);
    for (const item of ['AGENTS.md', '.codex/config.toml', 'AGENTS.override.md']) assert.ok(!fs.existsSync(path.join(tree, item)));
}
function multi_flow(package_root, temp) {
    const workspace = path.join(temp, '상위 non git workspace');
    fs.mkdirSync(workspace);
    const mapping = {project: '서버 코드', workspace: 'web client'};
    const originals = Object.fromEntries(Object.entries(mapping).map(([name, relative]) => [name, repository(path.join(workspace, relative), true)]));
    const harness = path.join(package_root, 'harness.js');
    const args = [process.execPath, harness, 'install', workspace];
    for (const [name, relative] of Object.entries(mapping)) args.push('--repo', name + '=' + relative);
    run(temp, args);
    run(temp, args);
    assert.ok(!fs.existsSync(path.join(workspace, '.git')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, '.harness/config.json'), 'utf8')).repos, mapping);
    run(temp, [process.execPath, harness, 'doctor', workspace]);
    for (const [name, relative] of Object.entries(mapping)) {
        const baseline = path.join(workspace, relative);
        assert.deepEqual(saved(path.join(baseline, 'AGENTS.md')), originals[name]['AGENTS.md']);
        assert.equal(run(baseline, ['git', 'diff', '--name-only']), '');
        run(workspace, [process.execPath, path.join(workspace, '.harness/runtime/work.js'), 'start', 'paired', '--repo', name, '--base', 'main', '--branch', 'test/paired']);
        const tree = path.join(workspace, 'work/paired', name);
        assert.equal(run(tree, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']), path.join(baseline, '.git'));
        assert.equal(run(tree, ['git', 'diff', '--name-only']), '');
    }
    const record = path.join(workspace, 'work/paired/task.md');
    fill_contract(record);
    const managed = path.join(workspace, '.harness/templates/AGENTS.fragment.md');
    const prior = saved(managed);
    fs.appendFileSync(managed, '\nUser modification must survive a rejected update.\n');
    const drift = fs.readFileSync(managed);
    run(temp, [process.execPath, harness, 'update', workspace], {reject: 'managed file drift'});
    assert.deepEqual(fs.readFileSync(managed), drift);
    fs.writeFileSync(managed, prior[0]);
    fs.chmodSync(managed, prior[1]);
    run(temp, [process.execPath, harness, 'update', workspace]);
    const kept_record = fs.readFileSync(record);
    run(temp, [process.execPath, harness, 'uninstall', workspace]);
    for (const [name, relative] of Object.entries(mapping)) {
        restore_check(path.join(workspace, relative), originals[name]);
        const tree = path.join(workspace, 'work/paired', name);
        assert.ok(fs.statSync(path.join(tree, '.git')).isFile());
        assert.equal(run(tree, ['git', 'config', '--get', 'core.hooksPath']), '.husky');
        assert.deepEqual(fs.readFileSync(path.join(tree, 'AGENTS.md')), originals[name]['AGENTS.md'][0]);
        assert.equal(fs.statSync(path.join(tree, 'AGENTS.md')).mode & 0o7777, fs.statSync(path.join(tree, 'a.txt')).mode & 0o7777);
        assert.ok(!fs.existsSync(path.join(tree, '.codex/config.toml')));
        assert.ok(!fs.existsSync(path.join(tree, 'AGENTS.override.md')));
    }
    assert.deepEqual(fs.readFileSync(record), kept_record);
}

test('installed Bun CLI, worktree delivery guards, PR approval, hooks, privacy, update and uninstall', async () => {
    for (const relative of ['harness.js', 'runtime/work.js', 'runtime/pr-guard.js', 'runtime/harness_common.js', 'skills/pstack-codex/SKILL.md', 'templates/AGENTS.fragment.md']) {
        assert.ok(fs.statSync(path.join(source, relative)).isFile(), `Missing package input: ${relative}`);
    }
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-harness-integration-')));
    const original_env = {...process.env};
    try {
        const fakebin = path.join(temp, 'bin');
        fs.mkdirSync(fakebin);
        const empty_template = path.join(temp, 'empty-template');
        fs.mkdirSync(empty_template);
        for (const key of Object.keys(process.env)) if (/^(GIT_|CODEX_|HARNESS_)/.test(key)) delete process.env[key];
        Object.assign(process.env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TEMPLATE_DIR: empty_template, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', CODEX_THREAD_ID: 'isolated-integration-fixture',
            PATH: fakebin + path.delimiter + process.env.PATH});
        for (const key of ['COMMIT_CWD', 'PUSH_CWD', 'PUSH_ARGS', 'PUSH_INPUT', 'FAIL_HOOK', 'GH_LOG', 'API_LOG']) process.env['FIXTURE_' + key] = path.join(temp, key.toLowerCase());
        write(path.join(fakebin, 'gh'), `#!${process.execPath}\n` +
            `const fs = require('node:fs');\nconst args = process.argv.slice(2);\n` +
            `if (args[0] === 'api') { fs.writeFileSync(process.env.FIXTURE_API_LOG, JSON.stringify(args)); console.log('false'); }\n` +
            `else if (args[0] === 'pr' && args[1] === 'create') {\n` +
            ` const body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');\n` +
            ` fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify({args, body, cwd: process.cwd()}) + '\\n');\n` +
            ` console.log('https://github.com/fixture/integration/pull/1');\n` +
            `} else { throw new Error('Unexpected fake gh call: ' + JSON.stringify(args)); }\n`, 0o755);
        await single_flow(source, temp);
        multi_flow(source, temp);
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in original_env)) delete process.env[key];
        Object.assign(process.env, original_env);
        fs.rmSync(temp, {recursive: true, force: true});
    }
}, 180000);

test('worker delivery passes locally but Git push and PR review/create are denied from the task folder', () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-publish-')));
    const original_env = {...process.env};
    try {
        for (const key of Object.keys(process.env)) if (/^(GIT_|CODEX_|HARNESS_)/.test(key) || key === 'OWN_HARNESS_CHILD') delete process.env[key];
        const fakebin = path.join(temp, 'bin');
        fs.mkdirSync(fakebin);
        const empty_template = path.join(temp, 'empty-template');
        fs.mkdirSync(empty_template);
        Object.assign(process.env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TEMPLATE_DIR: empty_template, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', CODEX_THREAD_ID: 'isolated-worker-publish-fixture',
            PATH: fakebin + path.delimiter + process.env.PATH});
        for (const key of ['COMMIT_CWD', 'PUSH_CWD', 'PUSH_ARGS', 'PUSH_INPUT', 'FAIL_HOOK', 'GH_LOG']) process.env['FIXTURE_' + key] = path.join(temp, key.toLowerCase());
        write(path.join(fakebin, 'gh'), '#!/bin/sh\nprintf invoked >> "$FIXTURE_GH_LOG"\nexit 91\n', 0o755);
        const workspace = path.join(temp, 'project');
        repository(workspace);
        run(temp, [process.execPath, path.join(source, 'harness.js'), 'install', workspace]);
        const runtime = path.join(workspace, '.harness/runtime');
        const work = args => run(workspace, [process.execPath, path.join(runtime, 'work.js'), ...args]);
        work(['start', 'publish', '--repo', 'project', '--base', 'main', '--branch', 'codex/publish']);
        const task_root = path.join(workspace, 'work/publish');
        const lead = path.join(task_root, 'project');
        const worker = path.join(task_root, '.sub-workspace/author/project');
        fill_contract(path.join(task_root, 'task.md'));
        work(['record', 'publish', 'research', '--evidence', 'Inspected fixture files and publishing constraints']);
        work(['record', 'publish', 'design', '--evidence', 'Assigned a.txt to one worker and reserved delivery for the lead']);
        work(['fork', 'publish', 'author', '--repo', 'project', '--owner', 'fixture-author', '--scope', 'a.txt']);
        write(path.join(worker, 'a.txt'), 'worker result\n');
        run(worker, ['git', 'add', 'a.txt']);
        const evidence = path.join(task_root, 'evidence/author.md');
        write(evidence, 'Inspected staged a.txt; fixture change is ready for local commit.\n');
        const result = () => work(['result', 'publish', 'author', '--evidence', '@' + evidence]);
        result();
        run(worker, ['git', 'commit', '-qm', 'test: worker local result']);
        result();
        work(['check', '--cwd', worker, '--delivery']);
        const remote = path.join(temp, 'remote.git');
        run(temp, ['git', 'init', '--bare', '-q', remote]);
        run(lead, ['git', 'remote', 'add', 'local', remote]);
        run(lead, ['git', 'remote', 'add', 'origin', 'https://github.com/fixture/worker-publish.git']);
        // Git enters the worker for its real pre-push hook even when the shell is in the task folder.
        run(task_root, ['git', '-C', worker, 'push', 'local', 'HEAD:refs/heads/worker'], {reject: 'worker branch는 push·PR'});
        assert.equal(run(remote, ['git', 'for-each-ref', '--format=%(refname)', 'refs/heads/worker']), '');
        assert.ok(!fs.existsSync(process.env.FIXTURE_PUSH_INPUT), 'The original pre-push hook must not run after the worker gate rejects');
        const document = path.join(temp, 'PR.md');
        write(document, '# PR.md\n## 제목\nfix: worker fixture\n## 본문\nLocal temporary test result.\n');
        const pr = path.join(runtime, 'pr-guard.js');
        run(task_root, [process.execPath, pr, 'review', document, '--cwd', worker, '--base', 'main'], {reject: 'worker branch는 push·PR'});
        // The task directory cannot stand in for a registered integration checkout.
        run(task_root, [process.execPath, pr, 'review', document, '--base', 'release'], {reject: 'baseline'});
        // Model an old on-disk approval in this isolated fixture: create must revalidate its checkout.
        const state_file = path.join(workspace, '.harness/private/pr-approvals', createHash('sha256').update(process.env.CODEX_THREAD_ID).digest('hex') + '.json');
        write(state_file, JSON.stringify({approved: true, approval_turn: 'fixture-turn', approval_session: process.env.CODEX_THREAD_ID,
            consumed: false, invalidated: false, proposal: {file: document, cwd: worker, base: 'main', draft: true}}));
        run(task_root, [process.execPath, pr, 'create'], {reject: 'worker branch는 push·PR'});
        assert.equal(JSON.parse(fs.readFileSync(state_file, 'utf8')).invalidated, true);
        assert.ok(!fs.existsSync(process.env.FIXTURE_GH_LOG), 'Worker publishing must be denied before invoking gh');
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in original_env)) delete process.env[key];
        Object.assign(process.env, original_env);
        fs.rmSync(temp, {recursive: true, force: true});
    }
}, 60000);
