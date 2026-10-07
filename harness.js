#!/usr/bin/env bun
/** Install a workspace-local WORK harness without changing global settings. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUNTIME = ['harness_common.js', 'work.js', 'work-hook.js', 'check-workspace.js', 'pr-guard.js', 'delegation.js'];
export const SKILL = ['SKILL.md', 'LICENSE', 'references/workflows.md', 'references/principles.md', 'references/upstream.md', 'references/workspace.md'];
export const PAYLOAD = ['harness.js', 'templates/AGENTS.fragment.md', ...RUNTIME.map(p => `runtime/${p}`), ...SKILL.map(p => `skills/pstack-codex/${p}`)];
const LEGACY_PAYLOAD = ['harness.py', 'runtime/harness_common.py', 'runtime/work.py', 'runtime/work-hook.py', 'runtime/check-workspace', 'runtime/pr-guard.py'];
export const HOOKS = `applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit
prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge
pre-push pre-receive update proc-receive post-receive post-update
reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate
fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist
p4-pre-submit post-index-change`.split(/\s+/);
export const EXCLUDES = ['/.harness/', '/.worktrees/', '/.codex/config.toml', '/.codex/hooks.json', '/.agents/skills/pstack-codex/', '/AGENTS.override.md'];
export const BEGIN = '<!-- own-harness:begin -->', END = '<!-- own-harness:end -->';
const exists = p => fs.existsSync(p);
const utf8 = data => new TextDecoder('utf-8', { fatal: true }).decode(data);
const is_dir = p => exists(p) && fs.statSync(p).isDirectory();
const ancestors = p => { const result = []; for (let next = path.dirname(p); next !== p; p = next, next = path.dirname(p)) result.push(next); return result; };
const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fail(message) { throw new Error(message); }

export function plain(value) {
  const p = String(value);
  for (const part of [p, ...ancestors(p)]) {
    let entry;
    try { entry = fs.lstatSync(part); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    if (entry.isSymbolicLink()) fail(`symlink path is not supported: ${part}`);
  }
  return p;
}
export function absolute(value) {
  const p = String(value);
  if (!path.isAbsolute(p)) fail(`an absolute path is required: ${p}`);
  plain(p);
  return path.resolve(p);
}
export function run_git(repo, ...args) {
  const options = object(args.at(-1)) ? args.pop() : {};
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') || ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'].includes(k)));
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(options.optional && result.status === 1)) fail(result.stderr.trim() || `Git command failed: ${args.join(' ')}`);
  return result.status === 0 ? result.stdout.replace(/\n+$/, '') : null;
}
export function values(repo, scope) {
  const output = run_git(repo, 'config', scope, '--null', '--get-all', 'core.hooksPath', { optional: true });
  const found = output === null ? [] : output.replace(/\0+$/, '').split('\0');
  if (found.length > 1) fail(`multiple ${scope} core.hooksPath values: ${repo}`);
  return found;
}
export function write_local(repo, vals) {
  if (values(repo, '--local').length) run_git(repo, 'config', '--local', '--unset-all', 'core.hooksPath');
  for (const value of vals) run_git(repo, 'config', '--local', '--add', 'core.hooksPath', value);
}
export function snapshot(p) {
  plain(p);
  if (!exists(p)) return null;
  const info = fs.statSync(p);
  if (!info.isFile()) fail(`expected a regular file: ${p}`);
  return { data: fs.readFileSync(p).toString('base64'), mode: info.mode & 0o7777 };
}
export function content(state) {
  if (state === null) return Buffer.alloc(0);
  if (!object(state) || typeof state.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(state.data)) fail('invalid file snapshot');
  return Buffer.from(state.data, 'base64');
}
export function digest(state) { return state === null ? null : { sha256: crypto.createHash('sha256').update(content(state)).digest('hex'), mode: state.mode }; }
export function encoded(data, mode) { return { data: Buffer.from(data).toString('base64'), mode }; }
export function replace(p, state, created) {
  plain(p);
  if (state === null) { if (exists(p)) fs.unlinkSync(p); return; }
  const absent = [];
  for (let parent = path.dirname(p); !exists(parent); parent = path.dirname(parent)) absent.push(parent);
  for (const directory of absent.reverse()) { fs.mkdirSync(directory, { mode: 0o700 }); created.add(directory); }
  const temporary = path.join(path.dirname(p), `.harness-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temporary, content(state), { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, state.mode);
    fs.renameSync(temporary, p);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
export function apply(changes, settings, verify = null) {
  // Complete preflight before writing, and roll back this entire call after failure.
  const before = new Map([...changes.keys()].map(p => [p, snapshot(p)]));
  const old_settings = settings.map(([repo]) => [repo, values(repo, '--local')]);
  const done = [], git_done = [], created = new Set();
  try {
    for (const [p, state] of changes) if (!equal(state, before.get(p))) { done.push(p); replace(p, state, created); }
    if (verify) verify();
    for (const [repo, vals] of settings) { git_done.push(repo); write_local(repo, vals); }
  } catch (error) {
    const failures = [];
    for (const [repo, old] of old_settings.reverse()) if (git_done.includes(repo)) {
      try { write_local(repo, old); } catch (recovery) { failures.push(recovery.message); }
    }
    for (const p of done.reverse()) { try { replace(p, before.get(p), created); } catch (recovery) { failures.push(recovery.message); } }
    for (const directory of [...created].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(directory); } catch {} }
    if (failures.length) throw new Error(`${error.message}; rollback failed: ${failures.join('; ')}`, { cause: error });
    throw error;
  }
}
export function json_bytes(value) { return Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`); }
export function append_lines(text, lines) {
  const missing = lines.filter(line => !text.split(/\r?\n/).includes(line));
  if (!missing.length) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return text + (text && !text.endsWith('\n') ? newline : '') + missing.join(newline) + newline;
}
export function repo_map(raw) {
  const repos = {};
  for (const item of raw) {
    const index = item.indexOf('='), name = item.slice(0, index);
    if (index < 0 || Object.hasOwn(repos, name)) fail('--repo must contain unique NAME=RELATIVE_PATH entries');
    Object.defineProperty(repos, name, { value: item.slice(index + 1), enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(repos).length ? repos : { project: '.' };
}
export function repositories(root, mapping) {
  if (!object(mapping) || !Object.keys(mapping).length) fail('repos must be a nonempty map');
  const found = {}, seen = new Set();
  for (const [name, relative] of Object.entries(mapping)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) fail('invalid repository name');
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(path.sep).some(p => ['..', '.git', '.harness', '.worktrees'].includes(p))) fail('repository paths must stay within the workspace');
    const repo = absolute(path.join(root, relative));
    if (!is_dir(path.join(repo, '.git'))) fail(`installation requires a baseline repository: ${repo}`);
    const common = absolute(run_git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const top = absolute(run_git(repo, 'rev-parse', '--show-toplevel'));
    if (top !== repo || common !== path.join(repo, '.git') || seen.has(common)) fail(`repository baseline/common directory is ambiguous: ${repo}`);
    seen.add(common);
    const trees = run_git(repo, 'worktree', 'list', '--porcelain', '-z').split('\0').filter(p => p.startsWith('worktree ')).map(p => absolute(p.slice(9)));
    if (!trees.includes(repo)) fail('baseline is not a registered worktree');
    for (const tree of trees) {
      if (!is_dir(tree)) fail(`registered worktree is missing; prune it before installation: ${tree}`);
      if (absolute(run_git(tree, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== common || absolute(run_git(tree, 'rev-parse', '--show-toplevel')) !== tree) fail(`registered worktree belongs to another repository: ${tree}`);
    }
    found[name] = { path: repo, common, trees };
  }
  for (const parent of [root, ...ancestors(root)]) if (exists(path.join(parent, '.git'))) {
    if (parent !== root || !Object.values(found).some(repo => repo.path === root)) fail('Git-owned workspace root must be a mapped baseline; nested workspace roots are unsupported');
    break;
  }
  return found;
}
export function check_tracked(repo, root = null) {
  if (run_git(repo, 'ls-files', '--', '.harness', '.worktrees', '.codex/config.toml', '.codex/hooks.json', '.agents/skills/pstack-codex', 'AGENTS.override.md')) fail(`tracked private/local configuration is not changed: ${repo}`);
  if (repo === root && run_git(repo, 'ls-files', '--', 'work')) fail(`tracked workspace work directory conflicts with task storage: ${repo}`);
}
export function load_manifest(root) {
  const state = snapshot(path.join(root, '.harness/private/install.json'));
  if (state === null) return null;
  const value = JSON.parse(utf8(content(state)));
  if (value.schema !== 1 || value.workspace !== root) fail('installation manifest belongs to another workspace');
  return value;
}
function task_context(root, value) {
  const relative = path.relative(root, absolute(value)).split(path.sep);
  if (relative.length !== 2 || relative[0] !== 'work' || !/^[a-z0-9][a-z0-9._-]{0,79}(?![\s\S])/.test(relative[1])) fail(`invalid task context path: ${value}`);
  const context = path.join(root, ...relative);
  for (const folder of [path.join(root, 'work'), context]) if (exists(path.join(folder, '.git'))) fail(`task context conflicts with an existing Git repository: ${folder}`);
  return context;
}
export function task_root_for(root, checkout, repository) {
  const parts = path.relative(root, checkout).split(path.sep);
  if (parts.length !== 4 || parts[0] !== 'work' || !['repos', '.worktrees'].includes(parts[2])) return null;
  const context = task_context(root, path.join(root, parts[0], parts[1]));
  if (parts[2] === 'repos' && parts[3] !== repository) fail(`task checkout repository name does not match its registered repository: ${checkout}`);
  if (parts[2] === '.worktrees' && !/^[a-z0-9][a-z0-9._-]{0,79}(?![\s\S])/.test(parts[3])) fail(`invalid worker checkout name: ${checkout}`);
  return context;
}
export function task_roots(root, repos, manifest = null) {
  const active = new Set();
  for (const [name, repo] of Object.entries(repos)) for (const tree of repo.trees) {
    if (tree === repo.path) continue;
    const context = task_root_for(root, tree, name);
    if (context !== null) active.add(context);
  }
  const stored = manifest?.task_roots ?? [];
  if (!Array.isArray(stored)) fail('stored task contexts must be a list');
  // Existing task archives retain their installed context after their last checkout is removed.
  for (const value of stored) {
    const context = task_context(root, value);
    if (manifest.checkouts?.[context] !== null) fail('stored task context has no installation ownership record');
    if (exists(context)) {
      if (!is_dir(context)) fail(`task context is not a directory: ${context}`);
      active.add(context);
    }
  }
  return active;
}
export function retired_checkouts(root, manifest, repos) {
  const contexts = task_roots(root, repos, manifest);
  const stored_contexts = new Set((manifest.task_roots ?? []).map(value => task_context(root, value)));
  const current = new Set([root, ...Object.values(repos).flatMap(repo => repo.trees), ...contexts]), retired = new Set();
  for (const [value, name] of Object.entries(manifest.checkouts || {})) {
    const tree = absolute(value);
    if (!Object.hasOwn(repos, name) && tree !== root && !(name === null && stored_contexts.has(tree))) fail('stored checkout belongs to an unknown repository');
    if (!current.has(tree)) { if (exists(tree)) fail(`previously managed checkout is no longer registered: ${tree}`); retired.add(tree); }
  }
  return retired;
}
export function within(p, directories) { return [...directories].some(folder => p === folder || p.startsWith(folder + path.sep)); }
export function validate_manifest(root, manifest, repos) {
  const retired = retired_checkouts(root, manifest, repos);
  const checkouts = new Set([root, ...Object.values(repos).flatMap(repo => repo.trees), ...task_roots(root, repos, manifest), ...retired]);
  // Old managed Python files stay allowlisted only for verified update/uninstall migration.
  const allowed = new Set([...PAYLOAD, ...LEGACY_PAYLOAD].map(rel => path.join(root, '.harness', rel)));
  allowed.add(path.join(root, '.harness/config.json'));
  for (const [name, repo] of Object.entries(repos)) {
    const folder = path.join(root, '.harness/private/hooks', name);
    for (const hook of [...HOOKS, 'config.json']) allowed.add(path.join(folder, hook));
    allowed.add(path.join(repo.common, 'info/exclude'));
  }
  for (const tree of checkouts) {
    for (const rel of ['.codex/config.toml', '.codex/hooks.json', 'AGENTS.override.md']) allowed.add(path.join(tree, rel));
    for (const rel of SKILL) allowed.add(path.join(tree, '.agents/skills/pstack-codex', rel));
  }
  const allowed_directories = new Set(), boundaries = new Set([...checkouts, ...Object.values(repos).map(repo => repo.common)]);
  for (const p of allowed) for (const parent of ancestors(p)) { if (boundaries.has(parent)) break; allowed_directories.add(parent); }
  if ((manifest.directories || []).some(p => !allowed_directories.has(absolute(p)))) fail('manifest directory is not installation-owned');
  for (const repo of Object.values(repos)) for (const tree of repo.trees) check_tracked(tree, root);
  for (const [p, entry] of Object.entries(manifest.files)) {
    const actual = absolute(p);
    if (!allowed.has(actual)) fail(`manifest path is no longer a managed path: ${p}`);
    if (!within(actual, retired) && !equal(digest(snapshot(actual)), entry.installed)) fail(`managed file drift; restore or reconcile before proceeding: ${p}`);
    content(entry.original);
  }
  if (!equal(Object.keys(manifest.git).sort(), Object.keys(repos).sort())) fail('repository mapping changed');
  for (const [name, repo] of Object.entries(repos)) {
    const saved = manifest.git[name], target = path.join(root, '.harness/private/hooks', name);
    if (saved.common_dir !== repo.common || saved.target !== target) fail('stored Git hook ownership does not match this repository');
    if (!equal(values(repo.path, '--local'), [target])) fail(`core.hooksPath drift: ${repo.path}`);
  }
}
export function hook_settings(root, repos, manifest) {
  const saved = {}, changes = [];
  for (const [name, repo] of Object.entries(repos)) {
    const baseline = repo.path, common = repo.common, target = path.join(root, '.harness/private/hooks', name);
    const local = values(baseline, '--local'), current = run_git(baseline, 'config', '--get', 'core.hooksPath', { optional: true });
    let record;
    if (manifest) record = manifest.git[name];
    else {
      if (current?.includes('.harness/private/hooks/')) fail('existing harness hooks have no installation ownership record');
      record = { common_dir: common, target, original_local: local, previous_path: current !== null ? run_git(baseline, 'config', '--path', '--get', 'core.hooksPath') : path.join(common, 'hooks'), previous_configured_value: current, previous_configured: current !== null, previous_local_value: local[0] ?? null };
    }
    const extension = run_git(baseline, 'config', '--bool', '--get', 'extensions.worktreeConfig', { optional: true });
    for (const tree of repo.trees) {
      if (extension === 'true' && values(tree, '--worktree').length) fail(`worktree core.hooksPath override must be resolved first: ${tree}`);
      if (run_git(tree, 'config', '--get', 'core.hooksPath', { optional: true }) !== current) fail(`per-checkout hooksPath configuration differs: ${tree}`);
    }
    if (manifest && current !== target) fail(`effective core.hooksPath drift: ${baseline}`);
    saved[name] = record; changes.push([baseline, [target]]);
  }
  return [saved, changes];
}
export function memory_config(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let header = null, key = null, active = false, section = false;
  for (const [index, line] of lines.entries()) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    if (line.includes('"""') || line.includes("'''") || /[{}]/.test(line)) fail('복잡한 TOML(다중행 문자열/inline 표)은 자동 편집하지 않습니다');
    if (stripped.startsWith('[')) {
      if (!/^\[\[?[\p{L}\p{N}_. \t-]+\]\]?[ \t]*(?:#.*)?$/u.test(stripped)) fail('복잡한 TOML 표 이름은 자동 편집하지 않습니다');
      section = true; active = /^\[\s*memories\s*\]\s*(?:#.*)?$/.test(stripped);
      if (stripped.split('#', 1)[0].includes('memories') && !active) fail('memories의 quoted/dotted/array 표는 자동 편집하지 않습니다');
      if (active) { if (header !== null) fail('중복된 [memories] 표가 있습니다'); header = index; }
      continue;
    }
    if (!line.includes('=')) fail('다중행 TOML 값은 자동 편집하지 않습니다');
    const separator = line.indexOf('='), name = line.slice(0, separator), value = line.slice(separator + 1);
    if ((active || !section) && !/^[ \t]*[\p{L}\p{N}_-]+[ \t]*$/u.test(name)) fail('quoted/dotted TOML 키는 자동 편집하지 않습니다');
    if (value.trimStart().startsWith('[') && !/^\[[^\[\]#\r\n]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/.test(value.trimStart())) fail('복잡한 TOML 배열은 자동 편집하지 않습니다');
    if (!section && /^["']?memories(?:["']|\s|\.|=)/.test(stripped)) fail('memories는 단순 [memories] 표로 작성해야 합니다');
    if (active && /^["']?use_memories(?:["']|\s|\.|=)/.test(stripped)) {
      const match = /^([ \t]*use_memories[ \t]*=[ \t]*)(true|false)([ \t]*(?:#[^\r\n]*)?)(\r?\n)?$/.exec(line);
      if (!match || key !== null) fail('use_memories는 중복 없는 단순 boolean이어야 합니다');
      key = index; lines[index] = match[1] + 'false' + match[3] + (match[4] || '');
    }
  }
  if (key !== null) return lines.join('');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (header !== null) { if (!lines[header].endsWith('\n')) lines[header] += newline; lines.splice(header + 1, 0, `use_memories = false${newline}`); return lines.join(''); }
  return text + (text && !text.endsWith('\n') ? newline : '') + (text ? newline : '') + `[memories]${newline}use_memories = false${newline}`;
}
export function hooks_config(data, root) {
  const text = utf8(data), value = text.trim() ? JSON.parse(text) : {};
  if (!object(value) || (Object.hasOwn(value, 'hooks') && !object(value.hooks))) fail('Codex hooks.json must contain an object with a hooks object');
  const hooks = Object.hasOwn(value, 'hooks') ? value.hooks : (value.hooks = {});
  const command = `${quote(process.execPath)} ${quote(path.join(root, '.harness/runtime/pr-guard.js'))} hook`;
  for (const event of ['UserPromptSubmit', 'PreToolUse']) {
    const entries = Object.hasOwn(hooks, event) ? hooks[event] : (hooks[event] = []);
    if (!Array.isArray(entries)) fail(`Codex hook event must contain a list: ${event}`);
    for (const item of entries) {
      if (!object(item) || !Array.isArray(item.hooks)) fail(`unsupported Codex hook entry: ${event}`);
      for (const hook of item.hooks) {
        if (!object(hook)) fail('unsupported Codex command hook');
        if (/pr-guard\.(?:py|js)/.test(String(hook.command || '')) && String(hook.command || '').includes('.harness')) fail('unowned own-harness Codex hook already exists');
      }
    }
    entries.push({ hooks: [{ type: 'command', command, timeout: 30 }] });
  }
  return json_bytes(value);
}
export function managed_agents(original, fragment, root) {
  const text = utf8(original);
  if (text.includes(BEGIN) || text.includes(END)) fail('unowned own-harness AGENTS block already exists');
  const body = utf8(fragment).replaceAll('{{HARNESS_ROOT}}', root).trim();
  return Buffer.from(text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + BEGIN + '\n' + body + '\n' + END + '\n');
}
export function invalidate_approvals(root, changes) {
  const folder = plain(path.join(root, '.harness/private/pr-approvals'));
  if (exists(folder)) {
    if (!is_dir(folder)) fail('PR approval state must be a directory');
    for (const name of fs.readdirSync(folder)) {
      const p = path.join(folder, name), suffix = path.extname(p);
      if (!['.json', '.lock'].includes(suffix) || snapshot(p) === null) fail(`unexpected PR approval state entry: ${p}`);
      if (suffix === '.json') changes.set(p, null);
    }
  }
}
export function build(root, source, mapping, manifest, selected = null) {
  const repos = repositories(root, mapping);
  if (manifest) validate_manifest(root, manifest, repos);
  const [git_records, settings] = hook_settings(root, repos, manifest), payload = {};
  for (const rel of PAYLOAD) { const state = snapshot(path.join(source, rel)); if (state === null) fail(`distribution is missing an allowlisted file: ${rel}`); payload[rel] = state; }
  const contexts = task_roots(root, repos, manifest), active_contexts = task_roots(root, repos);
  let targets = new Set([root, ...Object.values(repos).flatMap(repo => repo.trees), ...contexts]);
  if (selected !== null) {
    if (!targets.has(selected) || (contexts.has(selected) && !active_contexts.has(selected)) || (selected === root && !Object.values(repos).some(repo => repo.path === root))) fail('prepare requires a registered checkout or its task root in the configured repositories');
    targets = new Set([selected]);
    for (const [name, repo] of Object.entries(repos)) if (repo.trees.includes(selected) && selected !== repo.path) {
      const context = task_root_for(root, selected, name);
      if (context !== null) targets.add(context);
    }
  }
  for (const repo of Object.values(repos)) for (const tree of repo.trees) check_tracked(tree, root);
  const retired = manifest ? retired_checkouts(root, manifest, repos) : new Set();
  const files = manifest ? structuredClone(Object.fromEntries(Object.entries(manifest.files).filter(([p]) => !within(p, retired)))) : {};
  const changes = new Map();
  const original = p => Object.hasOwn(files, p) ? files[p].original : snapshot(p);
  function manage(p, data, mode = null, require_new = false) {
    plain(p);
    if (require_new && !Object.hasOwn(files, p) && snapshot(p) !== null) fail(`installation would replace an unowned file: ${p}`);
    const old = original(p), state = encoded(data, mode ?? old?.mode ?? 0o600);
    files[p] = { original: old, installed: digest(state) }; changes.set(p, state);
  }
  for (const rel of LEGACY_PAYLOAD) {
    const p = path.join(root, '.harness', rel);
    if (Object.hasOwn(files, p)) { changes.set(p, files[p].original); delete files[p]; }
  }
  for (const [rel, state] of Object.entries(payload)) manage(path.join(root, '.harness', rel), content(state), state.mode, true);
  manage(path.join(root, '.harness/config.json'), json_bytes({ schema: 1, repos: mapping }), null, true);
  for (const [name, repo] of Object.entries(repos)) {
    const folder = path.join(root, '.harness/private/hooks', name), record = git_records[name];
    const config = Object.fromEntries(['common_dir', 'previous_path', 'previous_configured_value', 'previous_configured', 'previous_local_value'].map(key => [key, record[key]]));
    Object.assign(config, { version: 1, workspace: root });
    manage(path.join(folder, 'config.json'), json_bytes(config), null, true);
    for (const hook of HOOKS) {
      const command = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, '.harness/runtime/work-hook.js'))} ${quote(path.join(folder, 'config.json'))} ${quote(hook)} "$@"\n`;
      manage(path.join(folder, hook), Buffer.from(command), 0o755, true);
    }
    const exclude = path.join(repo.common, 'info/exclude');
    manage(exclude, Buffer.from(append_lines(utf8(content(original(exclude))), repo.path === root ? [...EXCLUDES, '/work/'] : EXCLUDES)));
  }
  for (const tree of targets) {
    const task_target = contexts.has(tree);
    const skill = plain(path.join(tree, '.agents/skills/pstack-codex'));
    if (exists(skill) && !SKILL.some(rel => Object.hasOwn(files, path.join(skill, rel)))) fail(`an existing pstack-codex skill must be resolved before installation: ${skill}`);
    for (const rel of SKILL) { const state = payload[`skills/pstack-codex/${rel}`]; manage(path.join(skill, rel), content(state), state.mode, true); }
    const config = path.join(tree, '.codex/config.toml'), text = utf8(content(original(config)));
    if (/^\s*(?:\[\[?\s*["']?hooks(?:[.\s\]"'])|["']?hooks["']?\s*=)/m.test(text)) fail('inline Codex hooks in config.toml conflict with hooks.json; migrate them explicitly');
    manage(config, Buffer.from(memory_config(text)), null, task_target);
    const hook_file = path.join(tree, '.codex/hooks.json');
    manage(hook_file, hooks_config(content(original(hook_file)), root), null, task_target);
    const agents = path.join(tree, 'AGENTS.override.md');
    manage(agents, managed_agents(content(original(agents)), content(payload['templates/AGENTS.fragment.md']), root), null, task_target);
  }
  const checkouts = { [root]: null };
  for (const [name, repo] of Object.entries(repos)) for (const tree of repo.trees) checkouts[tree] = name;
  for (const context of contexts) checkouts[context] = null;
  const result = { schema: 1, workspace: root, repos: mapping, files, git: git_records, checkouts, task_roots: [...contexts].sort() };
  const manifest_path = path.join(root, '.harness/private/install.json');
  const directories = new Set((manifest?.directories || []).filter(p => !within(p, retired)));
  for (const p of [...changes.keys(), manifest_path]) for (const parent of ancestors(p)) { if (exists(parent)) break; directories.add(parent); }
  result.directories = [...directories].sort();
  changes.set(manifest_path, encoded(json_bytes(result), 0o600));
  function verify() {
    for (const repo of Object.values(repos)) for (const tree of repo.trees) for (const p of ['.harness/config.json', '.harness/private/work/probe/WORK.md', '.harness/private/work-control/probe.json', '.harness/private/pr-approvals/probe.json', '.worktrees/probe/file', '.codex/config.toml', '.codex/hooks.json', '.agents/skills/pstack-codex/SKILL.md', 'AGENTS.override.md']) {
      if (run_git(tree, 'check-ignore', '--no-index', '--', p, { optional: true }) === null) fail(`local path is not excluded by Git: ${path.join(tree, p)}`);
    }
    if (Object.values(repos).some(repo => repo.path === root)) for (const p of ['work/probe/WORK.md', 'work/probe/evidence/result.md', ...[...contexts].map(context => path.relative(root, path.join(context, '.codex/hooks.json')))]) {
      if (run_git(root, 'check-ignore', '--no-index', '--', p, { optional: true }) === null) fail(`local task path is not excluded by Git: ${path.join(root, p)}`);
    }
  }
  return [changes, settings, verify, result];
}
export function install(root, source, { mapping = null, update = false, selected = null } = {}) {
  root = absolute(root); source = absolute(source);
  if (!is_dir(root)) fail('workspace directory does not exist');
  const manifest = load_manifest(root);
  if ((update || selected !== null) && manifest === null) fail('workspace has no managed installation');
  if (manifest) {
    if (mapping !== null && !equal(mapping, manifest.repos)) fail('repository mapping differs from the installed mapping');
    mapping = manifest.repos;
  } else {
    mapping ||= { project: '.' };
    const folder = plain(path.join(root, '.harness'));
    if (exists(folder) && fs.readdirSync(folder).some(name => name !== 'private')) fail('existing .harness files have no installation ownership record');
    const private_dir = plain(path.join(folder, 'private'));
    if (exists(private_dir) && fs.readdirSync(private_dir).some(name => !['work', 'work-control', 'pr-approvals'].includes(name))) fail('unowned .harness/private content must be resolved first');
  }
  const [changes, settings, verify, result] = build(root, source, mapping, manifest, selected);
  if (manifest && !update && selected === null) for (const [p, state] of changes) {
    if (p !== path.join(root, '.harness/private/install.json') && Object.hasOwn(manifest.files, p) && !equal(digest(state), manifest.files[p].installed)) fail('package contents changed; use update');
  }
  if (selected === null) invalidate_approvals(root, changes);
  apply(changes, settings, verify);
  return { status: selected !== null ? 'prepared' : update ? 'updated' : 'installed', workspace: root, repositories: Object.keys(result.repos).sort(), codex: 'Project files installed; trust and actual hook events are unverified. Global hooks were preserved and may also run.' };
}
export function uninstall(root) {
  root = absolute(root);
  const manifest = load_manifest(root);
  if (manifest === null) fail('workspace has no managed installation');
  const repos = repositories(root, manifest.repos);
  validate_manifest(root, manifest, repos); hook_settings(root, repos, manifest);
  const retired = retired_checkouts(root, manifest, repos);
  const changes = new Map(Object.entries(manifest.files).filter(([p]) => !within(p, retired)).map(([p, entry]) => [p, entry.original]));
  invalidate_approvals(root, changes);
  const retained = [], private_dir = path.join(root, '.harness/private');
  if (['work', 'work-control', 'pr-approvals'].some(name => exists(path.join(private_dir, name)))) retained.push('/.harness/');
  if (exists(path.join(root, '.worktrees'))) retained.push('/.worktrees/');
  const retained_work = exists(path.join(root, 'work')) && Object.values(repos).some(repo => repo.path === root);
  if (retained_work) retained.push('/work/');
  if (retained.length) for (const repo of Object.values(repos)) {
    const exclude = path.join(repo.common, 'info/exclude'), state = changes.get(exclude);
    const repo_retained = retained.filter(line => line !== '/work/' || repo.path === root);
    changes.set(exclude, encoded(Buffer.from(append_lines(utf8(content(state)), repo_retained)), state?.mode ?? 0o600));
  }
  changes.set(path.join(root, '.harness/private/install.json'), null);
  apply(changes, Object.entries(repos).map(([name, repo]) => [repo.path, manifest.git[name].original_local]));
  for (const directory of [...(manifest.directories || [])].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(plain(directory)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; } }
  return { status: 'uninstalled', workspace: root, retained_excludes: retained, preserved: 'WORK, control state, user branches and worktrees' };
}
export function doctor(root) {
  root = absolute(root);
  const manifest = load_manifest(root);
  if (manifest === null) fail('workspace has no managed installation');
  const repos = repositories(root, manifest.repos);
  validate_manifest(root, manifest, repos); hook_settings(root, repos, manifest);
  const missing = [], unprepared = Object.values(repos).flatMap(repo => repo.trees).filter(tree => !Object.hasOwn(manifest.files, path.join(tree, '.codex/hooks.json')));
  const unprepared_tasks = [...task_roots(root, repos, manifest)].filter(context => !Object.hasOwn(manifest.files, path.join(context, '.codex/hooks.json')));
  for (const [name, repo] of Object.entries(repos)) for (const tree of repo.trees) {
    const record = manifest.git[name], previous = path.isAbsolute(record.previous_path) ? record.previous_path : path.join(tree, record.previous_path);
    if (record.previous_configured && !is_dir(previous)) missing.push(previous);
  }
  return { status: !missing.length && !unprepared.length && !unprepared_tasks.length ? 'ok' : 'needs-attention', workspace: root, unprepared_checkouts: unprepared.sort(), unprepared_task_roots: unprepared_tasks.sort(), managed_files: Object.keys(manifest.files).length, missing_original_hooks: [...new Set(missing)].sort(), codex_trust: 'unverified', codex_event_delivery: 'unverified', global_hooks: 'unchanged; project and global hooks may both run' };
}
export function main(args = process.argv.slice(2)) {
  const usage = 'Usage: bun harness.js {install|update|uninstall|doctor|prepare} ABSOLUTE_PATH [--repo NAME=RELATIVE_PATH]';
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) { console.log(usage); return 0; }
  const [command, root, ...rest] = args;
  try {
    if (!['install', 'update', 'uninstall', 'doctor', 'prepare'].includes(command) || !root) fail(usage);
    const raw = [];
    for (let i = 0; i < rest.length; i++) {
      if (command !== 'install' || rest[i] !== '--repo' || i + 1 >= rest.length) fail(usage);
      raw.push(rest[++i]);
    }
    const source = absolute(path.dirname(fileURLToPath(import.meta.url)));
    let result;
    if (command === 'install') result = install(root, source, { mapping: raw.length ? repo_map(raw) : null });
    else if (command === 'update') result = install(root, source, { update: true });
    else if (command === 'prepare') {
      if (path.basename(source) !== '.harness') fail('prepare must run through the installed .harness/harness.js');
      result = install(path.dirname(source), source, { selected: absolute(root) });
    } else result = command === 'uninstall' ? uninstall(root) : doctor(root);
    console.log(JSON.stringify(result, null, 2));
    return Number(result.status === 'needs-attention');
  } catch (error) { console.error(`harness: ${error.message}`); return 1; }
}
if (import.meta.main) process.exitCode = main();
