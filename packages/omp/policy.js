import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, executionReason } from '../codex/runtime/steering-state.js';

const WORKSPACE = '.own-harness-workspace.json';
const TASK = '.own-harness-work.json';
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const fields = ['목표', '범위', '비목표', '완료 조건', '설계 결정과 미정 사항'];
const readTools = new Set(['read', 'grep', 'find', 'ls', 'glob', 'web_search', 'fetch', 'search_tool', 'tool_search']);
// OMP가 같은 프로세스에서 새 factory로 자식을 만들므로, 작업별 부모 연결만 공유한다.
const bindings = new Map();
const rules = `## 작업 운영 규칙

- task.md는 이 작업의 아이디어·목표·범위·비목표·설계 결정·완료 조건을 관리하는 정본이다.
- 확정된 결정과 제안을 구분한다. 범위 변경은 사용자와 먼저 정리하고 task.md에 반영한다.
- 프로젝트 전체의 DESIGN.md와 충돌하는 결정은 먼저 조정한다.
- 작업 문서 작성이나 생성 확인은 구현·commit·push·PR·배포 승인을 대신하지 않는다.
- 부모는 지정된 저장소 worktree에서, 서브에이전트는 배정된 격리 공간에서 작업한다.
- 서브에이전트는 부모 task.md와 작업 지침을 수정하지 않고 결과와 검증 근거를 부모에게 반환한다.
- 저장소별 지침은 .work-rules/<저장소>.md에 있으며 배정받은 저장소의 지침만 적용한다.
- task.md 필수 항목이 미완성이면 조회와 부모의 task.md 보완만 진행한다.
- 훅은 문서 준비 상태와 지원되는 도구의 경로를 검사한다. 의미상 설계 준수나 OS 파일 격리를 보장하지 않는다.
`;

