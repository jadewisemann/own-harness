#!/usr/bin/env bun
/** Review PR.md, accept a user hook approval, then create that exact PR once. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import * as common from './harness_common.js';
import { state_for } from './steering.js';

export const SCRIPT = fs.realpathSync(fileURLToPath(import.meta.url));
export const WORKSPACE = path.dirname(path.dirname(path.dirname(SCRIPT)));
export const STATE_DIR = path.join(WORKSPACE, '.harness/private/pr-approvals');
const FORMAT = "PR.md는 '# PR.md → ## 제목 → 한 줄 제목 → ## 본문 → 본문' 순서여야 합니다.";
const DIRECT = '직접 PR 생성은 차단합니다. pr-guard.js review로 PR.md를 보여 주고 사용자 승인을 받은 뒤 pr-guard.js create를 실행하세요.';
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => common.digest(left) === common.digest(right);
const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blocked_output = output => output.decision === 'block' || output.hookSpecificOutput?.permissionDecision === 'deny';
function dispatch(args, options = {}) {
    const result = spawnSync(args[0], args.slice(1), {encoding: 'utf8', ...options});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Command failed: ${args[0]}`).trim());
    return result;
}

export function read_document(file) {
    common.require(path.basename(file) === 'PR.md', 'PR 문서 파일 이름은 PR.md여야 합니다.');
    const raw = fs.readFileSync(file);
    const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    const match = text.match(/^# PR\.md\s*\n## 제목\s*\n([^\n]+)\n\s*## 본문\s*\n(.+)$/s);
    common.require(match && match[1].trim() && match[2].trim(), FORMAT);
    reject_internal_metadata(text);
    return [text, match[1].trim(), match[2].trim() + '\n', hash(raw)];
}

export function reject_internal_metadata(text) {
    const local_path = /\/(?:[^\s<>)\]`/]*\/)*(?:\.harness|\.worktrees?|\.sub-workspace)(?:\/|\b)/;
    const task_path = common.private_task_pattern();
    if (local_path.test(text) || task_path.test(text) || text.includes(WORKSPACE + '/') || /\.harness[/\\]private(?:[/\\]|\b)/.test(text) ||
        /(?<![\w])(?:WORK|task)\.md\b|\.harness-state\.json\b|<!--\s*own-harness-work\b|```own-harness-work\b/i.test(text)) {
        throw new Error('PR.md에서 로컬 경로·작업 기록 참조·own-harness-work 메타데이터를 제거하세요.');
    }
    const fields = 'task_id|base_sha|head_sha|verified_state|workspace_root|task_workspace|worktree_path|worker_id|worker_name|assignment_sha256|planning_sha256|workers_sha256|current_fingerprint|verified_fingerprint|contract_sha256|control_mode';
    const copied_field = new RegExp('^\\s*(?:[-*]\\s+|\\|\\s*)?["`]?(' + fields + ')["`]?\\s*[:=|]\\s*');
    const fenced_field = new RegExp('(?<![\\w.])["`]?(' + fields + ')["`]?\\s*[:=]\\s*', 'g');
    let fenced = false;
    let fenced_keys = new Set();
    const check = () => common.require(fenced_keys.size < 2, 'PR.md에 내부 작업 메타데이터 필드를 복사할 수 없습니다.');
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
            if (fenced) check();
            fenced = !fenced;
            fenced_keys = new Set();
        } else if (fenced) {
            for (const match of line.matchAll(fenced_field)) fenced_keys.add(match[1]);
        } else if (copied_field.test(line)) {
            throw new Error('PR.md에 내부 작업 메타데이터 필드를 복사할 수 없습니다.');
        }
    }
    check();
}

export function check_delivery(cwd) {
    const validator = path.join(path.dirname(SCRIPT), 'work.js');
    common.require(fs.existsSync(validator), 'delivery 검증기 .harness/runtime/work.js가 없습니다.');
    const env = common.git_environment();
    if ('GIT_INDEX_FILE' in process.env) env.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
    try { dispatch([process.execPath, validator, 'check', '--cwd', cwd, '--delivery', '--publish'], {env}); }
    catch (error) { throw new Error('delivery 검증 실패: ' + error.message); }
}

export function git_environment() { return common.git_environment(); }
export function git(cwd, ...args) {
    return dispatch(['git', '--no-replace-objects', '-C', String(cwd), ...args], {env: git_environment()}).stdout.trim();
}
export function snapshot(file, cwd, base, draft = true) {
    cwd = git(cwd, 'rev-parse', '--show-toplevel');
    const remote = git(cwd, 'remote', 'get-url', 'origin');
    const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    common.require(match, 'origin은 github.com의 owner/repo Git 원격이어야 합니다.');
    const head = git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    common.require(base && !base.startsWith('-') && base !== head, '서로 다른 head와 base 브랜치를 지정하세요.');
    file = fs.realpathSync(file);
    const [document, title, body, document_sha256] = read_document(file);
    check_delivery(cwd);
    return {file, cwd, repo: match[1], head, base, draft, commit: git(cwd, 'rev-parse', 'HEAD'),
        document, document_sha256, title, body, steering_sha256: state_for(cwd).digest, policy_sha256: common.policy_digest(WORKSPACE)};
}
export function current(proposal) { return snapshot(proposal.file, proposal.cwd, proposal.base, proposal.draft); }
export function session_id(value = null) {
    value ||= process.env.CODEX_THREAD_ID;
    common.require(value, 'Codex 세션 ID가 없어 PR 승인을 연결할 수 없습니다.');
    return value;
}
export function state_path(session) {
    common.safe_path(WORKSPACE, '.harness', 'private', 'pr-approvals');
    fs.mkdirSync(STATE_DIR, {mode: 0o700, recursive: true});
    const file = path.join(STATE_DIR, hash(session) + '.json');
    for (const item of [file, lock_path(file)]) {
        common.require(!fs.existsSync(item) || !fs.lstatSync(item).isSymbolicLink(), '승인 상태 symlink를 허용하지 않습니다.');
    }
    return file;
}
const lock_path = file => file.replace(/\.json$/, '.lock.d');
export function load(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
export function save(file, state) { common.atomic_write(file, JSON.stringify(state) + '\n'); }
export function review(file, cwd, base, draft = true) {
    const session = session_id();
    const proposal = snapshot(file, cwd, base, draft);
    const token = common.digest({session, proposal}).slice(0, 12);
    const target = state_path(session);
    common.with_lock(lock_path(target), () => save(target, {proposal, token, approved: false, consumed: false, invalidated: false}));
    console.log(proposal.document);
    console.log(`대상: ${proposal.repo} · ${proposal.head} → ${base} · ${draft ? 'Draft' : 'Ready'} · ${proposal.commit.slice(0, 9)}`);
    console.log(`이 파일을 열고 제목·본문 전체를 사용자에게 제시한 뒤 \`PR 승인 ${token}\` 응답을 받으세요.`);
}
export function require_approval(state) {
    common.require(state.approved && state.approval_turn && state.approval_session === session_id() && !state.consumed && !state.invalidated,
        '검토한 PR에 대한 사용자 승인이 없거나 무효화·사용됐습니다.');
    try {
        common.require(equal(current(state.proposal), state.proposal), '문서·저장소·브랜치·HEAD가 바뀌었습니다. PR.md를 다시 review하고 승인받으세요.');
    } catch (error) {
        Object.assign(state, {approved: false, invalidated: true});
        throw error;
    }
}
export function create() {
    const file = state_path(session_id());
    let state;
    common.with_lock(lock_path(file), () => {
        state = load(file);
        try { require_approval(state); }
        catch (error) { save(file, state); throw error; }
        // Consume before dispatch: a timeout may still have created the PR remotely.
        state.consumed = true;
        save(file, state);
    });
    const proposal = state.proposal;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-'));
    try {
        const body_file = path.join(directory, 'body.md');
        fs.writeFileSync(body_file, proposal.body, 'utf8');
        const args = ['gh', 'pr', 'create', '--repo', proposal.repo, '--head', proposal.head, '--base', proposal.base,
            '--title', proposal.title, '--body-file', body_file];
        if (proposal.draft) args.push('--draft');
        dispatch(args, {cwd: proposal.cwd, stdio: 'inherit'});
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
export function direct_creation(name, command) {
    return /(?:create_pull_request|createPullRequest|create_pr)$/.test(name) ||
        /\bgh\b[^\n;&|]*\bpr\s+create\b|createPullRequest/.test(command) ||
        (/\b(?:gh|curl|http|https)\b/.test(command) && /(?:\/|\b)pulls(?:\b|[/?])/.test(command) &&
            /\bPOST\b|--(?:raw-)?field\b|--data|\s-[fFd]\b/.test(command));
}
export function work_hook(event) {
    try {
        const result = spawnSync(process.execPath, [path.join(path.dirname(SCRIPT), 'work.js'), 'hook'],
            {input: JSON.stringify(event), encoding: 'utf8'});
        if (result.error) throw result.error;
        const output = result.stdout.trim() ? JSON.parse(result.stdout) : {};
        common.require(is_object(output), 'work.js hook 출력은 JSON 객체여야 합니다.');
        common.require(result.status === 0 || blocked_output(output), (result.stderr || result.stdout).trim() || 'work.js hook 실행 실패');
        return output;
    } catch (error) { return {decision: 'block', reason: `작업 통제 훅을 확인할 수 없습니다: ${error.message}`}; }
}

// Parse shell quoting without evaluating expansions or executing a command.
export function shell_words(command) {
    const words = [];
    let word = '', quote = null, started = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") { if (ch === "'") quote = null; else word += ch; }
        else if (ch === '\\') {
            common.require(i + 1 < command.length, '완성되지 않은 shell escape입니다.');
            const next = command[++i];
            word += quote === '"' && !['"', '\\'].includes(next) ? '\\' + next : next;
            started = true;
        } else if (quote === '"') { if (ch === '"') quote = null; else word += ch; }
        else if (ch === "'" || ch === '"') { quote = ch; started = true; }
        else if (/\s/.test(ch)) { if (started) { words.push(word); word = ''; started = false; } }
        else { word += ch; started = true; }
    }
    common.require(!quote, '완성되지 않은 shell quote입니다.');
    if (started) words.push(word);
    return words;
}
export function hook(event) {
    common.require(is_object(event), 'hook event는 JSON 객체여야 합니다.');
    const output = work_hook(event);
    const blocked = blocked_output(output);
    const kind = event.hook_event_name;
    const print = () => { if (Object.keys(output).length) console.log(JSON.stringify(output)); };
    if (kind === 'UserPromptSubmit') {
        const [session, turn] = common.event_proof(event);
        const file = state_path(session);
        let approved = false, state;
        common.with_lock(lock_path(file), () => {
            state = load(file);
            if (!Object.keys(state).length) return;
            const event_key = common.digest({session, turn, prompt: event.prompt ?? ''});
            if (state.last_event === event_key) return;
            state.last_event = event_key;
            state.approved = false;
            approved = !blocked && (event.prompt ?? '').trim() === 'PR 승인 ' + (state.token ?? '');
            if (!approved) state.invalidated = true;
            if (approved && !state.consumed && !state.invalidated) {
                try { state.approved = equal(current(state.proposal), state.proposal); }
                catch { state.approved = false; }
                if (state.approved) Object.assign(state, {approval_turn: turn, approval_session: session});
                else state.invalidated = true;
            }
            save(file, state);
        });
        if (approved) {
            const message = state.approved ? '검토한 PR 승인 확인. pr-guard.js create로 생성하세요.' : '검토 내용이 변경·무효화됐거나 이미 사용한 승인입니다. 다시 review하세요.';
            const specific = output.hookSpecificOutput ??= {hookEventName: kind};
            specific.additionalContext = [specific.additionalContext, message].filter(Boolean).join('\n');
        }
        print();
        return;
    }
    if (blocked || kind !== 'PreToolUse') { print(); return; }
    const name = event.tool_name ?? '';
    const inputs = event.tool_input ?? {};
    let command = is_object(inputs) ? inputs.command ?? inputs.cmd ?? '' : '';
    if (!['Bash', 'exec_command', 'shell', 'shell_command'].includes(name)) command = '';
    common.require(!direct_creation(name, command), DIRECT);
    if (command.includes('pr-guard.js')) {
        const words = shell_words(command);
        const invocations = words.flatMap((word, i) => path.basename(word) === 'pr-guard.js' && ['create', 'hook'].includes(words[i + 1]) ? [[i, words[i + 1]]] : []);
        if (invocations.length) {
            common.require(!invocations.some(([, action]) => action === 'hook'), '승인 이벤트는 Codex UserPromptSubmit 훅으로만 받습니다.');
            const entry = words.length === 3 && fs.existsSync(words[1]) ? fs.realpathSync(words[1]) : null;
            common.require(words.length === 3 && path.basename(words[0]) === 'bun' && path.isAbsolute(words[1]) && entry === SCRIPT,
                'PR 생성 명령은 bun <pr-guard.js 절대경로> create 하나로 실행하세요.');
            const [session, turn] = common.event_proof(event);
            const file = state_path(session);
            common.with_lock(lock_path(file), () => {
                const state = load(file);
                try {
                    require_approval(state);
                    common.require(state.approval_turn === turn, 'PR 승인을 받은 사용자 turn에서만 생성할 수 있습니다.');
                } finally { save(file, state); }
            });
        }
    }
    print();
}
export function main(argv = process.argv.slice(2)) {
    try {
        const {values, positionals} = parseArgs({args: argv, allowPositionals: true,
            options: {base: {type: 'string'}, cwd: {type: 'string', default: process.cwd()}, ready: {type: 'boolean'}}});
        const [action, file] = positionals;
        common.require(['review', 'create', 'hook'].includes(action), 'usage: pr-guard.js review PR.md --base BASE | create | hook');
        common.require(action === 'review' ? positionals.length === 2 && values.base : positionals.length === 1, '잘못된 PR guard 인수입니다.');
        common.load_config(WORKSPACE);
        if (action === 'review') review(file, values.cwd, values.base, !values.ready);
        else if (action === 'create') create();
        else hook(JSON.parse(fs.readFileSync(0, 'utf8')));
        return 0;
    } catch (error) { console.error(`PR guard: ${error.message}`); return 2; }
}
if (import.meta.main) process.exitCode = main();
