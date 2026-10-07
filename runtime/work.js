#!/usr/bin/env bun
/** 작업 계약, 단계 근거, Git 상태와 사용자 통제를 검사한다. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as common from './harness_common.js';
import { require, digest, atomic_write, git } from './harness_common.js';
import * as delegation from './delegation.js';

export { common };
export const ROOT = common.ROOT;
export const BEGIN = '<!-- own-harness-work:v1 -->', END = '<!-- /own-harness-work -->';
export const PHASES = ['research', 'design', 'implementation', 'verification'];
export const TASK_RE = common.TASK_RE;
export const BLOCK = /<!-- own-harness-work:v1 -->\n```json\n([\s\S]*?)\n```\n<!-- \/own-harness-work -->/g;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const is_file = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const escape_regex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const equal = (a, b) => digest(a ?? null) === digest(b ?? null);
function nul_names(value) {
  // Replacement decoding could hash a different/missing file and overlook changes.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value).split('\0').filter(Boolean); }
  catch { throw new Error('UTF-8이 아닌 Git 파일명은 안전하게 검증할 수 없습니다. 파일명을 UTF-8로 변경하세요.'); }
}

export function now() { return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00'); }
export function task_name(task) {
  require(typeof task === 'string' && TASK_RE.test(task) && !['.', '..'].includes(task), '작업 ID는 영문 소문자·숫자·점·밑줄·하이픈 1~80자여야 합니다.');
  return task;
}
export function contained(value, parent = ROOT) { return common.contained(value, parent); }
export function safe_path(...parts) { return common.safe_path(ROOT, ...parts); }
export function task_path(task) { return safe_path('work', task_name(task)); }
export function work_path(task) { return common.task_work_path(task_name(task), ROOT); }
export function control_path(task) { return safe_path('.harness', 'private', 'work-control', task_name(task) + '.json'); }
export function locked(task, callback) { return common.with_lock(control_path(task).replace(/\.json$/, '.lock.d'), callback); }
export function checkout_info(cwd, task = null) { return common.checkout_info(cwd, task, ROOT); }

export function read_work(task) {
  const file = work_path(task);
  require(is_file(file), `작업 기록이 없습니다: ${file}; work.js init을 먼저 실행하세요.`);
  const text = fs.readFileSync(file, 'utf8');
  const matches = [...text.matchAll(BLOCK)];
  require(matches.length === 1 && text.split(BEGIN).length === 2 && text.split(END).length === 2, 'WORK.md metadata 블록이 없거나 중복·손상됐습니다.');
  let data;
  try { data = JSON.parse(matches[0][1]); } catch { throw new Error('WORK.md JSON metadata를 읽을 수 없습니다.'); }
  require(object(data) && data.task_id === task && data.schema === 1, 'WORK.md 작업 ID 또는 schema가 다릅니다.');
  require(['pstack', 'human'].includes(data.control_mode) && PHASES.includes(data.phase), 'WORK.md 제어 모드 또는 단계가 잘못됐습니다.');
  require(object(data.repos) && Object.keys(data.repos).length && object(data.phases), 'WORK.md repos/phases가 잘못됐습니다.');
  require(data.workers === undefined || object(data.workers), 'WORK.md workers가 잘못됐습니다.');
  data.workers ??= {};
  require(Object.keys(data.phases).every(phase => PHASES.includes(phase)), '알 수 없는 단계가 있습니다.');
  return [text, data];
}

export function body_of(text) { return text.replace(BLOCK, '').trim(); }
export function contract(text) {
  const body = body_of(text);
  const match = /^## 작업 계약\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  require(match, 'WORK.md에 ## 작업 계약과 목표·범위·완료 조건을 작성하세요.');
  const value = match[1].trim();
  for (const label of ['목표', '범위', '완료 조건']) {
    const item = new RegExp('^\\s*(?:-\\s*)?' + escape_regex(label) + '\\s*:\\s*(\\S.*)$', 'm').exec(value);
    require(item && !['todo', 'tbd', '미정', '작성 필요'].includes(item[1].trim().toLowerCase()), `작업 계약의 ${label} 내용을 작성하세요.`);
  }
  return value;
}

export function contract_digest(text, data) {
  const repos = Object.fromEntries(Object.entries(data.repos).map(([name, repo]) => [name, Object.fromEntries(['checkout', 'branch', 'base_ref', 'base_sha', 'scope'].map(key => [key, repo[key] ?? null]))]));
  const delegated = delegation.request(read_control(data.task_id));
  return digest({ contract: contract(text), repos, policy: common.policy_digest(ROOT),
    ...(delegated ? { delegation: delegated, brief: delegation.brief(body_of(text), delegated) } : {}) });
}

export function save_work(task, text, data) {
  data.updated_at = now();
  const block = BEGIN + '\n```json\n' + JSON.stringify(data, null, 2) + '\n```\n' + END;
  atomic_write(work_path(task), text.includes(BEGIN) ? text.replace(BLOCK, () => block) : text.trimEnd() + '\n\n' + block + '\n');
}

export function read_control(task) {
  const file = control_path(task);
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  require(object(value) && value.task_id === task && ['human', 'pstack'].includes(value.mode), 'runtime 작업 통제 기록이 손상됐습니다.');
  require(value.session_id && value.turn_id && value.event === 'UserPromptSubmit', '작업 통제에 실제 사용자 이벤트 증빙이 없습니다.');
  delegation.request(value);
  return value;
}
export function save_control(task, value) { atomic_write(control_path(task), JSON.stringify(value, null, 2) + '\n'); }

export function human_gate(task, text, data, approval_required = true) {
  const control = read_control(task);
  const mode = control.mode ?? data.control_mode;
  require(mode === data.control_mode, 'WORK.md의 control_mode와 runtime 통제 상태가 다릅니다.');
  if (mode === 'human' && approval_required) {
    const approval = control.approval ?? {};
    require(approval.contract_sha256 === contract_digest(text, data) && approval.session_id === process.env.CODEX_THREAD_ID && approval.turn_id && approval.event === 'UserPromptSubmit', '사용자 통제 중입니다. work.js decision TASK 후 같은 채팅에서 작업 승인을 받으세요.');
  }
}

export function normalized_scopes(checkout, scopes) {
  const result = [];
  for (const value of scopes) {
    require(typeof value === 'string' && value && !path.isAbsolute(value) && !value.split(path.sep).includes('..') && !value.startsWith('-'), 'scope는 checkout 안 상대 경로여야 합니다.');
    require(contained(path.join(checkout, value), checkout), 'scope symlink가 checkout 밖을 가리킵니다.');
    require(!value.split(path.sep).includes('.git'), '.git은 작업 scope로 지정할 수 없습니다.');
    result.push(path.normalize(value).replace(/\/+$/, '') || '.');
  }
  return [...new Set(result)].sort();
}

export function fingerprint(task, repo, entry, expected_role = 'integration') {
  const [, actual_repo, checkout, branch, role] = checkout_info(entry.checkout, task);
  require(role === expected_role, '등록된 checkout 역할이 실제 작업 공간과 다릅니다.');
  require(actual_repo === repo && checkout === entry.checkout, '등록된 checkout/repo가 실제 경로와 다릅니다.');
  require(branch === entry.branch, '등록된 작업 branch가 바뀌었습니다. 새 작업 계약으로 등록하세요.');
  require(git(checkout, 'rev-parse', '--verify', entry.base_sha + '^{commit}') === entry.base_sha, '고정된 base commit이 없습니다.');
  require(Array.isArray(entry.scope) && entry.scope.every(scope => typeof scope === 'string'), 'scope는 상대 경로 목록이어야 합니다.');
  const scopes = normalized_scopes(checkout, entry.scope);
  const paths = scopes.length ? scopes : ['.'];
  const index = git(checkout, 'ls-files', '--stage', '-z', '--', ...paths, { binary: true });
  const tracked = git(checkout, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths, { binary: true });
  const excluded = work_path(task);
  const names = [...new Set(nul_names(tracked))].sort();
  const contents = [];
  for (const name of names) {
    const file = path.join(checkout, name);
    if (path.resolve(file) === path.resolve(excluded)) continue;
    let info;
    try { info = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let content;
    if (info?.isSymbolicLink()) content = ['link', fs.readlinkSync(file)];
    else if (info?.isFile()) content = ['file', Boolean(info.mode & 0o100), digest(fs.readFileSync(file))];
    else if (info?.isDirectory()) throw new Error(`중첩 저장소·submodule은 이 scope에서 지원하지 않습니다: ${file}; 별도 작업 저장소로 등록하세요.`);
    else content = ['missing'];
    contents.push([name, content]);
  }
  const index_rows = nul_names(index).filter(row => path.resolve(checkout, row.slice(row.indexOf('\t') + 1)) !== path.resolve(excluded));
  const head = git(checkout, 'rev-parse', 'HEAD');
  const dirty = Boolean(git(checkout, 'status', '--porcelain=v1', '--untracked-files=all'));
  return { checkout, branch, head_sha: head, dirty, observed_at: now(), current_fingerprint: digest({ HEAD: head, index: index_rows, contents,
    // Active worker results bind their contract separately; accepted commits remain historical receipts.
    ...(expected_role === 'integration' ? { work_body: fs.existsSync(work_path(task)) ? digest(body_of(fs.readFileSync(work_path(task), 'utf8'))) : null } : {}) }) };
}

export function observe(task, data) {
  require(Object.keys(data.repos).length, '등록된 저장소가 없습니다.');
  for (const [repo, entry] of Object.entries(data.repos)) {
    require(object(entry), '저장소 metadata가 잘못됐습니다.');
    for (const key of ['checkout', 'branch', 'base_ref', 'base_sha']) require(typeof entry[key] === 'string' && entry[key], `${repo}: ${key}가 없습니다.`);
    Object.assign(entry, fingerprint(task, repo, entry));
  }
}

export function validate_evidence(record) {
  require(object(record) && typeof record.evidence === 'string' && record.evidence.trim(), '단계 근거가 없습니다.');
  const expected = digest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'digest')));
  require(record.digest === expected, '단계 근거가 기록 뒤 변경됐습니다. 해당 단계를 다시 record하세요.');
  if (Object.hasOwn(record, 'file')) {
    const file = record.file;
    require(is_file(file) && !fs.lstatSync(file).isSymbolicLink() && contained(file) && digest(fs.readFileSync(file)) === record.file_sha256, '단계 근거 파일이 바뀌었거나 없습니다.');
  }
}

export function validate_phases(text, data, delivery = false) {
  const contract_hash = contract_digest(text, data);
  const delegated = delegation.request(read_control(data.task_id));
  let previous = true;
  const recorded = PHASES.filter(phase => Object.hasOwn(data.phases, phase));
  require(data.phase === (recorded.at(-1) ?? 'research'), 'phase와 단계 근거가 일치하지 않습니다.');
  for (const phase of PHASES) {
    const record = data.phases[phase];
    if (record === undefined || record === null) {
      previous = false;
      require(!delivery, `${phase} 근거가 없습니다.`);
      continue;
    }
    require(previous, '작업 단계 기록 순서가 잘못됐습니다.');
    validate_evidence(record);
    delegation.require_file(record, delegated);
    require(record.contract_sha256 === contract_hash, '작업 계약이 바뀌었습니다. research부터 근거를 다시 기록하세요.');
    if (phase === 'verification') {
      validate_integrated_workers(data.task_id, text, data);
      require(record.workers_sha256 === workers_digest(data) || (!Object.keys(data.workers).length && record.workers_sha256 === undefined), 'worker 배정·결과가 최종 검증 뒤 바뀌었습니다. 통합 결과를 다시 검증하세요.');
      require(typeof record.reviewer === 'string' && record.reviewer.trim(), '독립 검토자와 실제 검사 결과 근거가 필요합니다.');
      require(record.body_sha256 === digest(body_of(text)), 'WORK.md 본문이 검증 뒤 바뀌었습니다. 검증 근거를 다시 기록하세요.');
      require(equal(record.fingerprints, Object.fromEntries(Object.entries(data.repos).map(([name, repo]) => [name, repo.current_fingerprint]))), '코드·HEAD·index·untracked 내용이 검증 뒤 바뀌었습니다. snapshot은 재검증을 대신하지 않습니다.');
      require(Object.values(data.repos).every(repo => repo.verified_fingerprint === repo.current_fingerprint), '저장소의 검증 fingerprint가 현재와 다릅니다.');
    }
  }
}

export function init(task, cwd, base, scopes) {
  task_name(task);
  const [, repo, checkout, branch, role] = checkout_info(cwd, task);
  require(role === 'integration', 'worker는 init으로 작업 저장소를 덮어쓸 수 없습니다. fork 명령으로 등록하세요.');
  require(base && !base.startsWith('-'), '유효한 base ref를 지정하세요.');
  const base_sha = git(checkout, 'rev-parse', '--verify', base + '^{commit}');
  scopes = normalized_scopes(checkout, scopes);
  locked(task, () => {
    fs.mkdirSync(safe_path('work', task, 'evidence'), { recursive: true });
    const file = work_path(task);
    const control = read_control(task);
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${task}\n\n## 작업 계약\n\n- 목표: 작성 필요\n- 범위: 작성 필요\n- 완료 조건: 작성 필요\n`;
    let data;
    if (text.includes(BEGIN) || text.includes(END)) [text, data] = read_work(task);
    else {
      if (!/^## 작업 계약\s*$/m.test(text)) text = text.trimEnd() + '\n\n## 작업 계약\n\n- 목표: 작성 필요\n- 범위: 작성 필요\n- 완료 조건: 작성 필요\n';
      data = { schema: 1, task_id: task, control_mode: control.mode ?? 'pstack', phase: 'research', repos: {}, phases: {}, workers: {} };
    }
    text = delegation.scaffold(text, delegation.request(control));
    const entry = { checkout, branch, base_ref: base, base_sha, scope: scopes, verified_fingerprint: null };
    if (Object.hasOwn(data.repos, repo)) {
      const old = data.repos[repo];
      require(['checkout', 'branch', 'base_ref', 'base_sha', 'scope'].every(key => equal(old[key], entry[key])), '기존 작업 등록을 init으로 바꾸거나 초기화할 수 없습니다.');
    } else {
      require(!data.phases.verification, '검증된 작업에 저장소를 추가하려면 verification을 지우지 말고 implementation을 다시 기록하세요.');
      data.repos[repo] = entry;
    }
    observe(task, data);
    save_work(task, text, data);
  });
  console.log(`작업 등록: ${task}/${repo} · ${work_path(task)}`);
}

export function start(task, repo, base, branch) {
  task_name(task);
  require(typeof repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/.test(repo), '잘못된 저장소 이름입니다.');
  require(branch && !branch.startsWith('-'), '유효한 branch가 필요합니다.');
  const repos = common.repo_paths(ROOT);
  require(Object.hasOwn(repos, repo), 'config repos에 없는 저장소입니다.');
  const canonical = repos[repo];
  require(fs.existsSync(path.join(canonical, '.git')), 'baseline Git 저장소가 없습니다.');
  git(canonical, 'check-ref-format', '--branch', branch);
  require(base && !base.startsWith('-'), '유효한 base ref가 필요합니다.');
  const base_sha = git(canonical, 'rev-parse', '--verify', base + '^{commit}');
  const configure = safe_path('.harness', 'harness.js');
  require(is_file(configure), '설치된 harness.js가 없어 작업 context를 적용할 수 없습니다.');
  let target = safe_path('work', task, 'repos', repo);
  if (is_file(work_path(task))) {
    const entries = read_work(task)[1].repos;
    if (Object.hasOwn(entries, repo)) {
      const registered = entries[repo];
      require(typeof registered.checkout === 'string' && fs.existsSync(registered.checkout), '등록된 통합 checkout이 없습니다. 기존 작업 경로를 복구한 뒤 start를 실행하세요.');
      require(registered.branch === branch && registered.base_ref === base && registered.base_sha === base_sha, '기존 통합 checkout의 branch·base 계약을 start로 바꿀 수 없습니다.');
      target = registered.checkout;
    }
  }
  if (fs.existsSync(target)) {
    const [, actual_repo, , actual_branch] = checkout_info(target, task);
    require(actual_repo === repo && actual_branch === branch, '기존 worktree의 저장소·branch가 요청과 다릅니다.');
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    git(canonical, 'worktree', 'add', '-b', branch, target, base);
  }
  const result = spawnSync(process.execPath, [configure, 'prepare', target], { stdio: 'inherit' });
  if (result.error) throw result.error;
  require(result.status === 0, '작업 context 적용에 실패했습니다.');
  init(task, target, base, []);
  console.log(`작업 checkout: ${target}\nbaseline의 미완료 변경은 복사하지 않습니다.`);
}

export function snapshot(task) {
  locked(task, () => { const [text, data] = read_work(task); observe(task, data); save_work(task, text, data); });
  console.log('Git 관찰값을 갱신했습니다. 검증 성공 기록은 갱신하지 않았습니다.');
}

export function brief(task) {
  locked(task, () => {
    const delegated = delegation.request(read_control(task));
    require(delegated, '명시적으로 아이디어를 위임한 작업이 아닙니다. 사용자의 아이디어 위임 TASK <아이디어> 메시지가 필요합니다.');
    const [text, data] = read_work(task);
    const updated = delegation.scaffold(text, delegated);
    if (updated !== text) save_work(task, updated, data);
    console.log(`원본 아이디어:\n${delegated.idea}\n\n위임 브리프: ${work_path(task)}\n필수 항목: ${delegation.BRIEF_FIELDS.join(' · ')}\n작업 계약과 브리프를 채운 뒤 research부터 --evidence @파일로 기록하세요.`);
  });
}

function invalidate_verification(data) {
  delete data.phases.verification;
  data.phase = PHASES.filter(phase => Object.hasOwn(data.phases, phase)).at(-1) ?? 'research';
  for (const repo of Object.values(data.repos)) repo.verified_fingerprint = null;
}

function planning(task, text, data) {
  human_gate(task, text, data);
  const contract_sha256 = contract_digest(text, data);
  const delegated = delegation.request(read_control(task));
  for (const phase of ['research', 'design']) {
    require(Object.hasOwn(data.phases, phase), `${phase} 근거를 먼저 기록하세요.`);
    validate_evidence(data.phases[phase]);
    delegation.require_file(data.phases[phase], delegated);
    require(data.phases[phase].contract_sha256 === contract_sha256, '작업 계약이 바뀌었습니다. research부터 다시 기록하세요.');
  }
  return { contract_sha256, planning_sha256: digest(['research', 'design'].map(phase => data.phases[phase].digest)) };
}

function assignment(worker) {
  return Object.fromEntries(['repo', 'checkout', 'branch', 'base_sha', 'owner', 'scope'].map(key => [key, worker[key]]));
}

function worker_entry(task, data, name) {
  task_name(name);
  require(Object.hasOwn(data.workers, name), 'WORK.md에 등록되지 않은 worker입니다.');
  const worker = data.workers[name];
  require(object(worker) && Object.hasOwn(data.repos, worker.repo), 'worker 저장소가 작업에 등록되지 않았습니다.');
  require(worker.checkout === safe_path('work', task, '.worktrees', name), 'worker checkout이 작업 폴더와 다릅니다.');
  require(typeof worker.owner === 'string' && worker.owner.trim() && typeof worker.branch === 'string' && worker.branch && !worker.branch.startsWith('-'), 'worker owner 또는 branch가 잘못됐습니다.');
  require(typeof worker.base_sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(worker.base_sha), 'worker 시작 commit이 잘못됐습니다.');
  require(Array.isArray(worker.scope) && worker.scope.length && equal(normalized_scopes(worker.checkout, worker.scope), worker.scope), 'worker scope가 잘못됐습니다.');
  require(['active', 'ready', 'integrated', 'cleaned'].includes(worker.state), 'worker 상태가 잘못됐습니다.');
  const parent_scopes = data.repos[worker.repo].scope;
  require(worker.scope.every(scope => within_scope(scope, parent_scopes)), 'worker scope는 작업 저장소 scope 안이어야 합니다.');
  return worker;
}

function within_scope(name, scopes) {
  return !scopes.length || scopes.includes('.') || scopes.some(scope => name === scope || name.startsWith(scope.replace(/\/+$/, '') + '/'));
}

function clean_checkout(checkout) {
  require(!git(checkout, 'status', '--porcelain=v1', '--untracked-files=all'), '작업 공간이 깨끗하지 않습니다. 변경을 commit하거나 정리한 뒤 다시 실행하세요. 미커밋 변경은 복사하지 않습니다.');
}

function is_ancestor(checkout, ancestor, descendant) {
  return git(checkout, 'merge-base', ancestor, descendant) === ancestor;
}

function delivery_entry(task, entry, base_sha = entry.base_sha) {
  const checkout = entry.checkout, scopes = entry.scope;
  const is_work = name => path.resolve(checkout, name) === path.resolve(work_path(task));
  const in_scope = name => is_work(name) || within_scope(name, scopes);
  const history = git(checkout, 'log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', base_sha + '..HEAD', '--', { binary: true });
  for (const name of nul_names(history)) require(in_scope(name), `고정 base 이후 scope 밖 커밋 변경이 있습니다: ${name}`);
  const staged = git(checkout, 'diff', '--cached', '--no-renames', '--name-only', '-z', { binary: true });
  for (const name of nul_names(staged)) {
    if (is_work(name)) require(git(checkout, 'show', ':' + name, { binary: true }).equals(fs.readFileSync(work_path(task))), 'staged WORK.md가 현재 계약·검증 기록과 다릅니다. WORK.md만 다시 stage하세요.');
    require(in_scope(name), `scope 밖 staged 변경이 있습니다: ${name}`);
  }
  const untracked = git(checkout, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...(scopes.length ? scopes : ['.']), { binary: true });
  require(!nul_names(untracked).some(name => !is_work(name)), '전달 범위의 untracked 파일을 stage한 뒤 다시 검증하세요.');
  const dirty = git(checkout, 'diff', '--name-only', '-z', '--', ...(scopes.length ? scopes : ['.']), { binary: true });
  require(!nul_names(dirty).some(name => !is_work(name)), '전달 전 tracked 파일의 index와 작업 내용이 다릅니다. 관련 변경을 stage한 뒤 다시 검증하세요.');
}

function validate_worker_result(task, text, data, name, integrated = false) {
  const worker = worker_entry(task, data, name);
  const proof = planning(task, text, data);
  require(object(worker.result), 'worker result 근거가 없습니다. result TASK NAME --evidence @파일로 기록하세요.');
  const result = worker.result;
  validate_evidence(result);
  require(result.file && result.file_sha256, 'worker 결과는 실제 @근거 파일이 필요합니다.');
  require(result.assignment_sha256 === digest(assignment(worker)), 'worker 배정이 결과 기록 뒤 바뀌었습니다.');
  if (!integrated) require(result.contract_sha256 === proof.contract_sha256 && result.planning_sha256 === proof.planning_sha256, 'worker 결과의 작업 계약·설계가 바뀌었습니다. result를 다시 기록하세요.');
  const parent = data.repos[worker.repo];
  const branch_head = git(parent.checkout, 'rev-parse', '--verify', 'refs/heads/' + worker.branch + '^{commit}');
  require(branch_head === result.head_sha, 'worker branch·HEAD가 결과 기록 뒤 바뀌었습니다. result를 다시 기록하세요.');
  if (worker.state === 'cleaned') require(!fs.existsSync(worker.checkout), '정리한 worker 경로에 다시 작업 공간이 생겼습니다.');
  else {
    const current = fingerprint(task, worker.repo, worker, 'worker');
    require(current.current_fingerprint === result.fingerprint, 'worker 코드·HEAD·index가 결과 기록 뒤 바뀌었습니다. result를 다시 기록하세요.');
    delivery_entry(task, worker, result.validation_base_sha);
  }
  const parent_head = git(parent.checkout, 'rev-parse', 'HEAD');
  if (integrated) {
    require(['integrated', 'cleaned'].includes(worker.state) && worker.integrated_sha === result.head_sha && is_ancestor(parent.checkout, worker.integrated_sha, parent_head), 'worker 결과가 현재 통합 checkout에 반영되지 않았습니다.');
  } else {
    require(['active', 'ready'].includes(worker.state), '이미 통합·정리된 worker는 새 결과를 기록하거나 전달할 수 없습니다.');
    require(result.parent_head_sha === parent_head, '통합 checkout이 결과 기록 뒤 바뀌었습니다. 최신 통합 branch로 rebase하고 result를 다시 기록하세요.');
    require(result.validation_base_sha === git(worker.checkout, 'merge-base', parent_head, result.head_sha), 'worker 비교 base가 현재 통합 checkout과 다릅니다. result를 다시 기록하세요.');
  }
  return worker;
}

export function workers_digest(data) {
  return digest(Object.fromEntries(Object.entries(data.workers ?? {}).map(([name, worker]) => [name, { assignment: assignment(worker), result: worker.result?.digest ?? null, integrated_sha: worker.integrated_sha ?? null }])));
}

export function validate_integrated_workers(task, text, data) {
  for (const name of Object.keys(data.workers)) {
    const worker = worker_entry(task, data, name);
    require(['integrated', 'cleaned'].includes(worker.state), `아직 통합하지 않은 worker가 있습니다: ${name}`);
    validate_worker_result(task, text, data, name, true);
  }
}

export function fork(task, name, repo, owner, scopes, branch = null) {
  task_name(task); task_name(name);
  require(typeof owner === 'string' && owner.trim(), 'worker --owner를 지정하세요.');
  branch ??= `codex/${task}-${name}`;
  require(typeof branch === 'string' && branch && !branch.startsWith('-'), '유효한 worker branch가 필요합니다.');
  let target;
  locked(task, () => {
    const [text, data] = read_work(task);
    planning(task, text, data);
    require(Object.hasOwn(data.repos, repo), '작업에 등록되지 않은 저장소입니다. start/init으로 먼저 등록하세요.');
    require(!Object.hasOwn(data.workers, name), '이미 등록된 worker 이름입니다. 새 이름을 사용하세요.');
    const parent = data.repos[repo];
    fingerprint(task, repo, parent);
    clean_checkout(parent.checkout);
    target = safe_path('work', task, '.worktrees', name);
    require(!fs.existsSync(target), 'worker 경로가 이미 있습니다.');
    scopes = normalized_scopes(parent.checkout, scopes);
    require(scopes.length && scopes.every(scope => within_scope(scope, parent.scope)), 'worker --scope는 작업 scope 안에서 하나 이상 지정하세요.');
    git(parent.checkout, 'check-ref-format', '--branch', branch);
    const base_sha = git(parent.checkout, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    git(parent.checkout, 'worktree', 'add', '-b', branch, target, base_sha);
    data.workers[name] = { repo, checkout: target, branch, base_sha, owner: owner.trim(), scope: scopes, state: 'active', created_at: now() };
    invalidate_verification(data);
    save_work(task, text, data);
    const prepared = spawnSync(process.execPath, [safe_path('.harness', 'harness.js'), 'prepare', target], { stdio: 'inherit' });
    if (prepared.error) throw prepared.error;
    require(prepared.status === 0, 'worker context 적용에 실패했습니다. 등록된 worker에 harness.js prepare를 다시 실행하세요.');
  });
  console.log(`worker 등록: ${task}/${name} · ${target}\n통합 checkout의 commit에서 시작했습니다. 에이전트 실행은 별도로 요청하세요.`);
  return target;
}

export function result(task, name, evidence) {
  require(typeof evidence === 'string' && evidence.startsWith('@'), 'worker result에는 --evidence @파일을 지정하세요.');
  locked(task, () => {
    const [text, data] = read_work(task);
    const worker = worker_entry(task, data, name);
    require(['active', 'ready'].includes(worker.state), '이미 통합·정리된 worker 결과는 변경할 수 없습니다. 새 worker를 만드세요.');
    const proof = planning(task, text, data);
    const file = path.resolve(ROOT, evidence.slice(1));
    const evidence_root = safe_path('work', task, 'evidence');
    require(is_file(file) && !fs.lstatSync(file).isSymbolicLink() && contained(file, evidence_root), 'worker @근거 파일은 보존되는 work/TASK/evidence/ 안의 실제 파일이어야 합니다.');
    common.safe_path(evidence_root, path.relative(evidence_root, file));
    require(fs.readFileSync(file, 'utf8').trim(), '빈 근거 파일을 사용할 수 없습니다.');
    const current = fingerprint(task, worker.repo, worker, 'worker');
    const parent_head_sha = git(data.repos[worker.repo].checkout, 'rev-parse', 'HEAD');
    const validation_base_sha = git(worker.checkout, 'merge-base', parent_head_sha, current.head_sha);
    delivery_entry(task, worker, validation_base_sha);
    const record = { evidence, file: common.resolved_path(file), file_sha256: digest(fs.readFileSync(file)), recorded_at: now(), ...proof,
      assignment_sha256: digest(assignment(worker)), parent_head_sha, validation_base_sha, head_sha: current.head_sha, fingerprint: current.current_fingerprint };
    record.digest = digest(record);
    worker.result = record;
    worker.state = 'ready';
    invalidate_verification(data);
    save_work(task, text, data);
  });
  console.log('worker 결과를 기록했습니다. 검사 명령을 실행한 것은 아닙니다. commit·rebase 뒤에는 result를 다시 기록하세요.');
}

export function integrate(task, name) {
  locked(task, () => {
    const [text, data] = read_work(task);
    const worker = validate_worker_result(task, text, data, name);
    const parent = data.repos[worker.repo];
    fingerprint(task, worker.repo, parent);
    clean_checkout(parent.checkout);
    clean_checkout(worker.checkout);
    const parent_head = git(parent.checkout, 'rev-parse', 'HEAD');
    require(is_ancestor(parent.checkout, parent_head, worker.result.head_sha), `fast-forward로 통합할 수 없습니다. worker에서 ${parent.branch}로 rebase해 충돌·scope를 검증한 뒤 result를 다시 기록하세요.`);
    git(parent.checkout, 'merge', '--ff-only', worker.result.head_sha);
    worker.state = 'integrated';
    worker.integrated_sha = worker.result.head_sha;
    worker.integrated_at = now();
    invalidate_verification(data);
    observe(task, data);
    save_work(task, text, data);
  });
  console.log(`worker 통합: ${task}/${name}. 작업 전체 implementation·verification 근거를 갱신하세요.`);
}

export function clean(task, name) {
  locked(task, () => {
    const [text, data] = read_work(task);
    const worker = validate_worker_result(task, text, data, name, true);
    require(worker.state === 'integrated', '이미 정리했거나 아직 통합하지 않은 worker입니다.');
    require(!Object.values(data.phases).some(record => record.file && contained(record.file, worker.checkout)), '정리할 worker 내부에 단계 근거가 있습니다. 작업 evidence/ 파일로 해당 단계를 다시 record하세요.');
    clean_checkout(worker.checkout);
    git(data.repos[worker.repo].checkout, 'worktree', 'remove', worker.checkout);
    worker.state = 'cleaned';
    worker.cleaned_at = now();
    save_work(task, text, data);
  });
  console.log(`worker 정리: ${task}/${name}. branch와 WORK.md의 결과 기록은 보존했습니다.`);
}

export function status(task) {
  return locked(task, () => {
    const [, data] = read_work(task);
    const summary = { task, work: work_path(task), phase: data.phase,
      repos: Object.fromEntries(Object.entries(data.repos).map(([name, repo]) => [name, { checkout: repo.checkout, branch: repo.branch }])),
      workers: Object.fromEntries(Object.entries(data.workers).map(([name, worker]) => [name, { repo: worker.repo, owner: worker.owner, state: worker.state, checkout: worker.checkout, branch: worker.branch, scope: worker.scope,
        result: worker.result ? { evidence: worker.result.evidence, head_sha: worker.result.head_sha, recorded_at: worker.result.recorded_at } : null }])) };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  });
}

export function record(task, phase, evidence, reviewer = null) {
  require(typeof evidence === 'string' && evidence.trim() && !['done', 'true', 'false', 'ok', 'pass', 'passed', '완료', '성공'].includes(evidence.trim().toLowerCase()), '실제 근거 경로나 검사 결과 내용을 작성하세요. 완료 표시만으로 기록할 수 없습니다.');
  require(PHASES.includes(phase), '알 수 없는 단계입니다.');
  locked(task, () => {
    const [text, data] = read_work(task);
    const contract_hash = contract_digest(text, data);
    const delegated = delegation.request(read_control(task));
    human_gate(task, text, data, ['implementation', 'verification'].includes(phase));
    const index = PHASES.indexOf(phase);
    for (const prior of PHASES.slice(0, index)) {
      require(Object.hasOwn(data.phases, prior), `${prior} 근거를 먼저 기록하세요.`);
      validate_evidence(data.phases[prior]);
      delegation.require_file(data.phases[prior], delegated);
      require(data.phases[prior].contract_sha256 === contract_hash, '작업 계약이 바뀌었습니다. research부터 다시 기록하세요.');
    }
    observe(task, data);
    const entry = { evidence: evidence.trim(), recorded_at: now(), contract_sha256: contract_hash };
    if (evidence.startsWith('@')) {
      const file = path.resolve(ROOT, evidence.slice(1));
      require(is_file(file) && !fs.lstatSync(file).isSymbolicLink() && contained(file), '근거 @파일은 워크스페이스 안의 실제 파일이어야 합니다.');
      require(common.resolved_path(file) !== common.resolved_path(work_path(task)), '자기 WORK.md는 저장 때 바뀌므로 @근거 파일로 사용할 수 없습니다. 본문 조사 결과를 TEXT로 기록하세요.');
      require(fs.readFileSync(file, 'utf8').trim(), '빈 근거 파일을 사용할 수 없습니다.');
      Object.assign(entry, { file: common.resolved_path(file), file_sha256: digest(fs.readFileSync(file)) });
    }
    delegation.require_file(entry, delegated);
    if (phase === 'verification') {
      require(typeof reviewer === 'string' && reviewer.trim(), 'verification에는 --reviewer로 독립 검토자를 지정하세요.');
      validate_integrated_workers(task, text, data);
      Object.assign(entry, { reviewer: reviewer.trim(), body_sha256: digest(body_of(text)), fingerprints: Object.fromEntries(Object.entries(data.repos).map(([name, repo]) => [name, repo.current_fingerprint])), workers_sha256: workers_digest(data) });
      for (const repo of Object.values(data.repos)) repo.verified_fingerprint = repo.current_fingerprint;
    } else for (const repo of Object.values(data.repos)) repo.verified_fingerprint = null;
    entry.digest = digest(entry);
    data.phases = Object.fromEntries(Object.entries(data.phases).filter(([name]) => PHASES.indexOf(name) < index));
    data.phases[phase] = entry;
    data.phase = phase;
    save_work(task, text, data);
  });
  console.log(`${phase} 근거를 기록했습니다. 입력된 보고를 보관하며 검사 명령을 직접 실행한 것은 아닙니다.`);
}

export function check(cwd, delivery = false, publish = false) {
  const [task, repo, checkout, , role, worker_name] = checkout_info(cwd);
  require(!publish || role !== 'worker', 'worker branch는 push·PR로 전달할 수 없습니다. 작업의 통합 checkout에서 전달하세요.');
  delivery ||= publish;
  if (delivery && process.env.GIT_INDEX_FILE) {
    const actual_index = common.resolved_path(process.env.GIT_INDEX_FILE);
    const expected_index = common.resolved_path(git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'index'));
    require(actual_index === expected_index, '임시 Git index 전달은 검증하지 않습니다. commit --only/--include/-a 대신 일반 index에 stage하고 다시 검증하세요.');
  }
  locked(task, () => {
    const [text, data] = read_work(task);
    if (role === 'worker') {
      const worker = worker_entry(task, data, worker_name);
      planning(task, text, data);
      fingerprint(task, repo, worker, 'worker');
      if (delivery || worker.result) validate_worker_result(task, text, data, worker_name);
      return;
    }
    require(Object.hasOwn(data.repos, repo) && data.repos[repo].checkout === checkout, '현재 checkout이 해당 WORK.md에 등록되지 않았습니다.');
    human_gate(task, text, data, delivery);
    observe(task, data);
    validate_phases(text, data, delivery);
    if (delivery) for (const entry of Object.values(data.repos)) delivery_entry(task, entry);
  });
  console.log(`작업 검사: ${task} · ${delivery ? 'delivery' : 'check'} OK`);
}

export function decision(task) {
  const session = process.env.CODEX_THREAD_ID;
  require(session, '작업 승인을 연결할 Codex 세션 ID가 없습니다.');
  let text, data, code, proposal, delegated;
  locked(task, () => {
    [text, data] = read_work(task);
    const control = read_control(task);
    require(control.mode === 'human', '사용자가 먼저 작업 통제 TASK를 보내야 합니다.');
    delegated = delegation.request(control);
    code = randomBytes(6).toString('hex');
    proposal = { code, contract_sha256: contract_digest(text, data), session_id: session };
    control.proposal = proposal;
    delete control.approval;
    save_control(task, control);
  });
  const repos = Object.fromEntries(Object.entries(data.repos).map(([name, repo]) => [name, Object.fromEntries(Object.entries(repo).filter(([key]) => ['checkout', 'branch', 'base_ref', 'base_sha', 'scope'].includes(key)))]));
  const delegatedText = delegated ? `\n원본 아이디어:\n${delegated.idea}\n위임 브리프:\n${Object.entries(delegation.brief(body_of(text), delegated)).map(([label, value]) => `- ${label}: ${value}`).join('\n')}` : '';
  console.log(`작업: ${task}\n${contract(text)}${delegatedText}\n저장소 계약: ${JSON.stringify(repos)}\n계약 SHA-256: ${proposal.contract_sha256}\n작업 승인 ${task} ${code}`);
}

export function public_text(file) {
  const text = fs.readFileSync(file, 'utf8');
  const forbidden = [/own-harness-work:v\d/, /\bWORK\.md\b/, /\.worktrees(?:\/|\\)/, new RegExp(escape_regex(ROOT)), /\.harness(?:\/|\\)private(?:\/|\\)/,
    /(?:^|[\s("'`<]|\/)work[/\\][a-z0-9][a-z0-9._-]{0,79}[/\\](?:WORK\.md(?:\b|$)|(?:evidence|repos|\.worktrees)(?:[/\\]|(?=$|[\s"'`)\]<>])))/m,
    /"(?:current_fingerprint|verified_fingerprint|contract_sha256|control_mode|assignment_sha256|planning_sha256|workers_sha256)"\s*:/,
    /^\s*(?:[-*]\s+|\|\s*)?["`]?\b(?:assignment_sha256|planning_sha256|workers_sha256)["`]?\s*[:=|]\s*/m];
  require(!forbidden.some(pattern => pattern.test(text)), '외부 문서에 내부 WORK metadata 또는 로컬 워크스페이스/worktree 경로가 포함됐습니다.');
  console.log('외부 문서 검사: OK');
}