function present(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function textFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`일반 파일이 필요합니다: ${file}`);
  return fs.readFileSync(file, 'utf8');
}
function realDir(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`실제 디렉터리가 필요합니다: ${dir}`);
  return dir;
}
function writeNew(file, text) {
  try { fs.writeFileSync(file, text, { flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    textFile(file); // 기존 사용자 파일은 보존하되 링크·특수 파일은 거절한다.
  }
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function common(dir) { return fs.realpathSync(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')); }

export function activateWorkspace(root) {
  writeNew(path.join(root, WORKSPACE), '{"schema":1}\n');
  if (JSON.parse(textFile(path.join(root, WORKSPACE))).schema !== 1) throw new Error('지원하지 않는 workspace 정책입니다.');
}

function inheritedRules(root) {
  const sources = [];
  let dir = root;
  while (dir !== os.homedir() && dir !== path.dirname(dir)) {
    const file = path.join(dir, 'AGENTS.md');
    if (present(file)) sources.unshift({ file, body: textFile(file) });
    dir = path.dirname(dir);
  }
  const repositoryRules = path.join(root, 'repository', 'AGENTS.md');
  if (present(repositoryRules)) sources.push({ file: repositoryRules, body: textFile(repositoryRules) });
  return sources;
}

export function preparePolicy(root, taskDir) {
  realDir(taskDir);
  const metadataPath = path.join(taskDir, TASK);
  let metadata;
  if (present(metadataPath)) {
    metadata = JSON.parse(textFile(metadataPath));
    if (metadata.schema !== 1 || !Array.isArray(metadata.repos) || !metadata.repos.length || metadata.repos.some(n => typeof n !== 'string' || !NAME.test(n))) {
      throw new Error('작업 연결 기록이 손상됐습니다.');
    }
  } else {
    const repos = fs.readdirSync(taskDir).filter(n => NAME.test(n) && present(path.join(taskDir, n, '.git')));
    if (!repos.length) throw new Error('작업에 등록할 worktree가 없습니다.');
    metadata = { schema: 1, repos };
  }
  for (const repo of metadata.repos) {
    const source = realDir(path.join(root, 'repository', repo));
    const checkout = realDir(path.join(taskDir, repo));
    if (common(source) !== common(checkout) || fs.realpathSync(git(checkout, 'rev-parse', '--show-toplevel')) !== checkout) {
      throw new Error(`원본에 연결된 작업 worktree가 아닙니다: ${repo}`);
    }
  }
  const snapshots = path.join(taskDir, '.work-rules');
  if (!present(snapshots)) fs.mkdirSync(snapshots);
  realDir(snapshots);
  const agents = path.join(taskDir, 'AGENTS.md');
  if (present(agents)) textFile(agents);
  else writeNew(agents, `# 작업 지침\n\n${rules}\n${inheritedRules(root).map(s => `## 상속 출처: ${s.file}\n\n${s.body}`).join('\n\n')}`);
  for (const repo of metadata.repos) {
    const snapshot = path.join(snapshots, `${repo}.md`);
    if (present(snapshot)) { textFile(snapshot); continue; }
    const checkoutRules = path.join(taskDir, repo, 'AGENTS.md');
    const sourceRules = path.join(root, 'repository', repo, 'AGENTS.md');
    const file = present(checkoutRules) ? checkoutRules : present(sourceRules) ? sourceRules : null;
    writeNew(snapshot, file ? `# ${repo} 지침\n\n출처: ${file}\n\n${textFile(file)}` : `# ${repo} 지침\n\n생성 시 저장소 루트 AGENTS.md 없음.\n`);
  }
  writeNew(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

export function policyFor(ctx) {
  const cwd = fs.realpathSync(ctx.cwd);
  let root = cwd;
  while (!present(path.join(root, WORKSPACE))) {
    const parent = path.dirname(root);
    if (root === parent) return null;
    root = parent;
  }
  if (JSON.parse(textFile(path.join(root, WORKSPACE))).schema !== 1) throw new Error('지원하지 않는 workspace 정책입니다.');
  const relative = path.relative(root, cwd).split(path.sep);
  if (relative[0] !== 'work' || !NAME.test(relative[1] ?? '')) return { root, cwd };
  const taskDir = realDir(path.join(root, 'work', relative[1]));
  const metadata = preparePolicy(root, taskDir);
  const key = id => `${taskDir}\0${id}`;
  const bound = id => { const values = bindings.get(key(id)); return values?.size === 1 ? [...values][0] : undefined; };
  let repo = metadata.repos.includes(relative[2]) ? relative[2] : undefined;
  if (relative[2] === '.sub-workspace') {
    repo = ctx.agent?.parentId ? bound(ctx.agent.parentId) : bound(ctx.agent?.id);
  }
  const child = ctx.agent?.kind === 'sub';
  const checkout = repo ? (relative[2] === '.sub-workspace' ? fs.realpathSync(git(cwd, 'rev-parse', '--show-toplevel')) : path.join(taskDir, repo)) : undefined;
  if (checkout && !within(taskDir, checkout)) throw new Error('배정된 작업 밖의 checkout입니다.');
  if (checkout && relative[2] === '.sub-workspace') {
    const source = path.join(root, 'repository', repo);
    const registered = git(source, 'worktree', 'list', '--porcelain', '-z').split('\0').filter(row => row.startsWith('worktree ')).some(row => {
      try { return fs.realpathSync(row.slice(9)) === checkout; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    if (!within(path.join(taskDir, '.sub-workspace'), checkout) || common(source) !== common(checkout) || !registered) {
      throw new Error('부모 저장소에 등록된 격리 worktree가 아닙니다.');
    }
  }
  if (repo && ctx.agent?.id) {
    const values = bindings.get(key(ctx.agent.id)) ?? new Set();
    values.add(repo);
    bindings.set(key(ctx.agent.id), values);
  }
  return { root, cwd, taskDir, repo, checkout, child, isolated: relative[2] === '.sub-workspace' };
}

function contract(policy) {
  const file = path.join(policy.taskDir, 'task.md');
  const body = present(file) ? textFile(file) : '';
  const missing = fields.filter(field => {
    const matches = [...body.matchAll(new RegExp(`^## ${field}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'gm'))];
    return matches.length !== 1 || !matches[0][1].trim() || /^(작성 필요|TODO|미작성)$/i.test(matches[0][1].trim());
  });
  return { body, missing };
}

function steeringState(policy) {
  const workspaces = [policy.root];
  if (policy.taskDir) workspaces.push(policy.taskDir);
  if (policy.isolated && policy.checkout) {
    // A repository-owned state.json is product data, never a child control file.
    if (!git(policy.checkout, 'ls-files', '--', 'state.json')) workspaces.push(policy.checkout);
  }
  return readState(workspaces);
}

export function policyContext(ctx) {
  const policy = policyFor(ctx);
  if (!policy) return null;
  const steering = steeringState(policy).context;
  if (!policy.taskDir) return [steering, '이 workspace는 작업 훅이 활성화돼 있습니다. /work-init 대화에서 작업을 정의하고 work_create의 사용자 확인으로 생성하세요. 작업 연결 전에는 조회와 이 생성 도구만 허용됩니다.'].filter(Boolean).join('\n');
  const { body, missing } = contract(policy);
  return `${steering}\n${rules}\n작업: ${policy.taskDir}\n담당 저장소: ${policy.repo ?? '미연결 — 저장소별 실행 명령으로 시작하세요.'}\n현재 checkout: ${policy.checkout ?? '없음'}\n문서 검사: ${missing.length ? `미완성: ${missing.join(', ')}` : '필수 항목 있음 (사람의 승인 또는 내용의 적절성 보증 아님)'}\n\n${textFile(path.join(policy.taskDir, 'AGENTS.md'))}\n\n${policy.repo ? textFile(path.join(policy.taskDir, '.work-rules', `${policy.repo}.md`)) : ''}\n\n# 현재 task.md\n\n${body}`;
}

function resolvedTarget(cwd, value) {
  // OMP의 URI·별칭·hashline 경로 재해석을 추측하지 않고 일반 path만 검사한다.
  if (typeof value !== 'string' || !value || /^[~@]/.test(value) || /[\0\r\n:\\\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(value)
    || (value.startsWith('[') && value.trimEnd().endsWith(']'))) throw new Error('경로 별칭·URI·hashline 형식은 검사하지 않습니다. 일반 파일 path를 받는 write 또는 edit 형식을 사용하세요.');
  const target = path.resolve(cwd, value);
  let existing = target;
  while (!present(existing)) existing = path.dirname(existing);
  return path.resolve(fs.realpathSync(existing), path.relative(existing, target));
}

export function checkTool(event, ctx) {
  let additionalContext;
  const result = checkPolicyTool(event, ctx, context => { additionalContext = context; });
  return additionalContext ? { ...result, ...(result?.block ? { reason: `${result.reason}\n${additionalContext}` } : {}), additionalContext } : result;
}

function checkPolicyTool(event, ctx, context) {
  try {
    const p = policyFor(ctx);
    if (!p) return;
    const block = reason => ({ block: true, reason });
    const current = steeringState(p);
    context(current.context);
    if (readTools.has(event.toolName)) return;
    const reason = executionReason(current);
    if (reason) return block(reason);
    if (event.toolName === 'work_create') return; // 자체 대화 시작·부모·UI 확인 검사 사용
    if (!p.taskDir) return block('작업에 연결되지 않았습니다. /work-init 후 해당 worktree에서 시작하세요.');
    if (p.child && !p.isolated) return block('서브에이전트의 변경 실행은 .sub-workspace 격리 공간에서만 허용됩니다. 조회는 계속할 수 있습니다.');
    const docs = ['task.md', 'AGENTS.md'].map(n => path.join(p.taskDir, n));
    if (['write', 'edit'].includes(event.toolName)) {
      const input = event.input ?? {};
      const paths = [input.path, ...(input.edits ?? []).filter(e => e.rename).map(e => e.rename)].map(v => resolvedTarget(ctx.cwd, v));
      if (!p.child && paths.every(file => docs.includes(file))) return;
      if (!p.checkout || paths.some(file => !within(p.checkout, file))) return block('배정된 checkout 밖의 파일 변경은 허용하지 않습니다.');
      if (paths.some(file => file.split(path.sep).includes('.git'))) return block('Git 내부 파일은 직접 수정할 수 없습니다.');
    }
    const { missing } = contract(p);
    if (missing.length) return block(`task.md 필수 항목을 먼저 보완하세요: ${missing.join(', ')}. 조회와 부모의 task.md·AGENTS.md 보완은 허용됩니다.`);
    if (!p.checkout) return block('담당 저장소에 연결되지 않았습니다. 저장소별 worktree에서 시작하세요.');
    if (event.toolName === 'ast_edit') return block('현재 경로 검사는 write/edit를 지원합니다. 이 작업에서는 write/edit를 사용하세요.');
  } catch (error) {
    const reason = `작업 정책 검사 실패: ${error.message}`;
    context(reason);
    return readTools.has(event.toolName) ? undefined : { block: true, reason };
  }
}

export function registerPolicy(pi) {
  pi.on('session_start', (_event, ctx) => {
    try { policyFor(ctx); } catch (error) { ctx.ui.notify(`작업 준비 실패: ${error.message}`, 'error'); }
  });
  pi.on('before_agent_start', (event, ctx) => {
    let content;
    try { content = policyContext(ctx); } catch (error) { content = `작업 정책을 읽지 못했습니다. 변경 실행을 중단하고 문서를 점검하세요: ${error.message}`; }
    if (content) return { systemPrompt: [...event.systemPrompt, content] };
  });
  pi.on('tool_call', checkTool);
  pi.on('before_subagent_spawn', (_event, ctx) => checkTool({ toolName: 'task', input: {} }, ctx));
}
