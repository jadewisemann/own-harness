import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activateWorkspace, preparePolicy, registerPolicy, TASK_STATE, taskWritingRules, repositoryPaths } from './policy.js';

const validName = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const exists = file => fs.existsSync(file) || (() => {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
})();

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function directory(parent, name, create = false) {
  const target = path.join(parent, name);
  if (!exists(target) && create) fs.mkdirSync(target);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`실제 디렉터리가 필요합니다: ${target}`);
  return target;
}

export function workspace(cwd) {
  let current = fs.realpathSync(cwd);
  while (true) {
    if (exists(path.join(current, '.harness/config.json')) || exists(path.join(current, 'repository'))) {
      repositoryPaths(current);
      return current;
    }
    const parent = path.dirname(current);
    if (current === parent) throw new Error('repository/가 있는 workspace 안에서 실행하세요.');
    current = parent;
  }
}

function taskPath(root, name) {
  if (!validName.test(name ?? '')) throw new Error('작업 이름은 영문 소문자·숫자로 시작하는 1~64자의 소문자·숫자·밑줄·하이픈이어야 합니다.');
  return path.join(root, 'work', name);
}

export function createWork(cwd, args, brief, title, selectedBranch) {
  const [name, ...specs] = args.trim().split(/\s+/);
  const root = workspace(cwd);
  const target = taskPath(root, name);
  if (!specs.length) throw new Error('/work-init 작업명 저장소=기준ref ... 형식으로 실행하세요.');
  if (exists(path.join(root, 'work'))) directory(root, 'work');
  if (exists(target)) throw new Error(`이미 있는 작업은 덮어쓰지 않습니다: ${target}`);
  const branch = selectedBranch ?? `work/${name}`;
  if (typeof branch !== 'string' || !branch || /\s/.test(branch) || branch.startsWith('-')) throw new Error('유효한 작업 브랜치를 지정하세요.');
  const seen = new Set();
  const repos = specs.map(spec => {
    const separator = spec.indexOf('=');
    const repo = spec.slice(0, separator);
    const ref = spec.slice(separator + 1);
    if (separator < 1 || !validName.test(repo) || !ref || ref.startsWith('-') || seen.has(repo)) {
      throw new Error(`중복 없이 저장소=기준ref를 지정하세요: ${spec}`);
    }
    seen.add(repo);
    const source = repositoryPaths(root)[repo];
    if (!source) throw new Error(`설정에 없는 저장소입니다: ${repo}`);
    if (fs.realpathSync(git(source, 'rev-parse', '--show-toplevel')) !== source) {
      throw new Error(`저장소 루트가 아닙니다: ${source}`);
    }
    const common = fs.realpathSync(git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (seen.has(common)) throw new Error('같은 Git 저장소를 두 번 지정할 수 없습니다.');
    seen.add(common);
    git(source, 'check-ref-format', '--branch', branch);
    const sha = git(source, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
    if (git(source, 'branch', '--list', branch)) throw new Error(`이미 있는 브랜치입니다: ${repo} ${branch}`);
    return { repo, source, ref, sha };
  });
  activateWorkspace(root);
  directory(root, 'work', true);
  fs.mkdirSync(target);
  directory(target, '.sub-workspace', true);
  fs.writeFileSync(path.join(target, 'task.md'), `# ${title ?? name}\n\n${brief ?? ['목표', '범위', '하지 않을 일', '완료 조건', '결정 사항'].map(h => `## ${h}\n\n작성 필요`).join('\n\n')}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(target, TASK_STATE), JSON.stringify({ schema: 1, task_id: name, control_mode: 'pstack', phase: 'research', phases: {}, workers: {},
    repos: Object.fromEntries(repos.map(r => [r.repo, { checkout: path.join(target, r.repo), base_ref: r.ref, base_sha: r.sha, branch, scope: [], verified_fingerprint: null }])) }, null, 2) + '\n', { flag: 'wx' });
  try {
    for (const repo of repos) {
      const checkout = path.join(target, repo.repo);
      git(repo.source, 'worktree', 'add', '-b', branch, checkout, repo.sha);
      const installer = path.join(root, '.harness/harness.js');
      if (exists(installer)) execFileSync(process.execPath, [installer, 'prepare', checkout], { stdio: 'pipe' });
    }
  } catch (error) {
    throw new Error(`일부 준비가 실패했습니다. 생성된 파일·worktree는 보존했습니다. ${target}의 Git 상태를 확인하세요.\n${error.message}`);
  }
  return openWork(cwd, name);
}

