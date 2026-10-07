#!/usr/bin/env bun
/** Check explicit Git identity and the installed workspace delivery contract. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as common from './harness_common.js';

function checked(args, options = {}) {
    const result = spawnSync(args[0], args.slice(1), {encoding: 'utf8', ...options});
    if (result.error) throw result.error;
    common.require(result.status === 0, (result.stderr || result.stdout || `${args[0]} failed`).trim());
    return result;
}
export function main(argv = process.argv.slice(2)) {
    const phase = argv[0] ?? 'check';
    common.require(['check', 'pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push'].includes(phase), '알 수 없는 hook 단계입니다.');
    common.load_config();
    if (['pre-commit', 'pre-merge-commit', 'commit-msg'].includes(phase)) {
        const name = common.git(process.cwd(), 'config', '--get', 'user.name', {optional: true});
        const email = common.git(process.cwd(), 'config', '--get', 'user.email', {optional: true});
        common.require(name.trim() && email.trim(), 'commit에는 명시적인 user.name과 user.email이 필요합니다.');
        for (const role of ['AUTHOR', 'COMMITTER']) {
            // Keep overrides so an unintended author or committer is detected.
            const env = common.git_environment();
            for (const [key, value] of Object.entries(process.env)) {
                if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) env[key] = value;
            }
            const ident = checked(['git', 'var', `GIT_${role}_IDENT`], {env}).stdout.trim().split(' ').slice(0, -2).join(' ');
            common.require(ident === `${name} <${email}>`, `Git ${role}가 user.name/user.email과 다릅니다. identity override를 확인하세요.`);
        }
    }
    const [, , checkout] = common.checkout_info(process.cwd());
    const args = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'work.js'), 'check', '--cwd', checkout];
    if (phase !== 'check') args.push('--delivery');
    if (phase === 'pre-push') args.push('--publish');
    checked(args, {stdio: 'inherit'});
    console.log(`workspace check (${phase}): OK`);
    return 0;
}
if (import.meta.main) {
    try { process.exitCode = main(); }
    catch (error) { console.error(`workspace check: ${error.message}`); process.exitCode = 1; }
}
