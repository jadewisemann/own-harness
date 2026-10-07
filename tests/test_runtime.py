#!/usr/bin/env python3
"""Offline integration regression using copied runtime and temporary Git only."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parents[1] / 'runtime'
COUNT = 0


def run(cwd, *args, ok=True, data=None, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, input=data, capture_output=True, text=True)
    assert (result.returncode == 0) == ok, (args, result.stdout, result.stderr)
    return result.stdout.strip()


def git(cwd, *args):
    return run(cwd, 'git', *args)


def reject(fn, message=''):
    try:
        fn()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError('A rejected operation succeeded')


def passed(label):
    global COUNT
    COUNT += 1
    print(f'PASS {COUNT:02d} {label}', file=sys.__stdout__)


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def repository(path):
    path.mkdir(parents=True, exist_ok=True)
    git(path, 'init', '-b', 'main')
    git(path, 'config', 'user.name', 'Runtime Test')
    git(path, 'config', 'user.email', 'runtime@example.invalid')
    git(path, 'config', 'commit.gpgSign', 'false')
    git(path, 'config', 'core.hooksPath', '/dev/null')
    (path / '.gitignore').write_text('.harness/\n.worktrees/\n.codex/\napi/\n')
    (path / 'a.txt').write_text('initial\n')
    git(path, 'add', '.')
    git(path, 'commit', '-m', 'test: initial')


def main():
    for key in list(os.environ):
        if key.startswith('GIT_') or key == 'OWN_HARNESS_CHILD':
            os.environ.pop(key)
    os.environ.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null', GIT_CONFIG_NOSYSTEM='1', CODEX_THREAD_ID='runtime-fixture', PYTHONDONTWRITEBYTECODE='1')
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix='own-harness-') as directory, contextlib.redirect_stdout(io.StringIO()):
        root = Path(directory).resolve() / '공백 workspace'
        repository(root)
        repository(root / 'api')
        runtime = root / '.harness/runtime'
        shutil.copytree(SOURCE, runtime)
        config = root / '.harness/config.json'
        config.write_text(json.dumps({'schema': 1, 'repos': {'project': '.', 'workspace': 'api'}}))
        prepare = root / '.harness/harness.py'
        prepare.write_text('import sys,pathlib\nassert sys.argv[1]=="prepare"\np=pathlib.Path(sys.argv[2])/".codex/config.toml"\np.parent.mkdir(exist_ok=True)\np.write_text("[memories]\\nuse_memories = false\\n")\n')
        sys.path.insert(0, str(runtime))
        w = module('fixture_work', runtime / 'work.py')
        pr = module('fixture_pr', runtime / 'pr-guard.py')
        c = w.common
        alternative = root / 'package/runtime'
        shutil.copytree(runtime, alternative)
        copied = module('copied_common', alternative / 'harness_common.py')
        reject(copied.load_config, '실제 설치 위치')
        shutil.rmtree(root / 'package')

        def task(name, repo='project', scopes=None, external=None):
            if external:
                target = external / '.worktrees' / name / repo
                target.parent.mkdir(parents=True)
                git(c.repo_paths()[repo], 'worktree', 'add', '-b', name, str(target), 'main')
                w.init(name, str(target), 'main', scopes or [])
            elif scopes:
                target = root / '.worktrees' / name / repo
                target.parent.mkdir(parents=True)
                git(c.repo_paths()[repo], 'worktree', 'add', '-b', name, str(target), 'main')
                w.init(name, str(target), 'main', scopes)
            else:
                w.start(name, repo, 'main', name)
                target = root / '.worktrees' / name / repo
            file = w.work_path(name)
            file.write_text(file.read_text().replace('목표: 작성 필요', '목표: 경로와 승인을 검증한다').replace('범위: 작성 필요', '범위: 등록된 파일과 검사').replace('완료 조건: 작성 필요', '완료 조건: 회귀 검사 통과'))
            return target

        def phases(name, through='verification'):
            for phase in w.PHASES:
                w.record(name, phase, phase + ': 실제 경로와 결과 검사', 'independent' if phase == 'verification' else None)
                if phase == through:
                    break

        def event(prompt, turn='fixture-turn', **extra):
            return {'hook_event_name': 'UserPromptSubmit', 'session_id': 'runtime-fixture', 'turn_id': turn, 'cwd': str(root), 'prompt': prompt, **extra}

        for baseline in (root, root / 'api'):
            reject(lambda: w.check(str(baseline)), 'baseline')
        tree = task('sample')
        w.start('sample', 'project', 'main', 'sample')
        assert (tree / '.codex/config.toml').read_text() == '[memories]\nuse_memories = false\n'
        w.check(str(tree))
        reject(lambda: w.record('sample', 'implementation', '구현 결과'), 'research')
        phases('sample')
        w.check(str(tree), True)
        passed('single repository, non-ASCII path, safe start/reuse and stage order')

        (tree / 'a.txt').write_text('changed\n')
        reject(lambda: w.check(str(tree), True), '검증 뒤 바뀌었습니다')
        w.snapshot('sample')
        reject(lambda: w.check(str(tree), True), '검증 뒤 바뀌었습니다')
        w.record('sample', 'verification', '변경된 내용 재검증', 'independent')
        reject(lambda: w.check(str(tree), True), 'index와 작업 내용')
        git(tree, 'add', 'a.txt')
        w.record('sample', 'verification', 'index 변경 재검증', 'independent')
        w.check(str(tree), True)
        git(tree, 'commit', '-m', 'test: change')
        reject(lambda: w.check(str(tree), True), '검증 뒤 바뀌었습니다')
        w.record('sample', 'verification', 'commit 뒤 재검증', 'independent')
        passed('content, index and HEAD changes invalidate evidence; snapshot cannot renew it')

        index = git(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
        os.environ.update(GIT_INDEX_FILE=index + '.temporary', GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.bare', GIT_CONFIG_VALUE_0='true')
        reject(lambda: w.check(str(tree), True), '임시 Git index')
        assert c.git(tree, 'rev-parse', '--is-bare-repository') == 'false'
        for key in ('GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'):
            os.environ.pop(key)
        old_config = config.read_text()
        config.write_text(old_config + '\n')
        reject(lambda: w.check(str(tree), True), '계약이 바뀌었습니다')
        config.write_text(old_config)
        engine = runtime / 'work.py'
        old_engine = engine.read_text()
        engine.write_text(old_engine + '\n# policy change\n')
        reject(lambda: w.check(str(tree), True), '계약이 바뀌었습니다')
        engine.write_text(old_engine)
        w.check(str(tree), True)
        passed('temporary index and Git config injection reject; config/runtime policy changes stale evidence')

        second = task('multi', 'workspace')
        first = task('multi')
        phases('multi')
        w.check(str(first), True)
        (second / 'a.txt').write_text('other repository change')
        reject(lambda: w.check(str(first), True), '검증 뒤 바뀌었습니다')
        external = task('external', external=Path(directory) / '외부 위치')
        phases('external')
        w.check(str(external), True)
        reject(lambda: w.init('wrong', str(tree), 'main', []), '작업 ID')
        duplicate = {'schema': 1, 'repos': {'one': '.', 'two': '.'}}
        config.write_text(json.dumps(duplicate))
        reject(c.load_config, '중복')
        config.write_text(old_config)
        passed('repo names have no special meaning, multi-repo invalidation, external registered worktree')

        human = task('human')
        control_event = event('작업 통제 human')
        w.hook(control_event)
        held = w.control_path('human').read_bytes()
        assert w.hook(control_event) == {} and w.control_path('human').read_bytes() == held
        phases('human', 'design')
        reject(lambda: w.record('human', 'implementation', '구현 결과'), '사용자 통제')
        w.decision('human')
        code = w.read_control('human')['proposal']['code']
        approve = event('작업 승인 human ' + code, 'approval-turn')
        for bad in (dict(approve, turn_id=None), dict(approve, agent_id='child'), dict(approve, session_id='other')):
            assert '적용하지 못했습니다' in str(w.hook(bad))
        w.hook(approve)
        state = w.control_path('human').read_bytes()
        assert w.hook(approve) == {} and state == w.control_path('human').read_bytes()
        phases('human')
        w.check(str(human), True)
        config.write_text(old_config + '\n')
        reject(lambda: w.check(str(human), True), '사용자 통제')
        assert w.read_control('human')['mode'] == 'human'
        config.write_text(old_config)
        passed('human control, root event proof, duplicate events and policy approval invalidation')

        scoped = task('scope', scopes=['a.txt'])
        (scoped / 'outside.txt').write_text('outside scope')
        git(scoped, 'add', 'outside.txt')
        git(scoped, 'commit', '-m', 'test: outside scope')
        git(scoped, 'rm', 'outside.txt')
        git(scoped, 'commit', '-m', 'test: remove outside scope')
        phases('scope')
        reject(lambda: w.check(str(scoped), True), 'scope 밖 커밋')
        actual = git(scoped, 'rev-parse', 'HEAD')
        git(scoped, 'replace', actual, 'main')
        reject(lambda: w.check(str(scoped), True), 'scope 밖 커밋')
        passed('fixed base scope covers removed history and ignores replacement refs')

        bin_dir = Path(directory) / 'bin'
        bin_dir.mkdir()
        sent = Path(directory) / 'sent.json'
        gh = bin_dir / 'gh'
        gh.write_text('#!/usr/bin/env python3\nimport json,os,pathlib,sys\na=sys.argv[1:]\nif a[0]=="api": print(os.environ.get("FIXTURE_PRIVATE","false")); sys.exit(0)\nassert a[:2]==["pr","create"]\np=pathlib.Path(os.environ["FIXTURE_SENT"])\np.write_text(json.dumps({"args":a,"body":pathlib.Path(a[a.index("--body-file")+1]).read_text()}))\nprint("https://github.com/example/project/pull/1")\n')
        gh.chmod(0o755)
        os.environ.update(PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], FIXTURE_SENT=str(sent))
        git(tree, 'remote', 'add', 'origin', 'https://github.com/example/project.git')
        document = Path(directory) / 'PR.md'
        document.write_text('# PR.md\n\n## 제목\nfix: literal $(text) and `code`\n\n## 본문\n수정과 검증 결과를 기록했습니다.\n')
        pr.review(str(document), str(tree), 'main')
        state_file = pr.state_path('runtime-fixture')
        approval = event('PR 승인 ' + pr.load(state_file)['token'], 'pr-approval')
        for bad in (dict(approval, agent_id='child'), dict(approval, parent_session_id='parent'), dict(approval, turn_id=None), dict(approval, session_id=None)):
            reject(lambda: pr.hook(bad))
            assert not pr.load(state_file)['approved']
        pr.hook(approval)
        state = state_file.read_bytes()
        pr.hook(approval)
        assert state_file.read_bytes() == state
        command = 'python3 ' + shlex.quote(str(runtime / 'pr-guard.py')) + ' create'
        tool_event = {'hook_event_name': 'PreToolUse', 'session_id': 'runtime-fixture', 'turn_id': 'pr-approval', 'tool_name': 'exec_command', 'tool_input': {'cmd': command}}
        for bad in (dict(tool_event, agent_id='child'), dict(tool_event, turn_id=None), dict(tool_event, turn_id='next-turn')):
            reject(lambda: pr.hook(bad))
        pr.hook({'hook_event_name': 'PreToolUse', 'session_id': 'runtime-fixture', 'turn_id': 'pr-approval', 'tool_name': 'exec_command', 'tool_input': {'cmd': command}})
        pr.create()
        assert '--draft' in json.loads(sent.read_text())['args']
        reject(pr.create, '승인')
        passed('PR child/missing turn/session reject, duplicate approval and one-time exact Draft create')

        pr.review(str(document), str(tree), 'main')
        pr.hook(event('PR 승인 ' + pr.load(state_file)['token'], 'pr-approval-2'))
        pr.hook(event('별도 요청입니다', 'other-turn'))
        reject(pr.create, '승인')
        pr.review(str(document), str(tree), 'main')
        pr.hook(event('PR 승인 ' + pr.load(state_file)['token'], 'pr-approval-3'))
        config.write_text(old_config + '\n')
        reject(pr.create)
        config.write_text(old_config)
        assert pr.load(state_file)['invalidated']
        for text in ('WORK.md', '<!-- own-harness-work:v1 -->', '.harness/private/records/key.json', 'contract_sha256: abc123', str(root / '.worktrees')):
            document.write_text('# PR.md\n## 제목\nfix: example\n## 본문\n' + text)
            reject(lambda: pr.read_document(document))
        passed('new user input/policy changes invalidate PR approval; private metadata rejected')

        previous = root / '.githooks'
        previous.mkdir()
        log = Path(directory) / 'hook-log'
        (previous / 'pre-commit').write_text('#!/bin/sh\nprintf "original\\n" >> "$FIXTURE_HOOK_LOG"\nexit 7\n')
        (previous / 'pre-commit').chmod(0o755)
        wrapper = root / '.harness/private/hooks/project'
        wrapper.mkdir(parents=True)
        hook_config = wrapper / 'config.json'
        hook_config.write_text(json.dumps({'workspace': str(root), 'common_dir': git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'previous_path': str(previous), 'previous_configured': True}))
        os.environ['FIXTURE_HOOK_LOG'] = str(log)
        result = subprocess.run([sys.executable, str(runtime / 'work-hook.py'), str(hook_config), 'pre-commit'], cwd=tree, capture_output=True, text=True)
        assert result.returncode == 7 and log.read_text() == 'original\n', result.stderr
        (previous / 'pre-commit').unlink()
        (previous / 'pre-commit').write_text('#!/bin/sh\nprintf "changed by original hook\\n" > a.txt\ngit add a.txt\n')
        (previous / 'pre-commit').chmod(0o755)
        wrapper_command = '#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(runtime / 'work-hook.py')) + ' ' + shlex.quote(str(hook_config)) + ' pre-commit "$@"\n'
        (wrapper / 'pre-commit').write_text(wrapper_command)
        (wrapper / 'pre-commit').chmod(0o755)
        git(tree, 'config', 'core.hooksPath', str(wrapper))
        before = git(tree, 'rev-parse', 'HEAD')
        rejected_commit = run(tree, 'git', 'commit', '--allow-empty', '-m', 'test: reject hook mutation', ok=False)
        assert git(tree, 'rev-parse', 'HEAD') == before
        assert (tree / 'a.txt').read_text() == 'changed by original hook\n'
        w.record('sample', 'verification', '원본 hook이 stage한 최종 내용 재검증', 'independent')
        git(tree, 'commit', '-m', 'test: verified hook mutation')
        w.record('sample', 'verification', 'commit 이후 HEAD 재검증', 'independent')
        git(tree, 'config', 'core.hooksPath', '/dev/null')
        (previous / 'pre-commit').unlink()
        (previous / 'pre-push').write_text('#!/bin/sh\nprintf "%s|%s|%s\\n" "$PWD" "$1" "$2" > "$FIXTURE_HOOK_LOG"\ncat >> "$FIXTURE_HOOK_LOG"\n')
        (previous / 'pre-push').chmod(0o755)
        sha = git(tree, 'rev-parse', 'HEAD')
        update = f'HEAD {sha} refs/heads/sample ' + '0' * 40 + '\n'
        run(tree, sys.executable, str(runtime / 'work-hook.py'), str(hook_config), 'pre-push', 'origin', '/ordinary/remote.git', data=update)
        assert log.read_text() == f'{tree}|origin|/ordinary/remote.git\n' + update
        identity_env = dict(os.environ, GIT_AUTHOR_EMAIL='other@example.invalid')
        run(tree, sys.executable, str(runtime / 'check-workspace'), 'pre-commit', env=identity_env, ok=False)
        passed('original hook failure/cwd/argv/stdin preserved; hook index mutation and identity override rejected')

        internal = tree / 'WORK.md'
        internal.write_text('internal record')
        git(tree, 'add', 'WORK.md')
        git(tree, 'commit', '-m', 'test: internal record')
        git(tree, 'rm', 'WORK.md')
        git(tree, 'commit', '-m', 'test: remove internal record')
        w.record('sample', 'verification', '내부 경로 이력 검사', 'independent')
        sha = git(tree, 'rev-parse', 'HEAD')
        update = f'HEAD {sha} refs/heads/sample ' + '0' * 40 + '\n'
        args = [sys.executable, str(runtime / 'work-hook.py'), str(hook_config), 'pre-push', 'origin']
        run(tree, *args, '/ordinary/remote.git', data=update, ok=False)
        run(tree, *args, 'https://github.com/example/public.git', data=update, ok=False)
        os.environ['FIXTURE_PRIVATE'] = 'true'
        run(tree, *args, 'https://github.com/example/private.git', data=update)
        run(tree, *args, 'https://other.example/project.git', data=update, ok=False)
        passed('internal deleted history requires private=true on the actual GitHub push URL')
    print(f'runtime: {COUNT} regression groups passed (temporary repositories and fake gh only)')


if __name__ == '__main__':
    main()
