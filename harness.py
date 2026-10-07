#!/usr/bin/env python3
"""Install a workspace-local WORK harness without changing global settings."""
import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile

RUNTIME = ('harness_common.py', 'work.py', 'work-hook.py', 'check-workspace', 'pr-guard.py')
SKILL = ('SKILL.md', 'LICENSE', 'references/workflows.md', 'references/principles.md',
         'references/upstream.md', 'references/workspace.md')
PAYLOAD = ('harness.py', 'templates/AGENTS.fragment.md') + tuple('runtime/' + p for p in RUNTIME) + tuple('skills/pstack-codex/' + p for p in SKILL)
HOOKS = '''applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit
prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge
pre-push pre-receive update proc-receive post-receive post-update
reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate
fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist
p4-pre-submit post-index-change'''.split()
EXCLUDES = ('/.harness/', '/.worktrees/', '/.codex/config.toml', '/.codex/hooks.json',
            '/.agents/skills/pstack-codex/', '/AGENTS.override.md')
BEGIN, END = '<!-- own-harness:begin -->', '<!-- own-harness:end -->'


def fail(message):
    raise ValueError(message)


def plain(path):
    path = Path(path)
    for part in (path, *path.parents):
        if part.is_symlink():
            fail('symlink path is not supported: ' + str(part))
    return path


def absolute(value):
    path = Path(value)
    if not path.is_absolute():
        fail('an absolute path is required: ' + str(path))
    plain(path)
    return Path(os.path.abspath(str(path)))


