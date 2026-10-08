/** Installed workspace paths and Git checks shared by the local Bun runtime. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MODULE_PATH = fs.realpathSync(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(path.dirname(MODULE_PATH), '../..');
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?![\s\S])/;
export const TASK_RE = /^[a-z0-9][a-z0-9._-]{0,79}(?![\s\S])/;
export const TASK_STATE = '.harness-state.json';

export function require(condition, message) {
  if (!condition) throw new Error(message);
}

function unicode_compare(left, right) {
  const a = Array.from(left, ch => ch.codePointAt(0));
  const b = Array.from(right, ch => ch.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function canonical_json(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    require(encoded !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'JSON으로 기록할 수 없는 값입니다.');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical_json).join(',') + ']';
  return '{' + Object.keys(value).sort(unicode_compare).map(key => JSON.stringify(key) + ':' + canonical_json(value[key])).join(',') + '}';
}

export function digest(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) || value instanceof Uint8Array ? value : canonical_json(value)).digest('hex');
}

/** Like Path.resolve(strict=False), resolve existing ancestors of missing paths. */
export function resolved_path(value) {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) return resolved_path(path.resolve(parent, fs.readlinkSync(absolute)));
    } catch (linkError) {
      if (linkError.code !== 'ENOENT' && linkError.code !== 'ENOTDIR') throw linkError;
    }
    return path.join(resolved_path(parent), path.basename(absolute));
  }
}