function workSessions(cwd, name) {
  const root = workspace(cwd);
  const target = taskPath(root, name.trim());
  directory(root, 'work');
  directory(path.join(root, 'work'), name.trim());
  const sub = directory(target, '.sub-workspace');
  const task = path.join(target, 'task.md');
  if (!fs.lstatSync(task).isFile()) throw new Error(`일반 파일이 필요합니다: ${task}`);
  const metadata = preparePolicy(root, target);
  const repos = metadata.names;
  const sessions = [];
  for (const repo of repos) {
    const checkout = Array.isArray(metadata.repos) ? directory(target, repo) : metadata.repos[repo].checkout;
    const source = repositoryPaths(root)[repo];
    if (!source) throw new Error(`설정에 없는 저장소입니다: ${repo}`);
    const common = dir => fs.realpathSync(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (common(source) !== common(checkout) || fs.realpathSync(git(checkout, 'rev-parse', '--show-toplevel')) !== checkout) {
      throw new Error(`원본 저장소에 연결된 worktree가 아닙니다: ${checkout}`);
    }
    const args = ['--cwd', checkout, '--session-dir', path.join(target, '.sessions', repo), `@${task}`];
    sessions.push({ repo, checkout, sub, args });
  }
  if (!sessions.length) throw new Error('작업에 연결된 worktree가 없습니다.');
  activateWorkspace(root);
  preparePolicy(root, target);
  return { task, sessions };
}

export function openWork(cwd, name) {
  const { task, sessions } = workSessions(cwd, name);
  const commands = sessions.map(s => `OMP_WORKTREE_DIR=${quote(s.sub)} omp ${s.args.map(quote).join(' ')}`);
  return `작업 문서: ${task}\n목표·범위·완료 조건과 현재 Git 상태를 확인한 뒤 아래 명령으로 이어가세요.\n각 명령은 해당 저장소용 새 omp 세션을 시작합니다.\n\n${commands.join('\n\n')}\n\n.sub-workspace는 omp 전용 임시 공간입니다. task 도구의 격리 활성화 여부는 omp 설정을 따릅니다. /wt·PR checkout도 이 경로를 사용하므로 영구 작업을 두지 마세요.`;
}

async function offerWorkTab(pi, ctx, name, fallback, autoStart = false) {
  if (!ctx.hasUI || process.env.TERM_PROGRAM?.toLowerCase() !== 'tern') return fallback;
  try {
    const { task, sessions } = workSessions(ctx.cwd, name);
    const choices = sessions.map(s => `새 탭에서 시작: ${s.repo}`);
    const selected = autoStart && sessions.length === 1 ? choices[0]
      : await ctx.ui.select('작업을 Tern 새 탭에서 시작할까요?', [...choices, '나중에 시작']);
    const session = sessions[choices.indexOf(selected)];
    if (!session) return fallback;
    const result = await pi.exec('tern', ['new', 'tab', '--cwd', session.checkout, '--',
      '/usr/bin/env', `PATH=${process.env.PATH}`, `OMP_WORKTREE_DIR=${session.sub}`, 'omp', ...session.args], { timeout: 10000 });
    if (result.code !== 0 || result.killed) throw new Error(result.stderr || 'Tern 새 탭 요청에 실패했습니다.');
    return `Tern에 ${session.repo} 작업용 새 탭을 열었습니다.\n작업 문서: ${task}\n새 탭에서 OMP 시작 상태를 확인하세요. 기존 탭의 대화는 유지됩니다.`;
  } catch (error) {
    return `작업은 준비돼 있지만 새 탭 열기를 완료하지 못했습니다: ${error.message}\n이미 열린 탭이 있는지 확인한 뒤 /work-open ${name}으로 다시 시도하거나 아래 명령을 사용하세요.\n\n${fallback}`;
  }
}

export function nextNamePrefix(root, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const work = path.join(root, 'work');
  const names = exists(work) ? fs.readdirSync(directory(root, 'work')) : [];
  const numbers = names.map(name => new RegExp(`^${date}__(\\d{2})__`).exec(name)).filter(Boolean).map(m => Number(m[1]));
  const next = Math.max(0, ...numbers) + 1;
  if (next > 99) throw new Error('오늘의 두 자리 작업 번호를 모두 사용했습니다.');
  return `${date}__${String(next).padStart(2, '0')}__`;
}

export function startWorkConversation(cwd, idea = '') {
  const root = workspace(cwd);
  const repos = Object.entries(repositoryPaths(root)).map(([name, source]) => {
    try {
      const branch = git(source, 'branch', '--show-current') || '(detached HEAD)';
      const refs = git(source, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean);
      return { name, currentBranch: branch, refs };
    } catch { return { name, error: 'Git 정보를 확인하지 못함' }; }
  });
  return { root, prompt: `플러그인의 /work-init 안내입니다. 이것은 작업 생성이나 구현에 대한 사용자 승인이 아닙니다.
사용자와 대화하며 작업을 구체화하세요. 아직 파일이나 worktree를 만들지 마세요.
workspace: ${root}
사용자가 덧붙인 아이디어: ${JSON.stringify(idea)}
발견한 저장소와 로컬 ref: ${JSON.stringify(repos)}
1. workspace와 선택할 저장소의 AGENTS.md·AGENTS.override.md 및 관련 설계를 읽고, 이미 대화에서 답한 내용은 다시 묻지 마세요.
2. 해결할 문제·원하는 결과부터 대화하세요. 이어서 범위·비목표·완료 조건을 정리하세요. 한 번에 질문을 쏟아내지 마세요.
3. 필요한 저장소와 기준 ref는 위 정보를 바탕으로 제안하세요. 현재 브랜치가 원하는 기준이라고 단정하지 마세요. 저장소의 브랜치 이름 규칙이 있으면 branch 필드에 그 규칙에 맞는 이름을 지정하세요.
4. 이름은 YY-MM-DD__NN__짧은-영문-설명 형식입니다. 현재 한국 날짜의 다음 접두사는 ${nextNamePrefix(root)} 입니다. 이름 후보를 제안하고 사용자 선호를 반영하세요.
5. task.md는 사용자가 먼저 읽는 문서입니다. title에는 읽기 쉬운 한국어 작업 제목을, goal, scope, nonGoals, acceptance, decisions에는 짧은 초안을 작성하세요. 확정된 결정과 미정 사항을 구분하세요.
6. 대화가 정리되면 work_create 도구로 이름·저장소·문서 초안을 제출하세요. 사용자가 직접 확인하는 화면을 거쳐 생성됩니다. 사용자에게 긴 /work-init 명령을 조립하거나 다시 입력하도록 요구하지 마세요.
7. 다른 도구로 대신 폴더를 생성하지 마세요. 생성 후에는 work_create가 반환한 새 탭 열기 결과 또는 재개 명령을 안내하세요.

${taskWritingRules}` };
}

export default function workExtension(pi) {
  registerPolicy(pi);
  let draftingRoot;
  let creating = false;
  // 확장 factory 안의 상태로 부모·서브에이전트의 대화형 생성 요청을 분리한다.
  const z = pi.zod;
  pi.registerTool({
    name: 'work_create',
    label: '대화로 정리한 작업 생성',
    description: '/work-init 대화에서 정리한 작업을 사용자 확인 후 생성합니다. 이름은 YY-MM-DD__NN__short-description 형식입니다.',
    parameters: z.object({
      name: z.string(),
      title: z.string().optional(),
      branch: z.string().optional(),
      repos: z.array(z.object({ name: z.string(), ref: z.string() })),
      goal: z.string(), scope: z.string(), nonGoals: z.string(), acceptance: z.string(), decisions: z.string(),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!draftingRoot || workspace(ctx.cwd) !== draftingRoot || ctx.agent?.kind === 'sub') {
        throw new Error('부모 세션에서 /work-init으로 작업 대화를 먼저 시작하세요.');
      }
      if (!ctx.hasUI) throw new Error('사용자가 작업 초안을 확인할 수 있는 대화형 omp 세션이 필요합니다.');
      if (creating) throw new Error('이미 작업 생성 확인이 진행 중입니다.');
      if (!/^\d{2}-\d{2}-\d{2}__[0-9]{2}__[a-z0-9]+(?:-[a-z0-9]+)*$/.test(params.name) || !validName.test(params.name)) {
        throw new Error('작업 이름은 26-10-08__01__improve-login 형식이며 전체 64자 이하여야 합니다.');
      }
      const prefix = nextNamePrefix(draftingRoot);
      if (!params.name.startsWith(prefix)) throw new Error(`현재 날짜·다음 작업 번호는 ${prefix} 입니다. 이름을 다시 제안하세요.`);
      if (params.title !== undefined && (!params.title.trim() || /[\r\n]/.test(params.title))) throw new Error('작업 제목은 비어 있지 않은 한 줄로 쓰세요.');
      for (const field of ['goal', 'scope', 'nonGoals', 'acceptance', 'decisions']) {
        if (typeof params[field] !== 'string' || !params[field].trim() || params[field].trim() === '작성 필요') {
          throw new Error(`${field} 내용을 사용자와 정리하세요.`);
        }
      }
      if (!Array.isArray(params.repos) || !params.repos.length || params.repos.some(r => !validName.test(r.name) || typeof r.ref !== 'string' || !r.ref || /\s/.test(r.ref) || r.ref.startsWith('-'))) {
        throw new Error('저장소 이름과 기준 ref를 확인하세요.');
      }
      const args = `${params.name} ${params.repos.map(r => `${r.name}=${r.ref}`).join(' ')}`;
      const brief = `## 목표\n\n${params.goal}\n\n## 범위\n\n${params.scope}\n\n## 하지 않을 일\n\n${params.nonGoals}\n\n## 완료 조건\n\n${params.acceptance}\n\n## 결정 사항\n\n${params.decisions}`;
      creating = true;
      try {
        if (signal?.aborted) throw new Error('작업 생성이 취소됐습니다.');
        const confirmed = await ctx.ui.confirm('이 작업으로 만들까요?', `${params.title ?? params.name}\n폴더: ${params.name}\n브랜치: ${params.branch ?? `work/${params.name}`}\n저장소: ${params.repos.map(r => `${r.name}=${r.ref}`).join(', ')}\n\n${brief}`);
        if (!confirmed || signal?.aborted) return { content: [{ type: 'text', text: '생성하지 않았습니다. 대화를 이어가며 초안을 수정할 수 있습니다.' }], details: { created: false } };
        const result = createWork(draftingRoot, args, brief, params.title?.trim(), params.branch);
        draftingRoot = undefined;
        const handoff = signal?.aborted ? result : await offerWorkTab(pi, ctx, params.name, result);
        return { content: [{ type: 'text', text: handoff }], details: { created: true } };
      } finally { creating = false; }
    },
  });
  for (const [name, description, run] of [
    ['work-init', '대화로 작업 정의·이름·저장소를 정한 뒤 생성. 아이디어를 덧붙여도 됩니다.', createWork],
    ['work-open', '기존 작업을 목록에서 골라 Tern 새 탭에서 시작. 작업명을 직접 지정해도 됩니다.', openWork],
  ]) {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        try {
          if (ctx.agent?.kind === 'sub') throw new Error('작업 준비·인계 명령은 부모 세션에서 실행하세요.');
          if (name === 'work-open' && !args.trim()) {
            if (!ctx.hasUI) throw new Error('대화형 omp 세션에서 실행하거나 /work-open 작업명으로 지정하세요.');
            const root = workspace(ctx.cwd);
            const work = path.join(root, 'work');
            const choices = exists(work) ? fs.readdirSync(directory(root, 'work'), { withFileTypes: true })
              .filter(entry => entry.isDirectory() && validName.test(entry.name))
              .filter(entry => {
                const task = path.join(work, entry.name, 'task.md');
                return exists(task) && fs.lstatSync(task).isFile();
              }).map(entry => entry.name).sort().reverse() : [];
            if (!choices.length) {
              ctx.ui.notify('기존 작업이 없습니다. /work-init으로 먼저 작업을 만드세요.', 'info');
              return;
            }
            const selected = await ctx.ui.select('새 탭에서 열 작업을 선택하세요.', choices);
            if (!choices.includes(selected)) return;
            args = selected;
          }
          if (name === 'work-init' && !/^\S+\s+\S+=\S+(?:\s+\S+=\S+)*$/.test(args.trim())) {
            const conversation = startWorkConversation(ctx.cwd, args);
            activateWorkspace(conversation.root);
            draftingRoot = conversation.root;
            pi.sendMessage({ customType: 'work-init', content: conversation.prompt, display: true }, { triggerTurn: true });
            return;
          }
          const result = run(ctx.cwd, args);
          const handoff = await offerWorkTab(pi, ctx, args.trim().split(/\s+/)[0], result, name === 'work-open');
          ctx.ui.setEditorText(handoff);
          ctx.ui.notify('새 탭 열기 결과 또는 실행 명령을 입력창에 표시했습니다.', 'info');
        } catch (error) { ctx.ui.notify(error.message, 'error'); }
      },
    });
  }
}
