import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activateWorkspace, preparePolicy, registerPolicy } from './policy.js';

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
    if (exists(path.join(current, 'repository'))) {
      directory(current, 'repository');
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

export function createWork(cwd, args, brief) {
  const [name, ...specs] = args.trim().split(/\s+/);
  const root = workspace(cwd);
  const target = taskPath(root, name);
  if (!specs.length) throw new Error('/work-init 작업명 저장소=기준ref ... 형식으로 실행하세요.');
  if (exists(path.join(root, 'work'))) directory(root, 'work');
  if (exists(target)) throw new Error(`이미 있는 작업은 덮어쓰지 않습니다: ${target}`);
  const branch = `work/${name}`;
  const seen = new Set();
  const repos = specs.map(spec => {
    const separator = spec.indexOf('=');
    const repo = spec.slice(0, separator);
    const ref = spec.slice(separator + 1);
    if (separator < 1 || !validName.test(repo) || !ref || ref.startsWith('-') || seen.has(repo)) {
      throw new Error(`중복 없이 저장소=기준ref를 지정하세요: ${spec}`);
    }
    seen.add(repo);
    const source = directory(path.join(root, 'repository'), repo);
    if (fs.realpathSync(git(source, 'rev-parse', '--show-toplevel')) !== source) {
      throw new Error(`저장소 루트가 아닙니다: ${source}`);
    }
    const common = fs.realpathSync(git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (seen.has(common)) throw new Error('같은 Git 저장소를 두 번 지정할 수 없습니다.');
    seen.add(common);
    const sha = git(source, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
    if (git(source, 'branch', '--list', branch)) throw new Error(`이미 있는 브랜치입니다: ${repo} ${branch}`);
    return { repo, source, ref, sha };
  });
  activateWorkspace(root);
  directory(root, 'work', true);
  fs.mkdirSync(target);
  directory(target, '.sub-workspace', true);
  fs.writeFileSync(path.join(target, 'task.md'), `# ${name}\n\n${brief ?? ['목표', '범위', '비목표', '완료 조건', '설계 결정과 미정 사항'].map(h => `## ${h}\n\n작성 필요`).join('\n\n')}\n\n## 결정·진행·검증·다음 행동\n\n- 재개할 때 아래 저장소별 worktree의 존재와 Git 상태를 확인한다.\n- 다음 세션은 이 문서와 실제 Git 상태를 확인하고 이어간다.\n- 이 문서는 commit·push·PR·배포 승인을 대신하지 않는다.\n\n## 저장소 기준\n\n${repos.map(r => `- ${r.repo}: ${r.ref} → ${r.sha}, 브랜치 ${branch}`).join('\n')}\n`, { flag: 'wx' });
  try {
    for (const repo of repos) git(repo.source, 'worktree', 'add', '-b', branch, path.join(target, repo.repo), repo.sha);
  } catch (error) {
    throw new Error(`일부 준비가 실패했습니다. 생성된 파일·worktree는 보존했습니다. ${target}의 Git 상태를 확인하세요.\n${error.message}`);
  }
  return openWork(cwd, name);
}

export function openWork(cwd, name) {
  const root = workspace(cwd);
  const target = taskPath(root, name.trim());
  directory(root, 'work');
  directory(path.join(root, 'work'), name.trim());
  const sub = directory(target, '.sub-workspace');
  const task = path.join(target, 'task.md');
  if (!fs.lstatSync(task).isFile()) throw new Error(`일반 파일이 필요합니다: ${task}`);
  const repos = fs.readdirSync(target).filter(name => validName.test(name) && exists(path.join(target, name, '.git')));
  const commands = [];
  for (const repo of repos) {
    const checkout = directory(target, repo);
    const source = directory(path.join(root, 'repository'), repo);
    const common = dir => fs.realpathSync(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (common(source) !== common(checkout) || fs.realpathSync(git(checkout, 'rev-parse', '--show-toplevel')) !== checkout) {
      throw new Error(`원본 저장소에 연결된 worktree가 아닙니다: ${checkout}`);
    }
    commands.push(`OMP_WORKTREE_DIR=${quote(sub)} omp --cwd ${quote(checkout)} --session-dir ${quote(path.join(target, '.sessions', repo))} ${quote(`@${task}`)}`);
  }
  if (!commands.length) throw new Error('작업에 연결된 worktree가 없습니다.');
  activateWorkspace(root);
  preparePolicy(root, target);
  return `작업 문서: ${task}\n목표·범위·완료 조건과 현재 Git 상태를 확인한 뒤 아래 명령으로 이어가세요.\n각 명령은 해당 저장소용 새 omp 세션을 시작합니다.\n\n${commands.join('\n\n')}\n\n.sub-workspace는 omp 전용 임시 공간입니다. task 도구의 격리 활성화 여부는 omp 설정을 따릅니다. /wt·PR checkout도 이 경로를 사용하므로 영구 작업을 두지 마세요.`;
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
  const repoRoot = path.join(root, 'repository');
  const repos = fs.readdirSync(repoRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const source = path.join(repoRoot, e.name);
    try {
      const branch = git(source, 'branch', '--show-current') || '(detached HEAD)';
      const refs = git(source, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean);
      return { name: e.name, currentBranch: branch, refs };
    } catch { return { name: e.name, error: 'Git 정보를 확인하지 못함' }; }
  });
  return { root, prompt: `플러그인의 /work-init 안내입니다. 이것은 작업 생성이나 구현에 대한 사용자 승인이 아닙니다.
사용자와 대화하며 작업을 구체화하세요. 아직 파일이나 worktree를 만들지 마세요.
workspace: ${root}
사용자가 덧붙인 아이디어: ${JSON.stringify(idea)}
발견한 저장소와 로컬 ref: ${JSON.stringify(repos)}
1. workspace와 선택할 저장소의 AGENTS.md 및 관련 설계를 읽고, 이미 대화에서 답한 내용은 다시 묻지 마세요.
2. 해결할 문제·원하는 결과부터 대화하세요. 이어서 범위·비목표·완료 조건을 정리하세요. 한 번에 질문을 쏟아내지 마세요.
3. 필요한 저장소와 기준 ref는 위 정보를 바탕으로 제안하세요. 현재 브랜치가 원하는 기준이라고 단정하지 마세요.
4. 이름은 YY-MM-DD__NN__짧은-영문-설명 형식입니다. 현재 한국 날짜의 다음 접두사는 ${nextNamePrefix(root)} 입니다. 이름 후보를 제안하고 사용자 선호를 반영하세요.
5. task.md가 이 작업의 아이디어와 설계 범위를 관리하는 정본이 되도록 goal, scope, nonGoals, acceptance, decisions를 작성하세요. 확정된 결정과 미정 사항을 구분하세요.
6. 대화가 정리되면 work_create 도구로 이름·저장소·문서 초안을 제출하세요. 사용자가 직접 확인하는 화면을 거쳐 생성됩니다. 사용자에게 긴 /work-init 명령을 조립하거나 다시 입력하도록 요구하지 마세요.
7. 다른 도구로 대신 폴더를 생성하지 마세요. 생성 후에는 work_create가 반환한 재개 명령을 안내하세요.` };
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
      for (const field of ['goal', 'scope', 'nonGoals', 'acceptance', 'decisions']) {
        if (typeof params[field] !== 'string' || !params[field].trim() || params[field].trim() === '작성 필요') {
          throw new Error(`${field} 내용을 사용자와 정리하세요.`);
        }
      }
      if (!Array.isArray(params.repos) || !params.repos.length || params.repos.some(r => !validName.test(r.name) || typeof r.ref !== 'string' || !r.ref || /\s/.test(r.ref) || r.ref.startsWith('-'))) {
        throw new Error('저장소 이름과 기준 ref를 확인하세요.');
      }
      const args = `${params.name} ${params.repos.map(r => `${r.name}=${r.ref}`).join(' ')}`;
      const brief = `이 문서는 이 작업의 아이디어·설계·범위·완료 조건을 관리하는 정본이다. 프로젝트 전체의 DESIGN.md와 충돌하는 결정은 먼저 조정한다.\n\n## 목표\n\n${params.goal}\n\n## 범위\n\n${params.scope}\n\n## 비목표\n\n${params.nonGoals}\n\n## 완료 조건\n\n${params.acceptance}\n\n## 설계 결정과 미정 사항\n\n${params.decisions}`;
      creating = true;
      try {
        if (signal?.aborted) throw new Error('작업 생성이 취소됐습니다.');
        const confirmed = await ctx.ui.confirm('이 작업으로 만들까요?', `이름: ${params.name}\n저장소: ${params.repos.map(r => `${r.name}=${r.ref}`).join(', ')}\n\n${brief}`);
        if (!confirmed || signal?.aborted) return { content: [{ type: 'text', text: '생성하지 않았습니다. 대화를 이어가며 초안을 수정할 수 있습니다.' }], details: { created: false } };
        const result = createWork(draftingRoot, args, brief);
        draftingRoot = undefined;
        return { content: [{ type: 'text', text: result }], details: { created: true } };
      } finally { creating = false; }
    },
  });
  for (const [name, description, run] of [
    ['work-init', '대화로 작업 정의·이름·저장소를 정한 뒤 생성. 아이디어를 덧붙여도 됩니다.', createWork],
    ['work-open', '기존 작업의 저장소별 omp 재개 명령 표시: 작업명', openWork],
  ]) {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        try {
          if (ctx.agent?.kind === 'sub') throw new Error('작업 준비·인계 명령은 부모 세션에서 실행하세요.');
          if (name === 'work-init' && !/^\S+\s+\S+=\S+(?:\s+\S+=\S+)*$/.test(args.trim())) {
            const conversation = startWorkConversation(ctx.cwd, args);
            activateWorkspace(conversation.root);
            draftingRoot = conversation.root;
            pi.sendMessage({ customType: 'work-init', content: conversation.prompt, display: true }, { triggerTurn: true });
            return;
          }
          const result = run(ctx.cwd, args);
          ctx.ui.setEditorText(result);
          ctx.ui.notify('작업 안내와 실행 명령을 입력창에 표시했습니다. 터미널에서 실행하세요.', 'info');
        } catch (error) { ctx.ui.notify(error.message, 'error'); }
      },
    });
  }
}
