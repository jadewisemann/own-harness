#!/usr/bin/env python3
"""Offline user-flow checks: --source PACKAGE_ROOT (Python 3.9+, Git 2.31+).

Uses temporary repositories, local bare remotes and fake gh. Synthetic user
events are inputs to a copied module, not real Codex approval or trust evidence.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
PHASES = ("research", "design", "implementation", "verification")


def write(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)


def run(cwd, *args, reject=None, data=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, input=data,
                            text=True, capture_output=True, timeout=45)
    output = result.stdout + result.stderr
    if reject is None:
        assert result.returncode == 0, (args, result.returncode, output)
    else:
        assert result.returncode != 0 and reject in output, (args, result.returncode, output)
    return result.stdout.strip()


def saved(path):
    return (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() else None


def repository(path, tracked_agents=False):
    path.mkdir(parents=True)
    run(path, "git", "init", "-q", "-b", "main")
    for key, value in (("user.name", "Integration Fixture"), ("user.email", "fixture@example.invalid"),
                       ("commit.gpgSign", "false"), ("tag.gpgSign", "false")):
        run(path, "git", "config", key, value)
    write(path / "a.txt", "original\n")
    write(path / "b.txt", "outside scope\n")
    write(path / "AGENTS.md", "# Local instructions\n\nKeep the existing instructions.\n", 0o640)
    write(path / ".husky/pre-commit", '#!/bin/sh\npwd >> "$FIXTURE_COMMIT_CWD"\n'
          '[ ! -e "$FIXTURE_FAIL_HOOK" ] || { echo "fixture hook failure" >&2; exit 23; }\n', 0o755)
    write(path / ".husky/pre-push", '#!/bin/sh\npwd >> "$FIXTURE_PUSH_CWD"\n'
          'printf "%s\\n%s\\n" "$1" "$2" >> "$FIXTURE_PUSH_ARGS"\n'
          'cat >> "$FIXTURE_PUSH_INPUT"\n', 0o755)
    run(path, "git", "add", "a.txt", "b.txt", ".husky")
    if tracked_agents:
        run(path, "git", "add", "AGENTS.md")
    run(path, "git", "commit", "-qm", "test: initial fixture")
    run(path, "git", "config", "core.hooksPath", ".husky")
    write(path / ".codex/config.toml", 'model = "fixture-model"\n', 0o640)
    write(path / ".codex/hooks.json", json.dumps({"hooks": {"UserPromptSubmit": [
        {"hooks": [{"type": "command", "command": "printf fixture-existing-hook"}]}]}}) + "\n", 0o640)
    write(path / ".agents/skills/existing/SKILL.md", "# Existing skill\n", 0o640)
    write(path / ".git/info/exclude", "# Existing excludes\nlocal-note.txt\n", 0o640)
    paths = ["AGENTS.md", ".codex/config.toml", ".codex/hooks.json", ".agents/skills/existing/SKILL.md",
             ".husky/pre-commit", ".husky/pre-push", ".git/info/exclude"]
    return {name: saved(path / name) for name in paths}


def fill_contract(path):
    text = path.read_text(encoding="utf-8")
    assert "own-harness-work:v1" in text
    for label, value in (("목표", "임시 파일 전달 흐름을 확인한다"), ("범위", "임시 저장소와 검사"),
                         ("완료 조건", "실제 CLI와 로컬 Git 전달 검사 통과")):
        assert label + ": 작성 필요" in text, text
        text = text.replace(label + ": 작성 필요", label + ": " + value)
    path.write_text(text, encoding="utf-8")


def restore_check(repo, originals):
    for name, original in originals.items():
        if name == ".git/info/exclude":
            current, mode = saved(repo / name)
            assert mode == original[1] and current.startswith(original[0])
            assert set(current[len(original[0]):].decode().splitlines()) <= {"", "/.harness/", "/.worktrees/"}
            continue
        assert saved(repo / name) == original, "original bytes/mode changed: " + str(repo / name)
    assert run(repo, "git", "config", "--get", "core.hooksPath") == ".husky"
    assert run(repo, "git", "check-ignore", ".harness/retained", ".worktrees/retained").splitlines() == [
        ".harness/retained", ".worktrees/retained"]


def single_flow(package, temp):
    workspace = temp / "낯선 이름 single repo"
    originals = repository(workspace)
    harness = package / "harness.py"
    run(temp, sys.executable, harness, "install", workspace)
    installed = workspace / ".harness"
    assert json.loads((installed / "config.json").read_text()) == {"schema": 1, "repos": {"project": "."}}
    run(temp, sys.executable, harness, "install", workspace)
    run(temp, sys.executable, harness, "doctor", workspace)
    assert "fixture-existing-hook" in (workspace / ".codex/hooks.json").read_text()
    assert "use_memories = false" in (workspace / ".codex/config.toml").read_text()
    run(workspace, "git", "commit", "--allow-empty", "-qm", "test: baseline rejected", reject="baseline")
    runtime = installed / "runtime"
    task = "single-flow"

    def work(*args, reject=None):
        return run(workspace, sys.executable, runtime / "work.py", *args, reject=reject)

    def record(phase, evidence=None, reject=None):
        args = ["record", task, phase, "--evidence", evidence or phase + ": temporary file and contract inspected"]
        if phase == "verification":
            args += ["--reviewer", "integration-fixture-checker"]
        return work(*args, reject=reject)

    work("start", task, "--repo", "project", "--base", "main", "--branch", "test/single-flow")
    tree = workspace / ".worktrees" / task / "project"
    document = installed / "private/work" / task / "WORK.md"
    fill_contract(document)
    assert (tree / ".git").is_file()
    for checkout in (workspace, tree):
        assert "use_memories = false" in (checkout / ".codex/config.toml").read_text()
        assert run(checkout, "git", "check-ignore", ".codex/config.toml") == ".codex/config.toml"
        assert (checkout / ".agents/skills/pstack-codex/SKILL.md").is_file()
        assert (checkout / "AGENTS.override.md").is_file()

    # Import only the installed temporary copy; do not invoke any real hook entrypoint.
    sys.path.insert(0, str(runtime))
    spec = importlib.util.spec_from_file_location("isolated_integration_pr_guard", runtime / "pr-guard.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    assert guard.STATE_DIR.resolve().is_relative_to(temp)
    event_number = 0

    def event(prompt, reject=None, **extra):
        nonlocal event_number
        event_number += 1
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": os.environ["CODEX_THREAD_ID"],
                   "turn_id": "fixture-turn-" + str(event_number), "cwd": str(tree), "prompt": prompt}
        payload.update(extra)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                result = guard.hook(payload)
            except ValueError as error:
                assert reject is not None and reject in str(error), str(error)
                return str(error)
        assert reject is None, "Synthetic event should have been rejected"
        return output.getvalue() + str(result)

    assert "사용자 통제로" in event("작업 통제 " + task)
    record("research")
    record("design")
    record("implementation", reject="사용자 통제")
    decision = work("decision", task)
    code = re.search(r"작업 승인 " + task + r" ([a-f0-9]{12})", decision)[1]
    approval = "작업 승인 " + task + " " + code
    event(approval, turn_id=None, reject="turn_id")
    record("implementation", reject="사용자 통제")
    event(approval, agent_id="fixture-child", reject="하위 에이전트")
    record("implementation", reject="사용자 통제")
    assert "현재 작업 계약 승인" in event(approval)
    write(tree / "a.txt", "verified product change\n")
    record("implementation")
    record("verification")
    run(tree, "git", "add", "a.txt")
    work("check", "--cwd", tree, "--delivery", reject="검증 뒤 바뀌었습니다")
    run(tree, "git", "diff", "--check")
    record("verification", "git diff --check succeeded; staged a.txt contains the expected product change")
    work("check", "--cwd", tree, "--delivery")
    head = run(tree, "git", "rev-parse", "HEAD")
    write(tree / "a.txt", "unverified change\n")
    run(tree, "git", "commit", "-qm", "test: stale rejected", reject="검증 뒤 바뀌었습니다")
    assert run(tree, "git", "rev-parse", "HEAD") == head
    run(tree, "git", "restore", "a.txt")
    failure = Path(os.environ["FIXTURE_FAIL_HOOK"])
    failure.touch()
    run(tree, "git", "commit", "-qm", "test: hook rejected", reject="fixture hook failure")
    assert run(tree, "git", "rev-parse", "HEAD") == head
    failure.unlink()
    run(tree, "git", "diff", "--check")
    run(tree, "git", "commit", "-qm", "test: actual product change")
    tip = run(tree, "git", "rev-parse", "HEAD")
    assert tip != head
    assert Path(os.environ["FIXTURE_COMMIT_CWD"]).read_text().splitlines()[-1] == str(tree)
    remote = temp / "local remote.git"
    run(temp, "git", "init", "--bare", "-q", remote)
    run(tree, "git", "remote", "add", "local", remote)
    run(tree, "git", "remote", "add", "origin", "https://github.com/fixture/integration.git")
    run(tree, "git", "push", "local", "HEAD:refs/heads/test/single-flow", reject="검증 뒤 바뀌었습니다")
    work("snapshot", task)
    work("check", "--cwd", tree, "--delivery", reject="검증 뒤 바뀌었습니다")
    run(tree, "git", "diff", "--check", "HEAD^", "HEAD")
    assert (tree / "a.txt").read_text() == "verified product change\n"
    record("verification", "Post-commit git diff --check HEAD^ HEAD succeeded; a.txt matches expected bytes")
    run(tree, "git", "push", "local", "HEAD:refs/heads/test/single-flow")
    assert run(remote, "git", "rev-parse", "refs/heads/test/single-flow") == tip
    assert Path(os.environ["FIXTURE_PUSH_CWD"]).read_text().splitlines()[-1] == str(tree)
    assert Path(os.environ["FIXTURE_PUSH_ARGS"]).read_text().splitlines()[-2:] == ["local", str(remote)]
    assert Path(os.environ["FIXTURE_PUSH_INPUT"]).read_text().splitlines()[-1].split() == [
        "HEAD", tip, "refs/heads/test/single-flow", "0" * 40]

    pr = temp / "PR.md"
    write(pr, "# PR.md\n\n## 제목\n\nfix: isolated integration\n\n## 본문\n\nTemporary file change and local verification.\n")

    def pr_cli(*args, reject=None):
        return run(tree, sys.executable, runtime / "pr-guard.py", *args, reject=reject)

    def review():
        pr_cli("review", pr, "--cwd", tree, "--base", "main")
        state_path = installed / "private/pr-approvals" / (hashlib.sha256(os.environ["CODEX_THREAD_ID"].encode()).hexdigest() + ".json")
        return json.loads(state_path.read_text())["token"]

    token = review()
    pr_cli("create", reject="승인")
    event("PR 승인 " + token, turn_id=None, reject="turn_id")
    pr_cli("create", reject="승인")
    token = review()
    event("PR 승인 " + token, agent_id="fixture-child", reject="하위 에이전트")
    pr_cli("create", reject="승인")
    token = review()
    event("PR 승인 " + token)
    write(tree / "a.txt", "changed after approval\n")
    pr_cli("create", reject="delivery")
    assert not Path(os.environ["FIXTURE_GH_LOG"]).exists()
    run(tree, "git", "restore", "a.txt")
    pr_cli("create", reject="승인")
    token = review()
    event("PR 승인 " + token)
    pr_cli("create")
    pr_cli("create", reject="승인")
    sent = [json.loads(line) for line in Path(os.environ["FIXTURE_GH_LOG"]).read_text().splitlines()]
    assert len(sent) == 1 and sent[0]["cwd"] == str(tree)
    assert "--draft" in sent[0]["args"] and sent[0]["body"] == "Temporary file change and local verification.\n"

    # Private history remains local unless the actual push URL proves GitHub private=true.
    write(tree / "internal/WORK.md", "private fixture evidence\n")
    run(tree, "git", "add", "internal/WORK.md")
    record("verification", "Private fixture is staged for local history transfer rejection check")
    run(tree, "git", "commit", "-qm", "test: private fixture history")
    record("verification", "Post-commit private history and product file were inspected")
    run(tree, "git", "push", "local", "HEAD:refs/heads/test/single-flow", reject="internal")
    assert run(remote, "git", "rev-parse", "refs/heads/test/single-flow") == tip
    new_tip = run(tree, "git", "rev-parse", "HEAD")
    push_hook = Path(run(tree, "git", "config", "--get", "core.hooksPath")) / "pre-push"
    public_refs = "HEAD " + new_tip + " refs/heads/test/single-flow " + "0" * 40 + "\n"
    run(tree, push_hook, "origin", "https://github.com/fixture/integration.git", data=public_refs, reject="private=true")
    assert "repos/fixture/integration" in Path(os.environ["FIXTURE_API_LOG"]).read_text()
    print("PASS single repo: installed CLI, four phases, stale stage/HEAD/content, Husky cwd/argv/stdin/failure, local push, human gate, isolated PR approval/single use, private history rejection")

    # Update from a changed package invalidates evidence and keeps human control.
    token = review()
    event("PR 승인 " + token)
    changed = temp / "updated package"
    shutil.copytree(package, changed, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    with (changed / "runtime/work.py").open("a", encoding="utf-8") as stream:
        stream.write("\n# Integration fixture: changed runtime policy bytes.\n")
    run(temp, sys.executable, changed / "harness.py", "update", workspace)
    control = json.loads((installed / "private/work-control" / (task + ".json")).read_text())
    assert control["mode"] == "human"
    work("check", "--cwd", tree, "--delivery", reject="사용자 통제")
    pr_cli("create", reject="승인")
    assert len(Path(os.environ["FIXTURE_GH_LOG"]).read_text().splitlines()) == 1
    decision = work("decision", task)
    code = re.search(r"작업 승인 " + task + r" ([a-f0-9]{12})", decision)[1]
    assert "현재 작업 계약 승인" in event("작업 승인 " + task + " " + code)
    work("check", "--cwd", tree, "--delivery", reject="작업 계약이 바뀌었습니다")
    kept_record = document.read_bytes()
    run(temp, sys.executable, changed / "harness.py", "uninstall", workspace)
    restore_check(workspace, originals)
    assert document.read_bytes() == kept_record and tree.is_dir()
    assert run(tree, "git", "rev-parse", "HEAD") == new_tip
    assert not (tree / "AGENTS.md").exists() and not (tree / ".codex/config.toml").exists()
    assert not (tree / "AGENTS.override.md").exists()
    print("PASS update/uninstall: policy invalidation, human mode and private WORK/worktree preserved, original bytes/modes/hooks restored")


def multi_flow(package, temp):
    workspace = temp / "상위 non git workspace"
    workspace.mkdir()
    mapping = {"project": "서버 코드", "workspace": "web client"}
    originals = {name: repository(workspace / relative, tracked_agents=True) for name, relative in mapping.items()}
    harness = package / "harness.py"
    args = [sys.executable, harness, "install", workspace]
    for name, relative in mapping.items():
        args += ["--repo", name + "=" + relative]
    run(temp, *args)
    run(temp, *args)
    assert not (workspace / ".git").exists()
    assert json.loads((workspace / ".harness/config.json").read_text())["repos"] == mapping
    run(temp, sys.executable, harness, "doctor", workspace)
    for name, relative in mapping.items():
        baseline = workspace / relative
        assert saved(baseline / "AGENTS.md") == originals[name]["AGENTS.md"]
        assert run(baseline, "git", "diff", "--name-only") == ""
        run(workspace, sys.executable, workspace / ".harness/runtime/work.py", "start", "paired", "--repo", name,
            "--base", "main", "--branch", "test/paired")
        tree = workspace / ".worktrees/paired" / name
        assert run(tree, "git", "rev-parse", "--path-format=absolute", "--git-common-dir") == str(baseline / ".git")
        assert run(tree, "git", "diff", "--name-only") == ""
    record = workspace / ".harness/private/work/paired/WORK.md"
    fill_contract(record)
    managed = workspace / ".harness/templates/AGENTS.fragment.md"
    prior = saved(managed)
    with managed.open("a", encoding="utf-8") as stream:
        stream.write("\nUser modification must survive a rejected update.\n")
    drift = managed.read_bytes()
    run(temp, sys.executable, harness, "update", workspace, reject="managed file drift")
    assert managed.read_bytes() == drift
    managed.write_bytes(prior[0])
    managed.chmod(prior[1])
    run(temp, sys.executable, harness, "update", workspace)
    kept_record = record.read_bytes()
    run(temp, sys.executable, harness, "uninstall", workspace)
    for name, relative in mapping.items():
        restore_check(workspace / relative, originals[name])
        tree = workspace / ".worktrees/paired" / name
        assert (tree / ".git").is_file()
        assert run(tree, "git", "config", "--get", "core.hooksPath") == ".husky"
        assert (tree / "AGENTS.md").read_bytes() == originals[name]["AGENTS.md"][0]
        assert stat.S_IMODE((tree / "AGENTS.md").stat().st_mode) == stat.S_IMODE((tree / "a.txt").stat().st_mode)
        assert not (tree / ".codex/config.toml").exists()
        assert not (tree / "AGENTS.override.md").exists()
    assert record.read_bytes() == kept_record
    print("PASS non-Git multi repo: explicit aliases, Unicode/spaces, duplicate install, tracked AGENTS, linked worktrees, drift refusal, update/uninstall preservation")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    source = parser.parse_args().source.resolve()
    for relative in ("harness.py", "runtime/work.py", "runtime/pr-guard.py", "runtime/harness_common.py",
                     "skills/pstack-codex/SKILL.md", "templates/AGENTS.fragment.md"):
        assert (source / relative).is_file(), "Missing package input: " + str(source / relative)
    with tempfile.TemporaryDirectory(prefix="own-harness-integration-") as directory:
        temp = Path(directory).resolve()
        fakebin = temp / "bin"
        fakebin.mkdir()
        empty_template = temp / "empty-template"
        empty_template.mkdir()
        # No inherited Git context or live Codex session identifiers reach the fixture.
        for key in list(os.environ):
            if key.startswith(("GIT_", "CODEX_", "HARNESS_")):
                os.environ.pop(key)
        os.environ.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null",
                          GIT_TEMPLATE_DIR=str(empty_template), GIT_ALLOW_PROTOCOL="file", GIT_TERMINAL_PROMPT="0",
                          PYTHONDONTWRITEBYTECODE="1", CODEX_THREAD_ID="isolated-integration-fixture",
                          PATH=str(fakebin) + os.pathsep + os.environ["PATH"])
        for key in ("COMMIT_CWD", "PUSH_CWD", "PUSH_ARGS", "PUSH_INPUT", "FAIL_HOOK", "GH_LOG", "API_LOG"):
            os.environ["FIXTURE_" + key] = str(temp / key.lower())
        write(fakebin / "gh", '#!' + sys.executable + '\nimport json,os,pathlib,sys\n'
              'args=sys.argv[1:]\n'
              'if args and args[0] == "api":\n'
              '    pathlib.Path(os.environ["FIXTURE_API_LOG"]).write_text(json.dumps(args))\n'
              '    print("false")\n'
              'elif args[:2] == ["pr", "create"]:\n'
              '    body=pathlib.Path(args[args.index("--body-file")+1]).read_text()\n'
              '    with pathlib.Path(os.environ["FIXTURE_GH_LOG"]).open("a") as f:\n'
              '        f.write(json.dumps({"args":args,"body":body,"cwd":os.getcwd()})+"\\n")\n'
              '    print("https://github.com/fixture/integration/pull/1")\n'
              'else:\n'
              '    raise SystemExit("Unexpected fake gh call: " + repr(args))\n', 0o755)
        single_flow(source, temp)
        multi_flow(source, temp)
    print("PASS integration: temporary Git/CLI/hooks and fake gh only; real Codex session/trust and remote PR remain unverified")


if __name__ == "__main__":
    main()
