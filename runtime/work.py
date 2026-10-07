#!/usr/bin/env python3
"""작업 계약, 단계 근거, Git 상태와 사용자 통제를 검사한다."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

import harness_common as common
from harness_common import require, digest, atomic_write, git

ROOT = Path(__file__).resolve().parents[2]
BEGIN, END = '<!-- own-harness-work:v1 -->', '<!-- /own-harness-work -->'
PHASES = ('research', 'design', 'implementation', 'verification')
TASK_RE = re.compile(r'[a-z0-9][a-z0-9._-]{0,79}\Z')
BLOCK = re.compile(re.escape(BEGIN) + r'\n```json\n(.*?)\n```\n' + re.escape(END), re.S)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='microseconds')


def task_name(task):
    require(isinstance(task, str) and TASK_RE.fullmatch(task) and task not in ('.', '..'), '작업 ID는 영문 소문자·숫자·점·밑줄·하이픈 1~80자여야 합니다.')
    return task


def contained(path, parent=None):
    return common.contained(path, parent or ROOT)


def safe_path(*parts):
    return common.safe_path(ROOT, *parts)


def work_path(task):
    return safe_path('.harness', 'private', 'work', task_name(task), 'WORK.md')


def control_path(task):
    return safe_path('.harness', 'private', 'work-control', task_name(task) + '.json')


@contextlib.contextmanager
def locked(task):
    path = control_path(task).with_suffix('.lock')
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.is_symlink(), '잠금 파일 symlink를 허용하지 않습니다.')
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def checkout_info(cwd, task=None):
    return common.checkout_info(cwd, task, ROOT)


def read_work(task):
    path = work_path(task)
    require(path.is_file(), f'작업 기록이 없습니다: {path}; work.py init을 먼저 실행하세요.')
    text = path.read_text(encoding='utf-8')
    matches = list(BLOCK.finditer(text))
    require(len(matches) == 1 and text.count(BEGIN) == 1 and text.count(END) == 1, 'WORK.md metadata 블록이 없거나 중복·손상됐습니다.')
    try:
        data = json.loads(matches[0][1])
    except json.JSONDecodeError as error:
        raise ValueError('WORK.md JSON metadata를 읽을 수 없습니다.') from error
    require(isinstance(data, dict) and data.get('task_id') == task and data.get('schema') == 1, 'WORK.md 작업 ID 또는 schema가 다릅니다.')
    require(data.get('control_mode') in ('pstack', 'human') and data.get('phase') in PHASES, 'WORK.md 제어 모드 또는 단계가 잘못됐습니다.')
    require(isinstance(data.get('repos'), dict) and data['repos'] and isinstance(data.get('phases'), dict), 'WORK.md repos/phases가 잘못됐습니다.')
    require(set(data['phases']).issubset(PHASES), '알 수 없는 단계가 있습니다.')
    return text, data


def body_of(text):
    return BLOCK.sub('', text).strip()


def contract(text):
    body = body_of(text)
    match = re.search(r'^## 작업 계약\s*\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    require(match, 'WORK.md에 ## 작업 계약과 목표·범위·완료 조건을 작성하세요.')
    value = match[1].strip()
    for label in ('목표', '범위', '완료 조건'):
        item = re.search(r'^\s*(?:-\s*)?' + re.escape(label) + r'\s*:\s*(\S.*)$', value, re.M)
        require(item and item[1].strip().lower() not in ('todo', 'tbd', '미정', '작성 필요'), f'작업 계약의 {label} 내용을 작성하세요.')
    return value


def contract_digest(text, data):
    repos = {name: {key: repo.get(key) for key in ('checkout', 'branch', 'base_ref', 'base_sha', 'scope')} for name, repo in data['repos'].items()}
    return digest({'contract': contract(text), 'repos': repos, 'policy': common.policy_digest(ROOT)})


def save_work(task, text, data):
    data['updated_at'] = now()
    block = BEGIN + '\n```json\n' + json.dumps(data, ensure_ascii=False, indent=2) + '\n```\n' + END
    atomic_write(work_path(task), BLOCK.sub(lambda _: block, text) if BEGIN in text else text.rstrip() + '\n\n' + block + '\n')


def read_control(task):
    path = control_path(task)
    if not path.exists():
        return {}
    value = json.loads(path.read_text())
    require(isinstance(value, dict) and value.get('task_id') == task and value.get('mode') in ('human', 'pstack'), 'runtime 작업 통제 기록이 손상됐습니다.')
    require(value.get('session_id') and value.get('turn_id') and value.get('event') == 'UserPromptSubmit', '작업 통제에 실제 사용자 이벤트 증빙이 없습니다.')
    return value


def save_control(task, value):
    atomic_write(control_path(task), json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def human_gate(task, text, data, approval_required=True):
    control = read_control(task)
    mode = control.get('mode', data['control_mode'])
    require(mode == data['control_mode'], 'WORK.md의 control_mode와 runtime 통제 상태가 다릅니다.')
    if mode == 'human' and approval_required:
        approval = control.get('approval', {})
        require(approval.get('contract_sha256') == contract_digest(text, data) and approval.get('session_id') == os.environ.get('CODEX_THREAD_ID') and approval.get('turn_id') and approval.get('event') == 'UserPromptSubmit', '사용자 통제 중입니다. work.py decision TASK 후 같은 채팅에서 작업 승인을 받으세요.')


def normalized_scopes(checkout, scopes):
    result = []
    for value in scopes:
        path = Path(value)
        require(value and not path.is_absolute() and '..' not in path.parts and not value.startswith('-'), 'scope는 checkout 안 상대 경로여야 합니다.')
        require(contained(checkout / path, checkout), 'scope symlink가 checkout 밖을 가리킵니다.')
        require('.git' not in path.parts, '.git은 작업 scope로 지정할 수 없습니다.')
        result.append(path.as_posix())
    return sorted(set(result))


def fingerprint(task, repo, entry):
    selected, actual_repo, checkout, branch = checkout_info(entry['checkout'], task)
    require(actual_repo == repo and str(checkout) == entry['checkout'], '등록된 checkout/repo가 실제 경로와 다릅니다.')
    require(branch == entry['branch'], '등록된 작업 branch가 바뀌었습니다. 새 작업 계약으로 등록하세요.')
    require(git(checkout, 'rev-parse', '--verify', entry['base_sha'] + '^{commit}') == entry['base_sha'], '고정된 base commit이 없습니다.')
    require(isinstance(entry.get('scope'), list) and all(isinstance(scope, str) for scope in entry['scope']), 'scope는 상대 경로 목록이어야 합니다.')
    scopes = normalized_scopes(checkout, entry['scope'])
    paths = scopes or ['.']
    index = git(checkout, 'ls-files', '--stage', '-z', '--', *paths, binary=True)
    tracked = git(checkout, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', *paths, binary=True)
    excluded = work_path(task)
    names = sorted(set(os.fsdecode(name) for name in tracked.split(b'\0') if name))
    contents = []
    for name in names:
        file = checkout / name
        if file.absolute() == excluded.absolute():
            continue
        if file.is_symlink():
            content = ['link', os.readlink(file)]
        elif file.is_file():
            content = ['file', bool(file.stat().st_mode & stat.S_IXUSR), digest(file.read_bytes())]
        elif file.is_dir():
            raise ValueError(f'중첩 저장소·submodule은 이 scope에서 지원하지 않습니다: {file}; 별도 작업 저장소로 등록하세요.')
        else:
            content = ['missing']
        contents.append([name, content])
    index_rows = [os.fsdecode(row) for row in index.split(b'\0') if row and (checkout / os.fsdecode(row.split(b'\t', 1)[1])).absolute() != excluded.absolute()]
    head = git(checkout, 'rev-parse', 'HEAD')
    dirty = bool(git(checkout, 'status', '--porcelain=v1', '--untracked-files=all'))
    return dict(checkout=str(checkout), branch=branch, head_sha=head, dirty=dirty, observed_at=now(), current_fingerprint=digest({'HEAD': head, 'index': index_rows, 'contents': contents, 'work_body': digest(body_of(work_path(task).read_text())) if work_path(task).exists() else None}))


def observe(task, data):
    require(data['repos'], '등록된 저장소가 없습니다.')
    for repo, entry in data['repos'].items():
        require(isinstance(entry, dict), '저장소 metadata가 잘못됐습니다.')
        for key in ('checkout', 'branch', 'base_ref', 'base_sha'):
            require(isinstance(entry.get(key), str) and entry[key], f'{repo}: {key}가 없습니다.')
        entry.update(fingerprint(task, repo, entry))


def validate_evidence(record):
    require(isinstance(record, dict) and isinstance(record.get('evidence'), str) and record['evidence'].strip(), '단계 근거가 없습니다.')
    expected = digest({key: value for key, value in record.items() if key != 'digest'})
    require(record.get('digest') == expected, '단계 근거가 기록 뒤 변경됐습니다. 해당 단계를 다시 record하세요.')
    if 'file' in record:
        file = Path(record['file'])
        require(file.is_file() and not file.is_symlink() and contained(file) and digest(file.read_bytes()) == record.get('file_sha256'), '단계 근거 파일이 바뀌었거나 없습니다.')


def validate_phases(text, data, delivery=False):
    contract_hash = contract_digest(text, data)
    previous = True
    recorded = [phase for phase in PHASES if phase in data['phases']]
    require(data['phase'] == (recorded[-1] if recorded else 'research'), 'phase와 단계 근거가 일치하지 않습니다.')
    for phase in PHASES:
        record = data['phases'].get(phase)
        if record is None:
            previous = False
            require(not delivery, f'{phase} 근거가 없습니다.')
            continue
        require(previous, '작업 단계 기록 순서가 잘못됐습니다.')
        validate_evidence(record)
        require(record.get('contract_sha256') == contract_hash, '작업 계약이 바뀌었습니다. research부터 근거를 다시 기록하세요.')
        if phase == 'verification':
            require(isinstance(record.get('reviewer'), str) and record['reviewer'].strip(), '독립 검토자와 실제 검사 결과 근거가 필요합니다.')
            require(record.get('body_sha256') == digest(body_of(text)), 'WORK.md 본문이 검증 뒤 바뀌었습니다. 검증 근거를 다시 기록하세요.')
            require(record.get('fingerprints') == {name: repo['current_fingerprint'] for name, repo in data['repos'].items()}, '코드·HEAD·index·untracked 내용이 검증 뒤 바뀌었습니다. snapshot은 재검증을 대신하지 않습니다.')
            require(all(repo.get('verified_fingerprint') == repo['current_fingerprint'] for repo in data['repos'].values()), '저장소의 검증 fingerprint가 현재와 다릅니다.')


def init(task, cwd, base, scopes):
    task_name(task)
    _, repo, checkout, branch = checkout_info(cwd, task)
    require(base and not base.startswith('-'), '유효한 base ref를 지정하세요.')
    base_sha = git(checkout, 'rev-parse', '--verify', base + '^{commit}')
    scopes = normalized_scopes(checkout, scopes)
    with locked(task):
        path = work_path(task)
        text = path.read_text() if path.exists() else f'# {task}\n\n## 작업 계약\n\n- 목표: 작성 필요\n- 범위: 작성 필요\n- 완료 조건: 작성 필요\n'
        if BEGIN in text or END in text:
            text, data = read_work(task)
        else:
            if not re.search(r'^## 작업 계약\s*$', text, re.M):
                text = text.rstrip() + '\n\n## 작업 계약\n\n- 목표: 작성 필요\n- 범위: 작성 필요\n- 완료 조건: 작성 필요\n'
            data = {'schema': 1, 'task_id': task, 'control_mode': 'pstack', 'phase': 'research', 'repos': {}, 'phases': {}}
        entry = {'checkout': str(checkout), 'branch': branch, 'base_ref': base, 'base_sha': base_sha, 'scope': scopes, 'verified_fingerprint': None}
        if repo in data['repos']:
            old = data['repos'][repo]
            require(all(old.get(key) == entry[key] for key in ('checkout', 'branch', 'base_ref', 'base_sha', 'scope')), '기존 작업 등록을 init으로 바꾸거나 초기화할 수 없습니다.')
        else:
            require(not data['phases'].get('verification'), '검증된 작업에 저장소를 추가하려면 verification을 지우지 말고 implementation을 다시 기록하세요.')
            data['repos'][repo] = entry
        observe(task, data)
        save_work(task, text, data)
    print(f'작업 등록: {task}/{repo} · {work_path(task)}')


def start(task, repo, base, branch):
    task_name(task)
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', repo), '잘못된 저장소 이름입니다.')
    require(branch and not branch.startswith('-'), '유효한 branch가 필요합니다.')
    repos = common.repo_paths(ROOT)
    require(repo in repos, 'config repos에 없는 저장소입니다.')
    canonical = repos[repo]
    require((canonical / '.git').exists(), 'baseline Git 저장소가 없습니다.')
    git(canonical, 'check-ref-format', '--branch', branch)
    require(base and not base.startswith('-'), '유효한 base ref가 필요합니다.')
    git(canonical, 'rev-parse', '--verify', base + '^{commit}')
    configure = safe_path('.harness', 'harness.py')
    require(configure.is_file(), '설치된 harness.py가 없어 작업 context를 적용할 수 없습니다.')
    target = safe_path('.worktrees', task, repo)
    if target.exists():
        _, actual_repo, _, actual_branch = checkout_info(target, task)
        require(actual_repo == repo and actual_branch == branch, '기존 worktree의 저장소·branch가 요청과 다릅니다.')
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        git(canonical, 'worktree', 'add', '-b', branch, str(target), base)
    subprocess.run([sys.executable, str(configure), 'prepare', str(target)], check=True)
    init(task, str(target), base, [])
    print(f'작업 checkout: {target}\nbaseline의 미완료 변경은 복사하지 않습니다.')


def snapshot(task):
    with locked(task):
        text, data = read_work(task)
        observe(task, data)
        save_work(task, text, data)
    print('Git 관찰값을 갱신했습니다. 검증 성공 기록은 갱신하지 않았습니다.')


def record(task, phase, evidence, reviewer=None):
    require(evidence.strip() and evidence.strip().lower() not in ('done', 'true', 'false', 'ok', 'pass', 'passed', '완료', '성공'), '실제 근거 경로나 검사 결과 내용을 작성하세요. 완료 표시만으로 기록할 수 없습니다.')
    with locked(task):
        text, data = read_work(task)
        contract_hash = contract_digest(text, data)
        human_gate(task, text, data, phase in ('implementation', 'verification'))
        index = PHASES.index(phase)
        for prior in PHASES[:index]:
            require(prior in data['phases'], f'{prior} 근거를 먼저 기록하세요.')
            validate_evidence(data['phases'][prior])
            require(data['phases'][prior]['contract_sha256'] == contract_hash, '작업 계약이 바뀌었습니다. research부터 다시 기록하세요.')
        observe(task, data)
        entry = {'evidence': evidence.strip(), 'recorded_at': now(), 'contract_sha256': contract_hash}
        if evidence.startswith('@'):
            file = Path(evidence[1:])
            if not file.is_absolute():
                file = ROOT / file
            require(file.is_file() and not file.is_symlink() and contained(file), '근거 @파일은 워크스페이스 안의 실제 파일이어야 합니다.')
            require(file.resolve() != work_path(task).resolve(), '자기 WORK.md는 저장 때 바뀌므로 @근거 파일로 사용할 수 없습니다. 본문 조사 결과를 TEXT로 기록하세요.')
            require(file.read_text(encoding='utf-8').strip(), '빈 근거 파일을 사용할 수 없습니다.')
            entry.update(file=str(file.resolve()), file_sha256=digest(file.read_bytes()))
        if phase == 'verification':
            require(reviewer and reviewer.strip(), 'verification에는 --reviewer로 독립 검토자를 지정하세요.')
            entry.update(reviewer=reviewer.strip(), body_sha256=digest(body_of(text)), fingerprints={name: repo['current_fingerprint'] for name, repo in data['repos'].items()})
            for repo in data['repos'].values():
                repo['verified_fingerprint'] = repo['current_fingerprint']
        else:
            for repo in data['repos'].values():
                repo['verified_fingerprint'] = None
        entry['digest'] = digest(entry)
        data['phases'] = {name: value for name, value in data['phases'].items() if PHASES.index(name) < index}
        data['phases'][phase] = entry
        data['phase'] = phase
        save_work(task, text, data)
    print(f'{phase} 근거를 기록했습니다. 입력된 보고를 보관하며 검사 명령을 직접 실행한 것은 아닙니다.')


def check(cwd, delivery=False):
    task, repo, checkout, _ = checkout_info(cwd)
    if delivery and os.environ.get('GIT_INDEX_FILE'):
        actual_index = Path(os.environ['GIT_INDEX_FILE']).resolve()
        expected_index = Path(git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).resolve()
        require(actual_index == expected_index, '임시 Git index 전달은 검증하지 않습니다. commit --only/--include/-a 대신 일반 index에 stage하고 다시 검증하세요.')
    with locked(task):
        text, data = read_work(task)
        require(repo in data['repos'] and data['repos'][repo].get('checkout') == str(checkout), '현재 checkout이 해당 WORK.md에 등록되지 않았습니다.')
        human_gate(task, text, data, delivery)
        observe(task, data)
        validate_phases(text, data, delivery)
        if delivery:
            for entry in data['repos'].values():
                checkout = Path(entry['checkout'])
                scopes = entry['scope']
                history = git(checkout, 'log', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', entry['base_sha'] + '..HEAD', '--', binary=True)
                for name in (os.fsdecode(value) for value in history.split(b'\0') if value):
                    require(not scopes or '.' in scopes or (checkout / name).absolute() == work_path(task).absolute() or any(name == scope or name.startswith(scope.rstrip('/') + '/') for scope in scopes), f'고정 base 이후 scope 밖 커밋 변경이 있습니다: {name}')
                staged = git(checkout, 'diff', '--cached', '--no-renames', '--name-only', '-z', binary=True)
                for name in (os.fsdecode(value) for value in staged.split(b'\0') if value):
                    if (checkout / name).absolute() == work_path(task).absolute():
                        require(git(checkout, 'show', ':' + name, binary=True) == work_path(task).read_bytes(), 'staged WORK.md가 현재 계약·검증 기록과 다릅니다. WORK.md만 다시 stage하세요.')
                    require(not scopes or '.' in scopes or (checkout / name).absolute() == work_path(task).absolute() or any(name == scope or name.startswith(scope.rstrip('/') + '/') for scope in scopes), f'scope 밖 staged 변경이 있습니다: {name}')
                untracked = git(checkout, 'ls-files', '--others', '--exclude-standard', '-z', '--', *(scopes or ['.']), binary=True)
                require(not any((checkout / os.fsdecode(name)).absolute() != work_path(task).absolute() for name in untracked.split(b'\0') if name), '전달 범위의 untracked 파일을 stage한 뒤 다시 검증하세요.')
                dirty = git(entry['checkout'], 'diff', '--name-only', '-z', '--', *(entry.get('scope') or ['.']), binary=True)
                # Delivery uses the actual index; unstaged edits to tracked files cannot hide behind working-tree evidence.
                require(not any((Path(entry['checkout']) / os.fsdecode(name)).absolute() != work_path(task).absolute() for name in dirty.split(b'\0') if name), '전달 전 tracked 파일의 index와 작업 내용이 다릅니다. 관련 변경을 stage한 뒤 다시 검증하세요.')
    print(f'작업 검사: {task} · {"delivery" if delivery else "check"} OK')


def decision(task):
    session = os.environ.get('CODEX_THREAD_ID')
    require(session, '작업 승인을 연결할 Codex 세션 ID가 없습니다.')
    with locked(task):
        text, data = read_work(task)
        control = read_control(task)
        require(control.get('mode') == 'human', '사용자가 먼저 작업 통제 TASK를 보내야 합니다.')
        code = secrets.token_hex(6)
        proposal = {'code': code, 'contract_sha256': contract_digest(text, data), 'session_id': session}
        control['proposal'] = proposal
        control.pop('approval', None)
        save_control(task, control)
    print(f'작업: {task}\n{contract(text)}\n저장소 계약: {json.dumps({name: {key: value for key, value in repo.items() if key in ("checkout", "branch", "base_ref", "base_sha", "scope")} for name, repo in data["repos"].items()}, ensure_ascii=False)}\n계약 SHA-256: {proposal["contract_sha256"]}\n작업 승인 {task} {code}')


def public_text(file):
    text = Path(file).read_text(encoding='utf-8')
    forbidden = [r'own-harness-work:v\d', r'\bWORK\.md\b', r'\.worktrees(?:/|\\)', re.escape(str(ROOT)), r'\.harness(?:/|\\)private(?:/|\\)', r'"(?:current_fingerprint|verified_fingerprint|contract_sha256|control_mode)"\s*:']
    require(not any(re.search(pattern, text) for pattern in forbidden), '외부 문서에 내부 WORK metadata 또는 로컬 워크스페이스/worktree 경로가 포함됐습니다.')
    print('외부 문서 검사: OK')


def hook(event):
    require(isinstance(event, dict), 'hook event는 JSON 객체여야 합니다.')
    kind = event.get('hook_event_name')
    if kind == 'PreToolUse':
        inputs = event.get('tool_input', {})
        value = json.dumps(inputs, ensure_ascii=False) if isinstance(inputs, dict) else str(inputs)
        if re.search(r'work\.py[\s"\']+hook\b', value) or ('.harness/private/work-control' in value and re.search(r'write|apply_patch|\>|tee\b|unlink|remove|rm\b', event.get('tool_name', '') + ' ' + value)):
            return {'decision': 'block', 'reason': '작업 통제 상태는 실제 UserPromptSubmit 훅만 변경할 수 있습니다. hook 직접 실행·승인 파일 변경은 허용하지 않습니다.'}
        return {}
    if kind != 'UserPromptSubmit':
        return {}
    prompt = event.get('prompt', '')
    if not isinstance(prompt, str) or not re.match(r'^작업 (통제|이양|승인)\b', prompt.strip()):
        return {}
    def output(message):
        return {'hookSpecificOutput': {'hookEventName': kind, 'additionalContext': message}}
    try:
        match = re.fullmatch(r'작업 (통제|이양|승인) ([a-z0-9][a-z0-9._-]{0,79})(?: ([a-f0-9]{12}))?', prompt.strip())
        require(match, '정확한 명령: 작업 통제 TASK / 작업 이양 TASK / 작업 승인 TASK CODE')
        action, task, code = match.groups()
        task_name(task)
        session, turn = common.event_proof(event)
        cwd = event.get('cwd')
        require(isinstance(cwd, str) and Path(cwd).is_absolute(), 'hook cwd는 절대 경로여야 합니다.')
        require((contained(Path(cwd)) and Path(cwd).exists()) or work_path(task).is_file(), '워크스페이스 범위 또는 명시한 기존 작업이 필요합니다.')
        with locked(task):
            text, data = read_work(task)
            control = read_control(task)
            event_key = digest({'session': session, 'turn': turn, 'prompt': prompt.strip()})
            if control.get('last_event') == event_key:
                return {}
            proof = {'task_id': task, 'session_id': session, 'turn_id': turn, 'event': kind, 'updated_at': now()}
            if action in ('통제', '이양'):
                require(code is None, '통제·이양에는 승인 코드를 붙이지 마세요.')
                control = dict(proof, mode='human' if action == '통제' else 'pstack')
                data['control_mode'] = control['mode']
            else:
                proposal = control.get('proposal', {})
                require(control.get('mode') == 'human' and code and proposal.get('code') == code and proposal.get('session_id') == session and proposal.get('contract_sha256') == contract_digest(text, data), '승인 코드·세션·작업 계약이 일치하지 않습니다. decision을 다시 실행하세요.')
                control['approval'] = dict(proof, contract_sha256=proposal['contract_sha256'])
                control.pop('proposal', None)
            control['last_event'] = event_key
            save_control(task, control)
            save_work(task, text, data)
        return output(f'{task}: ' + ('사용자 통제로 전환했습니다. 조사·설계 기록은 허용하며 계약 승인 전 구현·검증 기록과 전달 검사를 차단합니다.' if action == '통제' else 'pstack 진행으로 이양했습니다.' if action == '이양' else '현재 작업 계약 승인을 기록했습니다.'))
    except (ValueError, OSError, KeyError, TypeError) as error:
        return output(f'작업 명령을 적용하지 못했습니다: {error}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('init'); p.add_argument('task'); p.add_argument('--cwd', default=os.getcwd()); p.add_argument('--base', required=True); p.add_argument('--scope', action='append', default=[])
    p = commands.add_parser('start'); p.add_argument('task'); p.add_argument('--repo', required=True); p.add_argument('--base', required=True); p.add_argument('--branch', required=True)
    for command in ('snapshot', 'decision'):
        commands.add_parser(command).add_argument('task')
    p = commands.add_parser('record'); p.add_argument('task'); p.add_argument('phase', choices=PHASES); p.add_argument('--evidence', required=True); p.add_argument('--reviewer')
    p = commands.add_parser('check'); p.add_argument('--cwd', default=os.getcwd()); p.add_argument('--delivery', action='store_true')
    commands.add_parser('public-text').add_argument('file')
    commands.add_parser('hook')
    args = vars(parser.parse_args())
    command = args.pop('command')
    if command == 'init':
        args['scopes'] = args.pop('scope')
    try:
        common.load_config(ROOT)
        if command == 'hook':
            result = hook(json.load(sys.stdin))
            if result.get('decision') == 'block':
                print(result['reason'], file=sys.stderr)
                return 2
            print(json.dumps(result, ensure_ascii=False))
        else:
            globals()[command.replace('-', '_')](**args)
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f'work guard: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
