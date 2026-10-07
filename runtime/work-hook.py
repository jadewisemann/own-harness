#!/usr/bin/env python3
"""Chain Git's original hooks and the workspace WORK guard without changing cwd."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import urlsplit

import harness_common as common

# githooks(5), including hooks used by git-p4 and git-send-email.
HOOKS = """applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit
prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge
pre-push pre-receive update proc-receive post-receive post-update
reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate
fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist
p4-pre-submit post-index-change""".split()
GATES = {"pre-commit", "pre-merge-commit", "pre-push", "commit-msg"}


def fail(message):
    raise RuntimeError(message)


def git_env():
    # Push transports original objects, even when local refs/replace mask them.
    return common.git_environment()


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE, env=git_env()).decode().strip()


def internal_path(path):
    parts = PurePosixPath(path).parts
    return (PurePosixPath(path).name in {"WORK.md", "WORK.metadata.json", "WORK.metadata.yaml"}
            or (len(parts) > 1 and parts[0] == ".harness" and parts[1].startswith("private")))


def github_repo(remote):
    """Only GitHub endpoints that can be checked against the actual push URL."""
    match = re.fullmatch(r"git@github\.com:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?", remote)
    if match:
        return "/".join(match.groups())
    url = urlsplit(remote)
    if (url.scheme not in {"https", "ssh"} or url.hostname != "github.com"
            or url.query or url.fragment or url.password
            or (url.scheme == "https" and (url.username or url.port not in {None, 443}))
            or (url.scheme == "ssh" and (url.username != "git" or url.port not in {None, 22}))):
        fail("internal WORK documents require a verifiable github.com push URL")
    match = re.fullmatch(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?", url.path)
    if not match:
        fail("cannot identify the GitHub repository from the push URL")
    return "/".join(match.groups())


def check_push_delivery(args, data):
    """Check path-bearing outgoing commits, never classify a SHA as secret."""
    if len(args) != 2:
        fail("pre-push requires Git's remote name and actual push URL")
    commits = set()
    verified_head = git("rev-parse", "--verify", "HEAD^{commit}")
    for line in data.decode("utf-8", "surrogateescape").splitlines():
        fields = line.split()
        if len(fields) != 4 or any(not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", fields[i]) for i in (1, 3)):
            fail("invalid pre-push ref update")
        _, local_oid, _, remote_oid = fields
        if set(local_oid) == {"0"}:
            continue
        tip = git("rev-parse", "--verify", local_oid + "^{commit}")
        if tip != verified_head:
            fail("push rejected: every non-deletion source must resolve to the WORK-checked current HEAD")
        revisions = [tip]
        if set(remote_oid) != {"0"}:
            known = subprocess.run(["git", "rev-parse", "--verify", remote_oid + "^{commit}"],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=git_env())
            if known.returncode == 0:
                revisions.append("^" + known.stdout.decode().strip())
        # A new branch (or unknown remote tip) has no safe local exclusion set.
        # Conservatively inspect its ancestry instead of trusting fetch refs for a push URL.
        commits.update(git("rev-list", *revisions).splitlines())
    found = False
    for commit in commits:
        paths = subprocess.check_output(["git", "diff-tree", "--root", "-m", "--no-commit-id",
                                         "--name-only", "-r", "-z", commit], env=git_env()).decode("utf-8", "surrogateescape").split("\0")
        if any(internal_path(path) for path in paths if path):
            found = True
            break
    if not found:
        return
    repository = github_repo(args[1])
    # Explicit hostname avoids GH_HOST changing the API target for github.com URLs.
    result = subprocess.run(["gh", "api", "--hostname", "github.com", f"repos/{repository}", "--jq", ".private"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode or result.stdout.strip() != b"true":
        fail("push rejected: outgoing commits contain internal WORK paths; GitHub private=true is required")


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in HOOKS:
        fail("usage: work-hook.py CONFIG_PATH HOOK_NAME [hook arguments]")
    config_file, hook, *args = sys.argv[1:]
    config = json.loads(Path(config_file).read_text())
    common.load_config()
    workspace = Path(config["workspace"]).resolve()
    common.require(workspace == common.ROOT, "hook configuration belongs to another workspace")
    common.safe_path(workspace, str(Path(config_file).absolute().relative_to(workspace)))
    if Path(git("rev-parse", "--path-format=absolute", "--git-common-dir")).resolve() != Path(config["common_dir"]).resolve():
        fail("hook configuration belongs to another Git repository")
    previous = Path(config["previous_path"])
    if not previous.is_absolute():
        previous = Path.cwd() / previous
    # Missing individual hook files are normal. A configured directory that is
    # missing means we cannot preserve the configured Husky/local checks.
    if not previous.is_dir() and config["previous_configured"] and hook in GATES:
        fail(f"original hooks directory is missing: {previous}; restore the repository's hook dependencies")
    data = sys.stdin.buffer.read() if hook == "pre-push" else None
    if hook in GATES:
        checker = workspace / ".harness/runtime/check-workspace"
        result = subprocess.run([sys.executable, str(checker), hook, *args], input=data)
        if result.returncode:
            return result.returncode
        if hook == "pre-push":
            check_push_delivery(args, data)
    original = previous / hook
    if not original.is_file() or not os.access(original, os.X_OK):
        return 0
    if original.resolve() == (Path(config_file).parent / hook).resolve():
        fail("original hook points back to the WORK wrapper")
    if hook in GATES:
        result = subprocess.run([str(original), *args], input=data)
        if result.returncode:
            return result.returncode
        # User hooks may format or stage files: recheck the final delivery state.
        result = subprocess.run([sys.executable, str(checker), hook, *args], input=data)
        if result.returncode:
            return result.returncode
        if hook == "pre-push":
            check_push_delivery(args, data)
        return 0
    # In particular, proc-receive is a bidirectional protocol: never pre-read it.
    os.execv(str(original), [str(original), *args])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"work hook: {error}", file=sys.stderr)
        sys.exit(1)
