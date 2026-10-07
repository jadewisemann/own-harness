"""Installed workspace paths and Git checks shared by the local runtime."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NAME_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z')
TASK_RE = re.compile(r'[a-z0-9][a-z0-9._-]{0,79}\Z')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(data).hexdigest()


def contained(path, parent=ROOT):
    return Path(path).resolve().is_relative_to(Path(parent).resolve())


def safe_path(root, *parts):
    root = Path(root).absolute()
    path = root.joinpath(*parts)
    require(contained(path, root) and '..' not in path.relative_to(root).parts, f'워크스페이스 밖 경로입니다: {path}')
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        require(not current.is_symlink(), f'관리 경로의 symlink는 허용하지 않습니다: {current}')
    return path


def git_environment():
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_') or key in ('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM')}
    env['GIT_NO_REPLACE_OBJECTS'] = '1'
    return env


def git(cwd, *args, optional=False, binary=False):
    result = subprocess.run(['git', '-C', str(cwd), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_environment())
    if result.returncode:
        if optional:
            return b'' if binary else ''
        raise ValueError(f'Git 검사 실패 ({args[0]}): {result.stderr.decode(errors="replace").strip()}')
    return result.stdout if binary else result.stdout.decode().strip()


def load_config(root=ROOT):
    expected = safe_path(root, '.harness', 'runtime', 'harness_common.py')
    require(Path(__file__).resolve() == expected, '실제 설치 위치의 runtime만 실행할 수 있습니다.')
    file = safe_path(root, '.harness', 'config.json')
    require(file.is_file(), '설치된 .harness/config.json이 없습니다. harness.py install을 먼저 실행하세요.')
    value = json.loads(file.read_text(encoding='utf-8'))
    require(isinstance(value, dict) and value.get('schema') == 1 and isinstance(value.get('repos'), dict) and value['repos'], 'config schema 또는 repos mapping이 잘못됐습니다.')
    seen = set()
    common_dirs = set()
    for name, relative in value['repos'].items():
        require(isinstance(name, str) and NAME_RE.fullmatch(name), '잘못된 저장소 이름입니다.')
        require(isinstance(relative, str) and relative and not Path(relative).is_absolute() and '..' not in Path(relative).parts, '저장소 경로는 workspace 안 상대 경로여야 합니다.')
        path = safe_path(root, relative)
        require(path.is_dir() and (path / '.git').exists(), f'baseline Git 저장소가 없습니다: {path}')
        require(Path(git(path, 'rev-parse', '--show-toplevel')).resolve() == path.resolve(), 'repo mapping은 실제 Git checkout 루트여야 합니다.')
        common = git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        require(path.resolve() not in seen and common not in common_dirs, '같은 저장소를 중복 등록할 수 없습니다.')
        seen.add(path.resolve())
        common_dirs.add(common)
    return value


def repo_paths(root=ROOT):
    return {name: safe_path(root, relative) for name, relative in load_config(root)['repos'].items()}


def checkout_info(cwd, task=None, root=ROOT, allow_baseline=False):
    raw = Path(cwd).absolute()
    require(raw.exists(), 'cwd는 실제 checkout 안이어야 합니다.')
    checkout = Path(git(raw, 'rev-parse', '--show-toplevel')).resolve()
    branch = git(checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD', optional=True)
    require(branch, 'detached HEAD에서는 작업을 등록할 수 없습니다.')
    repos = repo_paths(root)
    for repo, canonical in repos.items():
        if checkout == canonical.resolve():
            require(allow_baseline and task is None, 'baseline은 읽기 전용입니다. .worktrees/TASK/REPO를 사용하세요.')
            return None, repo, checkout, branch
    relative = checkout.relative_to(Path(root).resolve()).parts if contained(checkout, root) else checkout.parts[-3:]
    require(len(relative) == 3 and relative[0] == '.worktrees', 'baseline은 읽기 전용입니다. .worktrees/TASK/REPO를 사용하세요.')
    _, selected, repo = relative
    require(TASK_RE.fullmatch(selected), '잘못된 작업 ID입니다.')
    require(task is None or selected == task, 'worktree 폴더 작업 ID가 요청과 다릅니다.')
    require(repo in repos, 'config repos에 없는 저장소입니다.')
    canonical = repos[repo]
    require((checkout / '.git').is_file(), '실제 linked worktree가 필요합니다.')
    common = Path(git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve()
    expected = Path(git(canonical, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve()
    require(common == expected, 'worktree의 Git common-dir가 해당 baseline과 다릅니다.')
    registered = [Path(os.fsdecode(item[9:])).resolve() for item in git(canonical, 'worktree', 'list', '--porcelain', '-z', binary=True).split(b'\0') if item.startswith(b'worktree ')]
    require(checkout in registered, 'baseline Git에 등록되지 않은 worktree입니다.')
    if contained(checkout, root):
        safe_path(root, *relative)
    return selected, repo, checkout, branch


def policy_digest(root=ROOT):
    load_config(root)
    names = ('harness_common.py', 'work.py', 'work-hook.py', 'pr-guard.py', 'check-workspace')
    files = [safe_path(root, '.harness', 'config.json')]
    files += [safe_path(root, '.harness', 'runtime', name) for name in names]
    require(all(file.is_file() for file in files), '설치된 runtime 파일이 누락됐습니다.')
    return digest({str(file.relative_to(root)): digest(file.read_bytes()) for file in files})


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.is_symlink(), f'symlink에는 쓰지 않습니다: {path}')
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = stream.name
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def event_proof(event):
    require(isinstance(event, dict), 'hook event는 JSON 객체여야 합니다.')
    require(not event.get('agent_id') and not event.get('parent_session_id') and not os.environ.get('OWN_HARNESS_CHILD'), '하위 에이전트 이벤트는 승인과 작업 통제를 변경할 수 없습니다.')
    session, turn = event.get('session_id'), event.get('turn_id')
    require(isinstance(session, str) and session and isinstance(turn, str) and turn, '실제 UserPromptSubmit의 session_id와 turn_id가 필요합니다.')
    if event.get('hook_event_name') == 'UserPromptSubmit':
        require(isinstance(event.get('prompt'), str), '사용자 prompt는 문자열이어야 합니다.')
    require(not os.environ.get('CODEX_THREAD_ID') or os.environ['CODEX_THREAD_ID'] == session, '현재 Codex 세션과 사용자 이벤트 세션이 다릅니다.')
    return session, turn
