#!/usr/bin/env bun
/** Chain Git's original hooks and the workspace WORK guard without changing cwd. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as common from './harness_common.js';

export const HOOKS = `applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit
prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge
pre-push pre-receive update proc-receive post-receive post-update
reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate
fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist
p4-pre-submit post-index-change`.split(/\s+/);
export const GATES = new Set(['pre-commit', 'pre-merge-commit', 'pre-push', 'commit-msg']);
const fail = message => { throw new Error(message); };
export const git_env = () => common.git_environment();
function run(args, options = {}) {
    const result = spawnSync(args[0], args.slice(1), {encoding: 'utf8', ...options});
    if (result.error) throw result.error;
    return result;
}
export function git(...args) {
    const result = run(['git', ...args], {env: git_env()});
    if (result.status !== 0) fail((result.stderr || 'Git command failed').trim());
    return result.stdout.trim();
}
export function internal_path(file) {
    const parts = file.split('/');
    return ['WORK.md', 'task.md', '.harness-state.json', 'WORK.metadata.json', 'WORK.metadata.yaml'].includes(path.posix.basename(file)) ||
        (parts.length > 1 && parts[0] === '.harness' && parts[1].startsWith('private')) ||
        (parts[0] === 'work' && common.private_task_pattern().test(file));
}
export function github_repo(remote) {
    let match = remote.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (match) return match.slice(1).join('/');
    let url;
    try { url = new URL(remote); } catch { fail('internal WORK documents require a verifiable github.com push URL'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'github.com' || url.search || url.hash || url.password ||
        (url.protocol === 'https:' && (url.username || !['', '443'].includes(url.port))) ||
        (url.protocol === 'ssh:' && (url.username !== 'git' || !['', '22'].includes(url.port)))) {
        fail('internal WORK documents require a verifiable github.com push URL');
    }
    match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    if (!match) fail('cannot identify the GitHub repository from the push URL');
    return match.slice(1).join('/');
}
export function check_push_delivery(args, data) {
    if (args.length !== 2) fail("pre-push requires Git's remote name and actual push URL");
    const commits = new Set();
    const verified_head = git('rev-parse', '--verify', 'HEAD^{commit}');
    const lines = data.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4 || ![1, 3].every(i => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[i]))) fail('invalid pre-push ref update');
        const [, local_oid, , remote_oid] = fields;
        if (/^0+$/.test(local_oid)) continue;
        const tip = git('rev-parse', '--verify', local_oid + '^{commit}');
        if (tip !== verified_head) fail('push rejected: every non-deletion source must resolve to the WORK-checked current HEAD');
        const revisions = [tip];
        if (!/^0+$/.test(remote_oid)) {
            const known = run(['git', 'rev-parse', '--verify', remote_oid + '^{commit}'], {env: git_env()});
            if (known.status === 0) revisions.push('^' + known.stdout.trim());
        }
        // New or unknown remote tips require inspecting the full local ancestry.
        for (const commit of git('rev-list', ...revisions).split('\n').filter(Boolean)) commits.add(commit);
    }
    let found = false;
    for (const commit of commits) {
        const result = run(['git', 'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', '-z', commit], {env: git_env()});
        if (result.status !== 0) fail((result.stderr || 'Git diff-tree failed').trim());
        if (result.stdout.split('\0').filter(Boolean).some(internal_path)) { found = true; break; }
    }
    if (!found) return;
    const repository = github_repo(args[1]);
    const result = run(['gh', 'api', '--hostname', 'github.com', `repos/${repository}`, '--jq', '.private'], {timeout: 30000});
    if (result.status !== 0 || result.stdout.trim() !== 'true') {
        fail('push rejected: outgoing commits contain internal WORK paths; GitHub private=true is required');
    }
}
export function main(argv = process.argv.slice(2)) {
    if (argv.length < 2 || !HOOKS.includes(argv[1])) fail('usage: work-hook.js CONFIG_PATH HOOK_NAME [hook arguments]');
    const [config_file, hook, ...args] = argv;
    const config = JSON.parse(fs.readFileSync(config_file, 'utf8'));
    common.load_config();
    const workspace = fs.realpathSync(config.workspace);
    common.require(workspace === common.ROOT, 'hook configuration belongs to another workspace');
    common.safe_path(workspace, path.relative(workspace, path.resolve(config_file)));
    if (fs.realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir')) !== fs.realpathSync(config.common_dir)) {
        fail('hook configuration belongs to another Git repository');
    }
    const previous = path.resolve(config.previous_path);
    const is_directory = fs.existsSync(previous) && fs.statSync(previous).isDirectory();
    if (!is_directory && config.previous_configured && GATES.has(hook)) {
        fail(`original hooks directory is missing: ${previous}; restore the repository's hook dependencies`);
    }
    const data = hook === 'pre-push' ? fs.readFileSync(0) : null;
    const checker = path.join(workspace, '.harness/runtime/check-workspace.js');
    const invoke = command => run(command, data === null ? {stdio: 'inherit'} : {input: data, stdio: ['pipe', 'inherit', 'inherit']}).status ?? 1;
    if (GATES.has(hook)) {
        const status = invoke([process.execPath, checker, hook, ...args]);
        if (status) return status;
        if (hook === 'pre-push') check_push_delivery(args, data);
    }
    const original = path.join(previous, hook);
    if (!fs.existsSync(original) || !fs.statSync(original).isFile()) return 0;
    try { fs.accessSync(original, fs.constants.X_OK); } catch { return 0; }
    if (fs.realpathSync(original) === common.resolved_path(path.join(path.dirname(config_file), hook))) fail('original hook points back to the WORK wrapper');
    if (GATES.has(hook)) {
        let status = invoke([original, ...args]);
        if (status) return status;
        // Original hooks may format or stage files: recheck final delivery state.
        status = invoke([process.execPath, checker, hook, ...args]);
        if (status) return status;
        if (hook === 'pre-push') check_push_delivery(args, data);
        return 0;
    }
    // Protocol hooks (especially proc-receive) inherit live stdin/stdout; never buffer them.
    return run([original, ...args], {stdio: 'inherit'}).status ?? 1;
}
if (import.meta.main) {
    try { process.exitCode = main(); }
    catch (error) { console.error(`work hook: ${error.message}`); process.exitCode = 1; }
}