export function hook(event) {
  require(object(event), 'hook event는 JSON 객체여야 합니다.');
  const kind = event.hook_event_name;
  if (kind === 'PreToolUse') {
    const inputs = event.tool_input ?? {};
    const value = object(inputs) ? JSON.stringify(inputs) : String(inputs);
    if (/work\.js[\s"']+hook\b/.test(value) || (value.includes('.harness/private/work-control') && /write|apply_patch|>|tee\b|unlink|remove|rm\b/.test((event.tool_name ?? '') + ' ' + value))) {
      return { decision: 'block', reason: '작업 통제 상태는 실제 UserPromptSubmit 훅만 변경할 수 있습니다. hook 직접 실행·승인 파일 변경은 허용하지 않습니다.' };
    }
    return {};
  }
  if (kind !== 'UserPromptSubmit') return {};
  const prompt = event.prompt ?? '';
  const output = message => ({ hookSpecificOutput: { hookEventName: kind, additionalContext: message } });
  if (typeof prompt === 'string' && /^아이디어 위임(?:\s|$)/u.test(prompt.trim())) {
    try {
      const { task, delegation: delegated } = delegation.capture(event);
      task_name(task);
      require(typeof event.cwd === 'string' && path.isAbsolute(event.cwd), 'hook cwd는 절대 경로여야 합니다.');
      require((contained(event.cwd) && fs.existsSync(event.cwd)) || is_file(work_path(task)), '워크스페이스 범위 또는 명시한 기존 작업이 필요합니다.');
      let duplicate = false;
      locked(task, () => {
        const control = read_control(task);
        const event_key = digest(delegated);
        if (control.last_delegation_event === event_key) { duplicate = true; return; }
        // Preserve human control; delegation does not grant a contract approval.
        const next = { ...control, task_id: task, mode: control.mode ?? 'pstack',
          session_id: delegated.session_id, turn_id: delegated.turn_id, event: kind,
          updated_at: now(), delegation: delegated, last_delegation_event: event_key };
        delete next.approval;
        delete next.proposal;
        if (is_file(work_path(task))) {
          const [text, data] = read_work(task);
          require(data.control_mode === next.mode, 'WORK.md의 control_mode와 runtime 통제 상태가 다릅니다.');
          save_work(task, delegation.scaffold(text, delegated), data);
        }
        save_control(task, next);
      });
      return duplicate ? {} : output(`${task}: 아이디어 위임을 기록했습니다. 로컬 pstack-codex 스킬을 읽고 작업을 start/init하세요. work.js brief ${task}로 원본과 필수 브리프를 확인하고 조사 → 설계 → 구현 → 검증을 --evidence @파일로 기록하세요. 브리프나 근거가 없으면 단계·전달 검사를 통과할 수 없습니다.`);
    } catch (error) { return output(`아이디어 위임을 적용하지 못했습니다: ${error.message}`); }
  }
  if (typeof prompt !== 'string' || !/^작업 (통제|이양|승인)(?:\s|$)/.test(prompt.trim())) return {};
  try {
    const match = /^작업 (통제|이양|승인) ([a-z0-9][a-z0-9._-]{0,79})(?: ([a-f0-9]{12}))?$/.exec(prompt.trim());
    require(match, '정확한 명령: 작업 통제 TASK / 작업 이양 TASK / 작업 승인 TASK CODE');
    const [, action, task, code] = match;
    task_name(task);
    const [session, turn] = common.event_proof(event);
    const cwd = event.cwd;
    require(typeof cwd === 'string' && path.isAbsolute(cwd), 'hook cwd는 절대 경로여야 합니다.');
    require((contained(cwd) && fs.existsSync(cwd)) || is_file(work_path(task)), '워크스페이스 범위 또는 명시한 기존 작업이 필요합니다.');
    let duplicate = false;
    locked(task, () => {
      const [text, data] = read_work(task);
      let control = read_control(task);
      const event_key = digest({ session, turn, prompt: prompt.trim() });
      if (control.last_event === event_key) { duplicate = true; return; }
      const proof = { task_id: task, session_id: session, turn_id: turn, event: kind, updated_at: now() };
      if (['통제', '이양'].includes(action)) {
        require(code === undefined, '통제·이양에는 승인 코드를 붙이지 마세요.');
        control = { ...proof, mode: action === '통제' ? 'human' : 'pstack',
          ...(control.delegation ? { delegation: control.delegation, last_delegation_event: control.last_delegation_event } : {}) };
        data.control_mode = control.mode;
      } else {
        const proposal = control.proposal ?? {};
        require(control.mode === 'human' && code && proposal.code === code && proposal.session_id === session && proposal.contract_sha256 === contract_digest(text, data), '승인 코드·세션·작업 계약이 일치하지 않습니다. decision을 다시 실행하세요.');
        control.approval = { ...proof, contract_sha256: proposal.contract_sha256 };
        delete control.proposal;
      }
      control.last_event = event_key;
      save_control(task, control);
      save_work(task, text, data);
    });
    if (duplicate) return {};
    return output(`${task}: ` + (action === '통제' ? '사용자 통제로 전환했습니다. 조사·설계 기록은 허용하며 계약 승인 전 구현·검증 기록과 전달 검사를 차단합니다.' : action === '이양' ? 'pstack 진행으로 이양했습니다.' : '현재 작업 계약 승인을 기록했습니다.'));
  } catch (error) { return output(`작업 명령을 적용하지 못했습니다: ${error.message}`); }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const command = argv[0];
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log('Usage: bun work.js <start|init|snapshot|brief|record|check|fork|result|integrate|clean|status|decision|public-text|hook> [options]');
      return 0;
    }
    const options = {
      init: { cwd: { type: 'string', default: process.cwd() }, base: { type: 'string' }, scope: { type: 'string', multiple: true, default: [] } },
      start: { repo: { type: 'string' }, base: { type: 'string' }, branch: { type: 'string' } },
      fork: { repo: { type: 'string' }, owner: { type: 'string' }, scope: { type: 'string', multiple: true, default: [] }, branch: { type: 'string' } },
      result: { evidence: { type: 'string' } },
      integrate: {}, clean: {}, status: {},
      record: { evidence: { type: 'string' }, reviewer: { type: 'string' } },
      check: { cwd: { type: 'string', default: process.cwd() }, delivery: { type: 'boolean', default: false }, publish: { type: 'boolean', default: false } },
      snapshot: {}, brief: {}, decision: {}, 'public-text': {}, hook: {},
    };
    require(Object.hasOwn(options, command), '명령을 지정하세요: start, init, snapshot, brief, record, check, fork, result, integrate, clean, status, decision, public-text, hook');
    const { values, positionals } = parseArgs({ args: argv.slice(1), options: options[command], allowPositionals: true, strict: true });
    const expected = ['start', 'init', 'snapshot', 'brief', 'status', 'decision', 'public-text'].includes(command) ? 1 : ['record', 'fork', 'result', 'integrate', 'clean'].includes(command) ? 2 : 0;
    require(positionals.length === expected, `${command}: 인자 수가 잘못됐습니다.`);
    for (const name of ({ init: ['base'], start: ['repo', 'base', 'branch'], fork: ['repo', 'owner'], result: ['evidence'], record: ['evidence'] }[command] ?? [])) require(typeof values[name] === 'string', `--${name} 옵션이 필요합니다.`);
    common.load_config(ROOT);
    if (command === 'hook') {
      const result = hook(JSON.parse(fs.readFileSync(0, 'utf8')));
      if (result.decision === 'block') { console.error(result.reason); return 2; }
      console.log(JSON.stringify(result));
    } else if (command === 'init') init(positionals[0], values.cwd, values.base, values.scope);
    else if (command === 'start') start(positionals[0], values.repo, values.base, values.branch);
    else if (command === 'record') record(positionals[0], positionals[1], values.evidence, values.reviewer);
    else if (command === 'check') check(values.cwd, values.delivery, values.publish);
    else if (command === 'fork') fork(positionals[0], positionals[1], values.repo, values.owner, values.scope, values.branch);
    else if (command === 'result') result(positionals[0], positionals[1], values.evidence);
    else if (command === 'integrate') integrate(positionals[0], positionals[1]);
    else if (command === 'clean') clean(positionals[0], positionals[1]);
    else if (command === 'status') status(positionals[0]);
    else if (command === 'snapshot') snapshot(positionals[0]);
    else if (command === 'brief') brief(positionals[0]);
    else if (command === 'decision') decision(positionals[0]);
    else if (command === 'public-text') public_text(positionals[0]);
    return 0;
  } catch (error) { console.error(`work guard: ${error.message}`); return 2; }
}

if (import.meta.main) process.exitCode = main();
