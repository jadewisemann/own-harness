#!/usr/bin/env python3
"""Temporary Git fixtures only: python3 tests/test_install.py."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('harness', SOURCE / 'harness.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def git(repo, *args, check=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def put(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    path.chmod(mode)


def tree_state(root):
    return {str(path.relative_to(root)): harness.snapshot(path)
            for path in root.rglob('*') if path.is_file() and '.git' not in path.parts}


class Installation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='own harness 한글 ')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / 'home'
        self.home.mkdir()
        self.env = patch.dict(os.environ, {'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home / '.config'),
                                           'PYTHONDONTWRITEBYTECODE': '1',
                                           'GIT_CONFIG_GLOBAL': str(self.home / '.gitconfig'),
                                           'GIT_CONFIG_SYSTEM': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.package = self.base / 'package'
        for relative in harness.PAYLOAD:
            actual = SOURCE / relative
            data = actual.read_bytes() if actual.is_file() else ('# fixture ' + relative + '\n').encode()
            put(self.package / relative, data, 0o755 if relative in ('harness.py', 'runtime/check-workspace') else 0o644)
        put(self.package / 'templates/AGENTS.fragment.md', 'Run `{{HARNESS_ROOT}}/.harness/runtime/work.py`.\n')
        put(self.package / 'not-distributed-private.txt', 'must not be copied')
        self.root = self.repo(self.base / 'workspace 공백')

    def repo(self, root):
        root.mkdir(parents=True)
        git(root, 'init', '-b', 'main')
        git(root, 'config', 'user.name', 'Fixture Author')
        git(root, 'config', 'user.email', 'fixture@example.invalid')
        put(root / 'code.txt', 'initial\n')
        git(root, 'add', 'code.txt')
        git(root, 'commit', '-m', 'initial')
        return root

    def install(self, root=None, **kwargs):
        return harness.install(root or self.root, self.package, **kwargs)

    def test_round_trip_and_update_preserve_first_values(self):
        old_hooks = {'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'echo fixture'}]}]}, 'other': 3}
        put(self.root / '.codex/hooks.json', json.dumps(old_hooks) + '\n', 0o640)
        put(self.root / '.codex/config.toml', '# keep\n[other]\nx = 1\n[memories]\nuse_memories = true # keep\n', 0o640)
        put(self.root / 'AGENTS.md', 'Existing tracked instructions.\n', 0o640)
        put(self.root / 'AGENTS.override.md', 'Existing local instructions.\n', 0o640)
        git(self.root, 'add', 'AGENTS.md')
        git(self.root, 'commit', '-m', 'instructions')
        (self.root / '.husky').mkdir()
        git(self.root, 'config', '--local', 'core.hooksPath', '.husky')
        before = tree_state(self.root)
        exclude = harness.snapshot(self.root / '.git/info/exclude')
        self.install()
        installed = tree_state(self.root)
        self.assertEqual(git(self.root, 'status', '--short').stdout, '')
        self.install()
        self.assertEqual(installed, tree_state(self.root))
        self.assertFalse((self.root / '.harness/not-distributed-private.txt').exists())
        self.assertEqual(harness.doctor(self.root)['status'], 'ok')
        put(self.package / 'runtime/work.py', '# fixture next revision\n')
        with self.assertRaisesRegex(ValueError, 'use update'):
            self.install()
        self.install(update=True)
        self.assertEqual(harness.load_manifest(self.root)['git']['project']['original_local'], ['.husky'])
        harness.uninstall(self.root)
        self.assertEqual(before, tree_state(self.root))
        self.assertEqual(exclude, harness.snapshot(self.root / '.git/info/exclude'))
        self.assertEqual(git(self.root, 'config', '--local', '--get', 'core.hooksPath').stdout.strip(), '.husky')

    def test_non_git_multi_repo_existing_worktree_and_prepare(self):
        root = self.base / 'multi root'
        api, web = self.repo(root / 'api'), self.repo(root / 'web')
        external = self.base / '.worktrees/old-task/service'
        external.parent.mkdir(parents=True)
        git(api, 'worktree', 'add', '-b', 'old-task', str(external))
        self.install(root, mapping={'service': 'api', 'web': 'web'})
        self.assertTrue((root / '.codex/hooks.json').is_file())
        self.assertTrue((external / '.agents/skills/pstack-codex/SKILL.md').is_file())
        fresh = root / '.worktrees/new-task/web'
        fresh.parent.mkdir(parents=True)
        git(web, 'worktree', 'add', '-b', 'new-task', str(fresh))
        self.assertEqual(harness.doctor(root)['unprepared_checkouts'], [str(fresh)])
        subprocess.run([sys.executable, str(root / '.harness/harness.py'), 'prepare', str(fresh)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertTrue((fresh / '.codex/config.toml').exists())
        self.assertEqual(harness.doctor(root)['status'], 'ok')
        harness.uninstall(root)
        self.assertTrue(external.exists())
        self.assertTrue(fresh.exists())
        self.assertFalse((external / '.codex').exists())
        self.assertFalse((fresh / '.codex').exists())

    def test_conflicts_have_no_partial_writes(self):
        for relative, data in (('.codex/config.toml', '[hooks]\nvalue = 1\n'),
                               ('.codex/config.toml', 'x = { a = 2 }\n'),
                               ('.codex/hooks.json', '[]'),
                               ('AGENTS.override.md', harness.BEGIN + '\n')):
            with self.subTest(relative=relative, data=data):
                put(self.root / relative, data)
                before = tree_state(self.root)
                with self.assertRaises(ValueError):
                    self.install()
                self.assertEqual(before, tree_state(self.root))
                self.assertFalse((self.root / '.harness').exists())
                (self.root / relative).unlink()
        put(self.root / '.agents/skills/pstack-codex/user.txt', 'existing skill')
        before = tree_state(self.root)
        with self.assertRaisesRegex(ValueError, 'existing pstack'):
            self.install()
        self.assertEqual(before, tree_state(self.root))

    def test_symlink_and_tracked_local_files_reject_before_write(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.root / '.codex').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])
        (self.root / '.codex').unlink()
        put(self.root / '.codex/config.toml', '[memories]\nuse_memories = true\n')
        git(self.root, 'add', '.codex/config.toml')
        before = tree_state(self.root)
        with self.assertRaisesRegex(ValueError, 'tracked'):
            self.install()
        self.assertEqual(before, tree_state(self.root))

    def test_drift_blocks_update_uninstall_and_doctor(self):
        self.install()
        path = self.root / '.codex/config.toml'
        put(path, path.read_text() + '# user change\n')
        before = tree_state(self.root)
        for action in (lambda: self.install(update=True), lambda: harness.uninstall(self.root), lambda: harness.doctor(self.root)):
            with self.assertRaisesRegex(ValueError, 'drift'):
                action()
            self.assertEqual(before, tree_state(self.root))

    def test_existing_empty_directories_survive(self):
        for name in ('.codex', '.agents/skills'):
            (self.root / name).mkdir(parents=True)
        self.install()
        harness.uninstall(self.root)
        self.assertTrue((self.root / '.codex').is_dir())
        self.assertTrue((self.root / '.agents/skills').is_dir())
        self.assertFalse((self.root / '.agents/skills/pstack-codex').exists())

    def test_global_hooks_inheritance_restored(self):
        hooks = self.home / 'original hooks'
        hooks.mkdir()
        put(self.home / '.gitconfig', '[core]\n\thooksPath = ' + str(hooks) + '\n')
        self.install()
        harness.uninstall(self.root)
        self.assertEqual(git(self.root, 'config', '--get', 'core.hooksPath').stdout.strip(), str(hooks))
        self.assertEqual(git(self.root, 'config', '--local', '--get', 'core.hooksPath', check=False).returncode, 1)

    def test_duplicate_and_worktree_override_reject(self):
        git(self.root, 'config', '--add', 'core.hooksPath', 'one')
        git(self.root, 'config', '--add', 'core.hooksPath', 'two')
        with self.assertRaisesRegex(ValueError, 'multiple'):
            self.install()
        self.assertFalse((self.root / '.harness').exists())
        git(self.root, 'config', '--unset-all', 'core.hooksPath')
        git(self.root, 'config', 'extensions.worktreeConfig', 'true')
        git(self.root, 'config', '--worktree', 'core.hooksPath', 'other')
        with self.assertRaisesRegex(ValueError, 'override'):
            self.install()
        self.assertFalse((self.root / '.harness').exists())

    def test_failed_second_repo_git_write_rolls_back_everything(self):
        root = self.base / 'rollback root'
        first, second = self.repo(root / 'first'), self.repo(root / 'second')
        before = tree_state(root)
        excludes = [harness.snapshot(p / '.git/info/exclude') for p in (first, second)]
        original = harness.write_local
        raised = []
        def fail_once(repo, vals):
            if repo == second and vals and not raised:
                raised.append(True)
                raise OSError('fixture write failure')
            return original(repo, vals)
        with patch.object(harness, 'write_local', side_effect=fail_once):
            with self.assertRaisesRegex(OSError, 'fixture write failure'):
                self.install(root, mapping={'one': 'first', 'two': 'second'})
        self.assertEqual(before, tree_state(root))
        self.assertFalse((root / '.harness').exists())
        for index, repo in enumerate((first, second)):
            self.assertEqual(excludes[index], harness.snapshot(repo / '.git/info/exclude'))
            self.assertEqual(harness.values(repo, '--local'), [])

    def test_ignore_negation_rolls_back(self):
        put(self.root / '.gitignore', '!/.codex/\n!/.codex/config.toml\n')
        before = tree_state(self.root)
        exclude = harness.snapshot(self.root / '.git/info/exclude')
        with self.assertRaisesRegex(ValueError, 'not excluded'):
            self.install()
        self.assertEqual(before, tree_state(self.root))
        self.assertEqual(exclude, harness.snapshot(self.root / '.git/info/exclude'))

    def test_private_survives_but_approval_does_not(self):
        self.install()
        private = self.root / '.harness/private'
        put(private / 'work/task/WORK.md', 'private fixture\n')
        put(private / 'work-control/task.json', '{"mode":"human"}\n')
        put(private / 'pr-approvals/fixture.json', '{"approved":true}\n')
        put(private / 'pr-approvals/fixture.lock', '')
        self.install(update=True)
        self.assertFalse((private / 'pr-approvals/fixture.json').exists())
        self.assertEqual((private / 'work-control/task.json').read_text(), '{"mode":"human"}\n')
        harness.uninstall(self.root)
        self.assertTrue((private / 'work/task/WORK.md').is_file())
        self.assertEqual(git(self.root, 'check-ignore', '.harness/private/work/task/WORK.md').returncode, 0)
        self.install()
        self.assertTrue((private / 'work/task/WORK.md').is_file())

    def test_newly_tracked_local_file_blocks_removal(self):
        self.install()
        git(self.root, 'add', '-f', '.codex/config.toml')
        with self.assertRaisesRegex(ValueError, 'tracked'):
            harness.uninstall(self.root)
        self.assertTrue((self.root / '.codex/config.toml').exists())

    def test_git_owned_root_must_be_explicitly_mapped(self):
        child = self.repo(self.root / 'api')
        before = tree_state(self.root)
        with self.assertRaisesRegex(ValueError, 'Git-owned workspace'):
            self.install(mapping={'api': 'api'})
        self.assertEqual(before, tree_state(self.root))
        nested = self.root / 'nested'
        self.repo(nested / 'other')
        with self.assertRaisesRegex(ValueError, 'Git-owned workspace'):
            self.install(nested, mapping={'other': 'other'})
        self.assertFalse((nested / '.harness').exists())

    def test_removed_worktree_does_not_block_update_or_uninstall(self):
        old = self.base / '.worktrees/removed/project'
        old.parent.mkdir(parents=True)
        git(self.root, 'worktree', 'add', '-b', 'removed', str(old))
        self.install()
        git(self.root, 'worktree', 'remove', str(old))
        self.assertEqual(harness.doctor(self.root)['status'], 'ok')
        self.install(update=True)
        self.assertFalse(any(str(old) in p for p in harness.load_manifest(self.root)['files']))
        harness.uninstall(self.root)
        self.assertFalse(old.exists())

    def test_toml_preserves_comments_and_crlf(self):
        original = '[memories]\r\nuse_memories = true # preserve\r\n'
        self.assertEqual(harness.memory_config(original), '[memories]\r\nuse_memories = false # preserve\r\n')
        self.assertEqual(harness.memory_config(''), '[memories]\nuse_memories = false\n')


if __name__ == '__main__':
    unittest.main()