def run_git(repo, *args, optional=False):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')
           or k in {'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'}}
    env['GIT_NO_REPLACE_OBJECTS'] = '1'
    result = subprocess.run(['git', '-C', str(repo), *args], env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode and not (optional and result.returncode == 1):
        fail(result.stderr.strip() or 'Git command failed: ' + ' '.join(args))
    return result.stdout.rstrip('\n') if result.returncode == 0 else None


def values(repo, scope):
    output = run_git(repo, 'config', scope, '--null', '--get-all', 'core.hooksPath', optional=True)
    found = output.rstrip('\0').split('\0') if output is not None else []
    if len(found) > 1:
        fail('multiple ' + scope + ' core.hooksPath values: ' + str(repo))
    return found


def write_local(repo, vals):
    if values(repo, '--local'):
        run_git(repo, 'config', '--local', '--unset-all', 'core.hooksPath')
    for value in vals:
        run_git(repo, 'config', '--local', '--add', 'core.hooksPath', value)


def snapshot(path):
    plain(path)
    if not path.exists():
        return None
    if not path.is_file():
        fail('expected a regular file: ' + str(path))
    return {'data': base64.b64encode(path.read_bytes()).decode('ascii'),
            'mode': stat.S_IMODE(path.stat().st_mode)}


def content(state):
    return b'' if state is None else base64.b64decode(state['data'], validate=True)


def digest(state):
    if state is None:
        return None
    return {'sha256': hashlib.sha256(content(state)).hexdigest(), 'mode': state['mode']}


def encoded(data, mode):
    return {'data': base64.b64encode(data).decode('ascii'), 'mode': mode}


def replace(path, state, created):
    plain(path)
    if state is None:
        if path.exists():
            path.unlink()
        return
    absent = []
    parent = path.parent
    while not parent.exists():
        absent.append(parent)
        parent = parent.parent
    for directory in reversed(absent):
        directory.mkdir(mode=0o700)
        created.add(directory)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(path.parent), delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content(state))
        temporary.chmod(state['mode'])
        os.replace(str(temporary), str(path))
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def apply(changes, settings, verify=None):
    """Every preflight finishes before writes; a failed write rolls back this call."""
    before = {path: snapshot(path) for path in changes}
    old_settings = [(repo, values(repo, '--local')) for repo, _ in settings]
    done, git_done, created = [], [], set()
    try:
        for path, state in changes.items():
            if state != before[path]:
                done.append(path)
                replace(path, state, created)
        if verify:
            verify()
        for repo, vals in settings:
            git_done.append(repo)
            write_local(repo, vals)
    except BaseException as error:
        rollback_errors = []
        for repo, old in reversed(old_settings):
            if repo in git_done:
                try:
                    write_local(repo, old)
                except Exception as recovery:
                    rollback_errors.append(str(recovery))
        for path in reversed(done):
            try:
                replace(path, before[path], created)
            except Exception as recovery:
                rollback_errors.append(str(recovery))
        for directory in sorted(created, key=lambda p: len(p.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        if rollback_errors:
            raise RuntimeError(str(error) + '; rollback failed: ' + '; '.join(rollback_errors)) from error
        raise


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + '\n').encode()


def append_lines(text, lines):
    missing = [line for line in lines if line not in text.splitlines()]
    if not missing:
        return text
    newline = '\r\n' if '\r\n' in text else '\n'
    return text + (newline if text and not text.endswith('\n') else '') + newline.join(missing) + newline


def repo_map(raw):
    repos = {}
    for item in raw:
        name, separator, path = item.partition('=')
        if not separator or name in repos:
            fail('--repo must contain unique NAME=RELATIVE_PATH entries')
        repos[name] = path
    return repos or {'project': '.'}


def repositories(root, mapping):
    if not isinstance(mapping, dict) or not mapping:
        fail('repos must be a nonempty map')
    found, seen = {}, set()
    for name, relative in mapping.items():
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', name):
            fail('invalid repository name')
        if (not isinstance(relative, str) or not relative or Path(relative).is_absolute()
                or '..' in Path(relative).parts or any(p in {'.git', '.harness', '.worktrees'} for p in Path(relative).parts)):
            fail('repository paths must stay within the workspace')
        repo = absolute(root / relative)
        if not (repo / '.git').is_dir():
            fail('installation requires a baseline repository: ' + str(repo))
        common = absolute(run_git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
        top = absolute(run_git(repo, 'rev-parse', '--show-toplevel'))
        if top != repo or common != repo / '.git' or common in seen:
            fail('repository baseline/common directory is ambiguous: ' + str(repo))
        seen.add(common)
        fields = run_git(repo, 'worktree', 'list', '--porcelain', '-z').split('\0')
        trees = [absolute(p[9:]) for p in fields if p.startswith('worktree ')]
        if repo not in trees:
            fail('baseline is not a registered worktree')
        for tree in trees:
            if not tree.is_dir():
                fail('registered worktree is missing; prune it before installation: ' + str(tree))
            actual = absolute(run_git(tree, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
            if actual != common or absolute(run_git(tree, 'rev-parse', '--show-toplevel')) != tree:
                fail('registered worktree belongs to another repository: ' + str(tree))
        found[name] = {'path': repo, 'common': common, 'trees': trees}
    for parent in (root, *root.parents):
        if (parent / '.git').exists():
            if parent != root or not any(repo['path'] == root for repo in found.values()):
                fail('Git-owned workspace root must be a mapped baseline; nested workspace roots are unsupported')
            break
    return found


def check_tracked(repo):
    protected = ('.harness', '.worktrees', '.codex/config.toml', '.codex/hooks.json', '.agents/skills/pstack-codex', 'AGENTS.override.md')
    if run_git(repo, 'ls-files', '--', *protected):
        fail('tracked private/local configuration is not changed: ' + str(repo))


def load_manifest(root):
    path = root / '.harness/private/install.json'
    state = snapshot(path)
    if state is None:
        return None
    value = json.loads(content(state))
    if value.get('schema') != 1 or value.get('workspace') != str(root):
        fail('installation manifest belongs to another workspace')
    return value


def retired_checkouts(root, manifest, repos):
    current = {root, *(tree for repo in repos.values() for tree in repo['trees'])}
    retired = set()
    for value, name in manifest.get('checkouts', {}).items():
        tree = absolute(value)
        if name not in repos and tree != root:
            fail('stored checkout belongs to an unknown repository')
        if tree not in current:
            if tree.exists():
                fail('previously managed checkout is no longer registered: ' + str(tree))
            retired.add(tree)
    return retired


def within(path, directories):
    return any(path == folder or folder in path.parents for folder in directories)


def validate_manifest(root, manifest, repos):
    retired = retired_checkouts(root, manifest, repos)
    checkouts = {root, *(tree for repo in repos.values() for tree in repo['trees']), *retired}
    allowed = {root / '.harness' / rel for rel in PAYLOAD}
    allowed.add(root / '.harness/config.json')
    for name, repo in repos.items():
        folder = root / '.harness/private/hooks' / name
        allowed.update(folder / hook for hook in (*HOOKS, 'config.json'))
        allowed.add(repo['common'] / 'info/exclude')
    for tree in checkouts:
        allowed.update(tree / rel for rel in ('.codex/config.toml', '.codex/hooks.json', 'AGENTS.override.md'))
        allowed.update(tree / '.agents/skills/pstack-codex' / rel for rel in SKILL)
    allowed_directories = set()
    boundaries = checkouts | {repo['common'] for repo in repos.values()}
    for path in allowed:
        for parent in path.parents:
            if parent in boundaries:
                break
            allowed_directories.add(parent)
    if any(absolute(p) not in allowed_directories for p in manifest.get('directories', [])):
        fail('manifest directory is not installation-owned')
    for repo in repos.values():
        for tree in repo['trees']:
            check_tracked(tree)
    for path, entry in manifest['files'].items():
        actual = absolute(path)
        if actual not in allowed:
            fail('manifest path is no longer a managed path: ' + path)
        if not within(actual, retired) and digest(snapshot(actual)) != entry['installed']:
            fail('managed file drift; restore or reconcile before proceeding: ' + path)
        content(entry['original'])
    if set(manifest['git']) != set(repos):
        fail('repository mapping changed')
    for name, repo in repos.items():
        saved = manifest['git'][name]
        target = str(root / '.harness/private/hooks' / name)
        if saved['common_dir'] != str(repo['common']) or saved['target'] != target:
            fail('stored Git hook ownership does not match this repository')
        if values(repo['path'], '--local') != [target]:
            fail('core.hooksPath drift: ' + str(repo['path']))


def hook_settings(root, repos, manifest):
    saved, changes = {}, []
    for name, repo in repos.items():
        baseline, common = repo['path'], repo['common']
        target = str(root / '.harness/private/hooks' / name)
        local = values(baseline, '--local')
        current = run_git(baseline, 'config', '--get', 'core.hooksPath', optional=True)
        if manifest:
            record = manifest['git'][name]
        else:
            if current and '.harness/private/hooks/' in current:
                fail('existing harness hooks have no installation ownership record')
            record = {'common_dir': str(common), 'target': target, 'original_local': local,
                      'previous_path': run_git(baseline, 'config', '--path', '--get', 'core.hooksPath') if current is not None else str(common / 'hooks'),
                      'previous_configured_value': current, 'previous_configured': current is not None,
                      'previous_local_value': local[0] if local else None}
        extension = run_git(baseline, 'config', '--bool', '--get', 'extensions.worktreeConfig', optional=True)
        for tree in repo['trees']:
            if extension == 'true' and values(tree, '--worktree'):
                fail('worktree core.hooksPath override must be resolved first: ' + str(tree))
            effective = run_git(tree, 'config', '--get', 'core.hooksPath', optional=True)
            if effective != current:
                fail('per-checkout hooksPath configuration differs: ' + str(tree))
        if manifest and current != target:
            fail('effective core.hooksPath drift: ' + str(baseline))
        saved[name] = record
        changes.append((baseline, [target]))
    return saved, changes


def memory_config(text):
    # ponytail: 단순 테이블만 편집한다. 복잡한 TOML 지원이 필요하면 정식 파서를 사용한다.
    lines = text.splitlines(keepends=True)
    header = None
    key = None
    active = False
    section = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if '\"\"\"' in line or "'''" in line or re.search(r"[{}]", line):
            raise ValueError("복잡한 TOML(다중행 문자열/inline 표)은 자동 편집하지 않습니다")
        if stripped.startswith("["):
            if not re.fullmatch(r"\[\[?[\w. \t-]+\]\]?[ \t]*(?:#.*)?", stripped):
                raise ValueError("복잡한 TOML 표 이름은 자동 편집하지 않습니다")
            section = True
            active = bool(re.fullmatch(r"\[\s*memories\s*\]\s*(?:#.*)?", stripped))
            if "memories" in stripped.split("#", 1)[0] and not active:
                raise ValueError("memories의 quoted/dotted/array 표는 자동 편집하지 않습니다")
            if active:
                if header is not None:
                    raise ValueError("중복된 [memories] 표가 있습니다")
                header = index
            continue
        if "=" not in line:
            raise ValueError("다중행 TOML 값은 자동 편집하지 않습니다")
        if "=" in line:
            name, value = line.split("=", 1)
            if (active or not section) and not re.fullmatch(r"[ \t]*[\w-]+[ \t]*", name):
                raise ValueError("quoted/dotted TOML 키는 자동 편집하지 않습니다")
            if value.lstrip().startswith("[") and not re.fullmatch(r"\[[^\[\]#\r\n]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n)?", value.lstrip()):
                raise ValueError("복잡한 TOML 배열은 자동 편집하지 않습니다")
        if not section and re.match(r"[\"']?memories(?:[\"']|\s|\.|=)", stripped):
            raise ValueError("memories는 단순 [memories] 표로 작성해야 합니다")
        if active and re.match(r"[\"']?use_memories(?:[\"']|\s|\.|=)", stripped):
            match = re.fullmatch(r"([ \t]*use_memories[ \t]*=[ \t]*)(true|false)([ \t]*(?:#[^\r\n]*)?)(\r?\n)?", line)
            if not match or key is not None:
                raise ValueError("use_memories는 중복 없는 단순 boolean이어야 합니다")
            key = index
            lines[index] = match[1] + "false" + match[3] + (match[4] or "")
    if key is not None:
        return "".join(lines)
    newline = "\r\n" if "\r\n" in text else "\n"
    if header is not None:
        if not lines[header].endswith("\n"):
            lines[header] += newline
        lines.insert(header + 1, "use_memories = false" + newline)
        return "".join(lines)
    return text + (newline if text and not text.endswith("\n") else "") + (newline if text else "") + "[memories]" + newline + "use_memories = false" + newline



def hooks_config(data, root):
    value = json.loads(data) if data.strip() else {}
    if not isinstance(value, dict) or not isinstance(value.get('hooks', {}), dict):
        fail('Codex hooks.json must contain an object with a hooks object')
    hooks = value.setdefault('hooks', {})
    command = 'python3 ' + shlex.quote(str(root / '.harness/runtime/pr-guard.py')) + ' hook'
    for event in ('UserPromptSubmit', 'PreToolUse'):
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            fail('Codex hook event must contain a list: ' + event)
        for item in entries:
            if not isinstance(item, dict) or not isinstance(item.get('hooks'), list):
                fail('unsupported Codex hook entry: ' + event)
            for hook in item['hooks']:
                if not isinstance(hook, dict):
                    fail('unsupported Codex command hook')
                if 'pr-guard.py' in str(hook.get('command', '')) and '.harness' in str(hook.get('command', '')):
                    fail('unowned own-harness Codex hook already exists')
        entries.append({'hooks': [{'type': 'command', 'command': command, 'timeout': 30}]})
    return json_bytes(value)


def managed_agents(original, fragment, root):
    text = original.decode('utf-8')
    if BEGIN in text or END in text:
        fail('unowned own-harness AGENTS block already exists')
    body = fragment.decode('utf-8').replace('{{HARNESS_ROOT}}', str(root)).strip()
    return (text + ('\n' if text and not text.endswith('\n') else '') + ('\n' if text else '')
            + BEGIN + '\n' + body + '\n' + END + '\n').encode()


def invalidate_approvals(root, changes):
    folder = plain(root / '.harness/private/pr-approvals')
    if folder.exists():
        if not folder.is_dir():
            fail('PR approval state must be a directory')
        for path in folder.iterdir():
            if path.suffix not in {'.json', '.lock'} or snapshot(path) is None:
                fail('unexpected PR approval state entry: ' + str(path))
            if path.suffix == '.json':
                changes[path] = None


def build(root, source, mapping, manifest, selected=None):
    repos = repositories(root, mapping)
    if manifest:
        validate_manifest(root, manifest, repos)
    git_records, settings = hook_settings(root, repos, manifest)
    payload = {}
    for rel in PAYLOAD:
        state = snapshot(source / rel)
        if state is None:
            fail('distribution is missing an allowlisted file: ' + rel)
        payload[rel] = state
    targets = {root, *(tree for repo in repos.values() for tree in repo['trees'])}
    if selected is not None:
        if selected not in targets or selected == root and not any(root == repo['path'] for repo in repos.values()):
            fail('prepare requires a registered checkout in the configured repositories')
        targets = {selected}
    for repo in repos.values():
        for tree in repo['trees']:
            check_tracked(tree)
    retired = retired_checkouts(root, manifest, repos) if manifest else set()
    files = {p: copy.deepcopy(entry) for p, entry in manifest['files'].items()
             if not within(Path(p), retired)} if manifest else {}
    changes = {}

    def original(path):
        return files[str(path)]['original'] if str(path) in files else snapshot(path)

    def manage(path, data, mode=None, require_new=False):
        path = plain(path)
        if require_new and str(path) not in files and snapshot(path) is not None:
            fail('installation would replace an unowned file: ' + str(path))
        old = original(path)
        if mode is None:
            mode = old['mode'] if old is not None else 0o600
        state = encoded(data, mode)
        files[str(path)] = {'original': old, 'installed': digest(state)}
        changes[path] = state

    for rel, state in payload.items():
        manage(root / '.harness' / rel, content(state), state['mode'], require_new=True)
    manage(root / '.harness/config.json', json_bytes({'schema': 1, 'repos': mapping}), require_new=True)
    for name, repo in repos.items():
        folder = root / '.harness/private/hooks' / name
        record = git_records[name]
        config = {key: record[key] for key in ('common_dir', 'previous_path', 'previous_configured_value', 'previous_configured', 'previous_local_value')}
        config.update(version=1, workspace=str(root))
        manage(folder / 'config.json', json_bytes(config), require_new=True)
        for hook in HOOKS:
            command = '#!/bin/sh\nexec python3 ' + shlex.quote(str(root / '.harness/runtime/work-hook.py')) + ' ' + shlex.quote(str(folder / 'config.json')) + ' ' + shlex.quote(hook) + ' "$@"\n'
            manage(folder / hook, command.encode(), 0o755, require_new=True)
        exclude = repo['common'] / 'info/exclude'
        manage(exclude, append_lines(content(original(exclude)).decode('utf-8'), EXCLUDES).encode())
    for tree in targets:
        skill = plain(tree / '.agents/skills/pstack-codex')
        if skill.exists() and not any(str(skill / rel) in files for rel in SKILL):
            fail('an existing pstack-codex skill must be resolved before installation: ' + str(skill))
        for rel in SKILL:
            state = payload['skills/pstack-codex/' + rel]
            manage(skill / rel, content(state), state['mode'], require_new=True)
        config = tree / '.codex/config.toml'
        text = content(original(config)).decode('utf-8')
        if re.search(r'(?m)^\s*(?:\[\[?\s*["\x27]?hooks(?:[.\s\]"\x27])|["\x27]?hooks["\x27]?\s*=)', text):
            fail('inline Codex hooks in config.toml conflict with hooks.json; migrate them explicitly')
        manage(config, memory_config(text).encode('utf-8'))
        hook_file = tree / '.codex/hooks.json'
        manage(hook_file, hooks_config(content(original(hook_file)), root))
        agents = tree / 'AGENTS.override.md'
        manage(agents, managed_agents(content(original(agents)), content(payload['templates/AGENTS.fragment.md']), root))
    checkouts = {str(root): None}
    checkouts.update({str(tree): name for name, repo in repos.items() for tree in repo['trees']})
    result = {'schema': 1, 'workspace': str(root), 'repos': mapping, 'files': files,
              'git': git_records, 'checkouts': checkouts}
    manifest_path = root / '.harness/private/install.json'
    directories = {p for p in manifest.get('directories', []) if not within(Path(p), retired)} if manifest else set()
    for path in (*changes, manifest_path):
        for parent in path.parents:
            if parent.exists():
                break
            directories.add(str(parent))
    result['directories'] = sorted(directories)
    changes[manifest_path] = encoded(json_bytes(result), 0o600)

    def verify():
        for repo in repos.values():
            for tree in repo['trees']:
                for path in ('.harness/config.json', '.harness/private/work/probe/WORK.md',
                             '.harness/private/work-control/probe.json', '.harness/private/pr-approvals/probe.json',
                             '.worktrees/probe/file', '.codex/config.toml', '.codex/hooks.json',
                             '.agents/skills/pstack-codex/SKILL.md', 'AGENTS.override.md'):
                    if run_git(tree, 'check-ignore', '--no-index', '--', path, optional=True) is None:
                        fail('local path is not excluded by Git: ' + str(tree / path))
    return changes, settings, verify, result


def install(root, source, mapping=None, update=False, selected=None):
    root, source = absolute(root), absolute(source)
    if not root.is_dir():
        fail('workspace directory does not exist')
    manifest = load_manifest(root)
    if (update or selected is not None) and manifest is None:
        fail('workspace has no managed installation')
    if manifest:
        if mapping is not None and mapping != manifest['repos']:
            fail('repository mapping differs from the installed mapping')
        mapping = manifest['repos']
    else:
        mapping = mapping or {'project': '.'}
        folder = plain(root / '.harness')
        if folder.exists() and any(p.name != 'private' for p in folder.iterdir()):
            fail('existing .harness files have no installation ownership record')
        private = plain(folder / 'private')
        if private.exists() and any(p.name not in {'work', 'work-control', 'pr-approvals'} for p in private.iterdir()):
            fail('unowned .harness/private content must be resolved first')
    changes, settings, verify, result = build(root, source, mapping, manifest, selected)
    if manifest and not update and selected is None:
        for path, state in changes.items():
            if path != root / '.harness/private/install.json' and str(path) in manifest['files'] and digest(state) != manifest['files'][str(path)]['installed']:
                fail('package contents changed; use update')
    if selected is None:
        invalidate_approvals(root, changes)
    apply(changes, settings, verify)
    return {'status': 'prepared' if selected is not None else 'updated' if update else 'installed',
            'workspace': str(root), 'repositories': sorted(result['repos']),
            'codex': 'Project files installed; trust and actual hook events are unverified. Global hooks were preserved and may also run.'}


def uninstall(root):
    root = absolute(root)
    manifest = load_manifest(root)
    if manifest is None:
        fail('workspace has no managed installation')
    repos = repositories(root, manifest['repos'])
    validate_manifest(root, manifest, repos)
    hook_settings(root, repos, manifest)
    retired = retired_checkouts(root, manifest, repos)
    changes = {Path(path): entry['original'] for path, entry in manifest['files'].items()
               if not within(Path(path), retired)}
    invalidate_approvals(root, changes)
    retained = []
    private = root / '.harness/private'
    if any((private / name).exists() for name in ('work', 'work-control', 'pr-approvals')):
        retained.append('/.harness/')
    if (root / '.worktrees').exists():
        retained.append('/.worktrees/')
    if retained:
        for repo in repos.values():
            exclude = repo['common'] / 'info/exclude'
            state = changes[exclude]
            changes[exclude] = encoded(append_lines(content(state).decode(), retained).encode(), state['mode'] if state else 0o600)
    changes[root / '.harness/private/install.json'] = None
    settings = [(repo['path'], manifest['git'][name]['original_local']) for name, repo in repos.items()]
    apply(changes, settings)
    # Existing empty user directories are not installation-owned.
    for directory in sorted((Path(p) for p in manifest.get('directories', [])),
                            key=lambda p: len(p.parts), reverse=True):
        try:
            plain(directory).rmdir()
        except OSError:
            pass
    return {'status': 'uninstalled', 'workspace': str(root), 'retained_excludes': retained,
            'preserved': 'WORK, control state, user branches and worktrees'}


def doctor(root):
    root = absolute(root)
    manifest = load_manifest(root)
    if manifest is None:
        fail('workspace has no managed installation')
    repos = repositories(root, manifest['repos'])
    validate_manifest(root, manifest, repos)
    hook_settings(root, repos, manifest)
    missing = []
    unprepared = [str(tree) for repo in repos.values() for tree in repo['trees']
                  if str(tree / '.codex/hooks.json') not in manifest['files']]
    for name, repo in repos.items():
        record = manifest['git'][name]
        for tree in repo['trees']:
            previous = Path(record['previous_path'])
            if not previous.is_absolute():
                previous = tree / previous
            if record['previous_configured'] and not previous.is_dir():
                missing.append(str(previous))
    return {'status': 'ok' if not missing and not unprepared else 'needs-attention', 'workspace': str(root),
            'unprepared_checkouts': sorted(unprepared),
            'managed_files': len(manifest['files']), 'missing_original_hooks': sorted(set(missing)),
            'codex_trust': 'unverified', 'codex_event_delivery': 'unverified',
            'global_hooks': 'unchanged; project and global hooks may both run'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('install', 'update', 'uninstall', 'doctor', 'prepare'):
        sub = commands.add_parser(command)
        sub.add_argument('path', type=Path)
        if command == 'install':
            sub.add_argument('--repo', action='append', default=[])
    args = parser.parse_args()
    source = absolute(Path(__file__).absolute().parent)
    try:
        if sys.version_info < (3, 9):
            fail('Python 3.9 or newer is required')
        if args.command == 'install':
            result = install(args.path, source, repo_map(args.repo) if args.repo else None)
        elif args.command == 'update':
            result = install(args.path, source, update=True)
        elif args.command == 'prepare':
            if source.name != '.harness':
                fail('prepare must run through the installed .harness/harness.py')
            result = install(source.parent, source, selected=absolute(args.path))
        elif args.command == 'uninstall':
            result = uninstall(args.path)
        else:
            result = doctor(args.path)
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, 'harness: ' + str(error) + '\n')
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return int(result['status'] == 'needs-attention')


if __name__ == '__main__':
    sys.exit(main())