export function contained(value, parent = ROOT) {
  const relative = path.relative(resolved_path(parent), resolved_path(value));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function safe_path(root, ...parts) {
  root = path.resolve(root);
  require(parts.every(part => typeof part === 'string' && !path.isAbsolute(part) && !part.split(path.sep).includes('..')), '워크스페이스 밖 경로입니다.');
  const target = path.join(root, ...parts);
  require(contained(target, root), `워크스페이스 밖 경로입니다: ${target}`);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { require(!fs.lstatSync(current).isSymbolicLink(), `관리 경로의 symlink는 허용하지 않습니다: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

export function git_environment() {
  const permitted = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || permitted.has(key))), GIT_NO_REPLACE_OBJECTS: '1' };
}

export function git(cwd, ...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {};
  const result = spawnSync('git', ['-C', String(cwd), ...args], { env: git_environment(), maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.optional) return options.binary ? Buffer.alloc(0) : '';
    throw new Error(`Git 검사 실패 (${args[0]}): ${result.stderr.toString('utf8').trim()}`);
  }
  return options.binary ? result.stdout : result.stdout.toString('utf8').trim();
}

function is_file(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function is_directory(file) { try { return fs.statSync(file).isDirectory(); } catch { return false; } }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function load_config(root = ROOT) {
  const expected = safe_path(root, '.harness', 'runtime', 'harness_common.js');
  require(MODULE_PATH === expected, '실제 설치 위치의 runtime만 실행할 수 있습니다.');
  const file = safe_path(root, '.harness', 'config.json');
  require(is_file(file), '설치된 .harness/config.json이 없습니다. harness.js install을 먼저 실행하세요.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  require(object(value) && value.schema === 1 && object(value.repos) && Object.keys(value.repos).length, 'config schema 또는 repos mapping이 잘못됐습니다.');
  const seen = new Set(), common_dirs = new Set();
  for (const [name, relative] of Object.entries(value.repos)) {
    require(NAME_RE.test(name), '잘못된 저장소 이름입니다.');
    require(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..'), '저장소 경로는 workspace 안 상대 경로여야 합니다.');
    const checkout = safe_path(root, relative);
    require(is_directory(checkout) && fs.existsSync(path.join(checkout, '.git')), `baseline Git 저장소가 없습니다: ${checkout}`);
    require(resolved_path(git(checkout, 'rev-parse', '--show-toplevel')) === resolved_path(checkout), 'repo mapping은 실제 Git checkout 루트여야 합니다.');
    const common = git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    require(!seen.has(resolved_path(checkout)) && !common_dirs.has(common), '같은 저장소를 중복 등록할 수 없습니다.');
    seen.add(resolved_path(checkout));
    common_dirs.add(common);
  }
  return value;
}

export function repo_paths(root = ROOT) {
  return Object.fromEntries(Object.entries(load_config(root).repos).map(([name, relative]) => [name, safe_path(root, relative)]));
}

// Repository names make direct task checkout paths private without hiding ordinary work/*.js sources.
export function private_task_pattern(root = ROOT) {
  const config = safe_path(root, '.harness', 'config.json');
  const names = fs.existsSync(config) ? Object.keys(JSON.parse(fs.readFileSync(config, 'utf8')).repos ?? {}) : [];
  require(names.every(name => NAME_RE.test(name)), '잘못된 저장소 이름입니다.');
  const folders = ['evidence', 'repos', '.worktrees', '.sub-workspace', ...names].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp('(?:^|[\\s("\'`<]|/)work[/\\\\][a-z0-9][a-z0-9._-]{0,79}[/\\\\](?:(?:(?:task|WORK)\\.md|state\\.json|\\.harness-state\\.json)(?:\\b|$)|(?:' + folders + ')(?:[/\\\\]|(?=$|[\\s"\'`)\\]<>])))', 'm');
}

export function task_work_path(task, root = ROOT) {
  require(typeof task === 'string' && TASK_RE.test(task), '잘못된 작업 ID입니다.');
  const current = safe_path(root, 'work', task, 'task.md');
  const candidates = [current, safe_path(root, 'work', task, 'WORK.md'), safe_path(root, '.harness', 'private', 'work', task, 'WORK.md')];
  const existing = candidates.filter(file => fs.existsSync(file));
  require(existing.length <= 1, '같은 작업의 정본이 여러 위치에 있습니다. 하나의 작업 기록만 유지하세요.');
  return existing[0] ?? current;
}

export function worker_paths(root, task, name, repo) {
  require(TASK_RE.test(task) && TASK_RE.test(name) && NAME_RE.test(repo), '잘못된 worker 경로 이름입니다.');
  return [safe_path(root, 'work', task, '.sub-workspace', name, repo), safe_path(root, 'work', task, '.worktrees', name)];
}

export function task_registration(root, task) {
  const document = task_work_path(task, root);
  const text = fs.readFileSync(document, 'utf8');
  const state = safe_path(root, path.relative(root, path.dirname(document)), TASK_STATE);
  const blocks = [...text.matchAll(/<!-- own-harness-work:v1 -->\n```json\n([\s\S]*?)\n```\n<!-- \/own-harness-work -->/g)];
  let data;
  if (fs.existsSync(state)) {
    require(!text.includes('<!-- own-harness-work:v1 -->') && !text.includes('<!-- /own-harness-work -->'), '작업 상태 파일과 metadata 블록이 중복됐습니다.');
    data = JSON.parse(fs.readFileSync(state, 'utf8'));
  } else {
    require(blocks.length === 1 && text.split('<!-- own-harness-work:v1 -->').length === 2 && text.split('<!-- /own-harness-work -->').length === 2, '작업 기록 metadata 블록이 없거나 중복·손상됐습니다.');
    data = JSON.parse(blocks[0][1]);
  }
  require(object(data) && data.schema === 1 && data.task_id === task && object(data.repos) && Object.keys(data.repos).length, '작업 등록이 잘못됐습니다.');
  return data;
}

export function worker_registration(root, task, name) {
  require(TASK_RE.test(name), '잘못된 worker 이름입니다.');
  const data = task_registration(root, task);
  require(object(data.workers) && Object.hasOwn(data.workers, name), '작업 기록에 등록되지 않은 worker입니다.');
  const worker = data.workers[name];
  require(object(worker) && typeof worker.repo === 'string' && typeof worker.checkout === 'string' && typeof worker.branch === 'string' && worker.state !== 'cleaned', 'worker 등록이 잘못됐거나 정리된 worker입니다.');
  require(worker_paths(root, task, name, worker.repo).includes(worker.checkout), 'worker checkout이 등록된 작업 경로와 다릅니다.');
  return worker;
}

export function checkout_info(cwd, task = null, root = ROOT, allow_baseline = false) {
  const raw = path.resolve(cwd);
  require(fs.existsSync(raw), 'cwd는 실제 checkout 안이어야 합니다.');
  const checkout = resolved_path(git(raw, 'rev-parse', '--show-toplevel'));
  const branch = git(checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD', { optional: true });
  require(branch, 'detached HEAD에서는 작업을 등록할 수 없습니다.');
  const repos = repo_paths(root);
  for (const [repo, canonical] of Object.entries(repos)) {
    if (checkout === resolved_path(canonical)) {
      require(allow_baseline && task === null, 'baseline은 읽기 전용입니다. work/TASK/REPO를 사용하세요.');
      return [null, repo, checkout, branch, 'baseline', null];
    }
  }
  const relative = contained(checkout, root) ? path.relative(resolved_path(root), checkout).split(path.sep) : checkout.split(path.sep).slice(-3);
  let selected, repo, role = 'integration', worker_name = null;
  if (relative.length === 3 && relative[0] === '.worktrees') [, selected, repo] = relative;
  else if (contained(checkout, root) && relative.length === 3 && relative[0] === 'work') {
    [, selected, repo] = relative;
    require(!['evidence', 'repos'].includes(repo.toLowerCase()), '통합 checkout의 저장소 이름이 작업 폴더와 충돌합니다.');
  }
  else if (relative.length === 4 && relative[0] === 'work' && relative[2] === 'repos') [, selected, , repo] = relative;
  else if (relative[0] === 'work' && ((relative.length === 4 && relative[2] === '.worktrees') || (relative.length === 5 && relative[2] === '.sub-workspace'))) {
    [, selected, , worker_name] = relative;
    require(TASK_RE.test(selected), '잘못된 작업 ID입니다.');
    const worker = worker_registration(root, selected, worker_name);
    require(worker.checkout === checkout && worker.branch === branch, 'worker의 checkout·branch가 등록과 다릅니다.');
    repo = worker.repo;
    role = 'worker';
  } else throw new Error('baseline은 읽기 전용입니다. 등록된 work/TASK/REPO 또는 worker worktree를 사용하세요.');
  require(TASK_RE.test(selected), '잘못된 작업 ID입니다.');
  require(task === null || selected === task, 'worktree 폴더 작업 ID가 요청과 다릅니다.');
  require(Object.hasOwn(repos, repo), 'config repos에 없는 저장소입니다.');
  const canonical = repos[repo];
  require(is_file(path.join(checkout, '.git')), '실제 linked worktree가 필요합니다.');
  const common = resolved_path(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const expected = resolved_path(git(canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  require(common === expected, 'worktree의 Git common-dir가 해당 baseline과 다릅니다.');
  const registered = git(canonical, 'worktree', 'list', '--porcelain', '-z', { binary: true }).toString('utf8').split('\0').filter(item => item.startsWith('worktree ')).map(item => resolved_path(item.slice(9)));
  require(registered.includes(checkout), 'baseline Git에 등록되지 않은 worktree입니다.');
  if (contained(checkout, root)) safe_path(root, ...relative);
  return [selected, repo, checkout, branch, role, worker_name];
}

export function policy_digest(root = ROOT) {
  load_config(root);
  const names = ['task-format.js', 'harness_common.js', 'steering-state.js', 'steering.js', 'work.js', 'delegation.js', 'work-hook.js', 'pr-guard.js', 'check-workspace.js'];
  const files = [safe_path(root, '.harness', 'config.json'), ...names.map(name => safe_path(root, '.harness', 'runtime', name))];
  require(files.every(is_file), '설치된 runtime 파일이 누락됐습니다.');
  return digest(Object.fromEntries(files.map(file => [path.relative(root, file), digest(fs.readFileSync(file))])));
}

export function atomic_write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    const info = fs.lstatSync(file);
    require(!info.isSymbolicLink(), `symlink에는 쓰지 않습니다: ${file}`);
    mode = info.mode & 0o7777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), `.own-harness-${process.pid}-${randomBytes(12).toString('hex')}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, mode);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** An atomic directory lock shared by all Bun CLI processes; never fail open. */
export function with_lock(file, callback) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(file, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let info;
      try { info = fs.lstatSync(file); } catch (statError) { if (statError.code === 'ENOENT') continue; throw statError; }
      require(!info.isSymbolicLink() && info.isDirectory(), `잠금 경로가 안전한 디렉터리가 아닙니다: ${file}`);
      require(Date.now() < deadline, `작업 잠금을 얻지 못했습니다: ${file}; 실행 중인 작업을 확인하고 중단된 프로세스의 잠금만 제거하세요.`);
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  try {
    fs.writeFileSync(path.join(file, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return callback();
  } finally {
    fs.rmSync(file, { recursive: true });
  }
}

export function event_proof(event) {
  require(object(event), 'hook event는 JSON 객체여야 합니다.');
  require(!event.agent_id && !event.parent_session_id && !process.env.OWN_HARNESS_CHILD, '하위 에이전트 이벤트는 승인과 작업 통제를 변경할 수 없습니다.');
  const { session_id: session, turn_id: turn } = event;
  require(typeof session === 'string' && session && typeof turn === 'string' && turn, '실제 UserPromptSubmit의 session_id와 turn_id가 필요합니다.');
  if (event.hook_event_name === 'UserPromptSubmit') require(typeof event.prompt === 'string', '사용자 prompt는 문자열이어야 합니다.');
  require(!process.env.CODEX_THREAD_ID || process.env.CODEX_THREAD_ID === session, '현재 Codex 세션과 사용자 이벤트 세션이 다릅니다.');
  return [session, turn];
}
