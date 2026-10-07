#!/usr/bin/env python3
"""Review PR.md, accept a user hook approval, then create that exact PR once."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

import harness_common as common

SCRIPT = Path(__file__).resolve()
WORKSPACE = SCRIPT.parents[2]
STATE_DIR = WORKSPACE / ".harness/private/pr-approvals"
FORMAT = "PR.md는 '# PR.md → ## 제목 → 한 줄 제목 → ## 본문 → 본문' 순서여야 합니다."
DIRECT = "직접 PR 생성은 차단합니다. pr-guard.py review로 PR.md를 보여 주고 사용자 승인을 받은 뒤 pr-guard.py create를 실행하세요."


def read_document(path):
    if Path(path).name != "PR.md":
        raise ValueError("PR 문서 파일 이름은 PR.md여야 합니다.")
    raw = Path(path).read_bytes()
    text = raw.decode("utf-8")
    match = re.fullmatch(r"# PR\.md\s*\n## 제목\s*\n([^\n]+)\n\s*## 본문\s*\n(.+)", text, re.S)
    if not match or not match[1].strip() or not match[2].strip():
        raise ValueError(FORMAT)
    reject_internal_metadata(text)
    return text, match[1].strip(), match[2].strip() + "\n", hashlib.sha256(raw).hexdigest()


def reject_internal_metadata(text):
    # Match copied harness records, not API identifiers or ordinary commit hashes.
    local_path = r"/(?:[^\s<>)\]`/]*/)*(?:\.harness|\.worktrees?)(?:/|\b)"
    if (re.search(local_path, text) or str(WORKSPACE) + "/" in text or re.search(r'\.harness[/\\]private(?:[/\\]|\b)', text) or
            re.search(r"(?<![\w])WORK\.md\b|<!--\s*own-harness-work\b|```own-harness-work\b", text, re.I)):
        raise ValueError("PR.md에서 로컬 경로·WORK.md 참조·own-harness-work 메타데이터를 제거하세요.")
    fields = r"task_id|base_sha|head_sha|verified_state|workspace_root|worktree_path|current_fingerprint|verified_fingerprint|contract_sha256|control_mode"
    copied_field = re.compile(r'^\s*(?:[-*]\s+|\|\s*)?["`]?(' + fields + r')["`]?\s*[:=|]\s*')
    fenced_field = re.compile(r'(?<![\w.])["`]?(' + fields + r')["`]?\s*[:=]\s*')
    fenced = False
    fenced_keys = set()
    for line in text.splitlines():
        if re.match(r"\s*(?:`{3,}|~{3,})", line):
            if fenced and len(fenced_keys) >= 2:
                raise ValueError("PR.md에 내부 작업 메타데이터 필드를 복사할 수 없습니다.")
            fenced = not fenced
            fenced_keys = set()
            continue
        if fenced:
            fenced_keys.update(fenced_field.findall(line))
        elif copied_field.match(line):
            raise ValueError("PR.md에 내부 작업 메타데이터 필드를 복사할 수 없습니다.")
    if len(fenced_keys) >= 2:
        raise ValueError("PR.md에 내부 작업 메타데이터 필드를 복사할 수 없습니다.")


def check_delivery(cwd):
    validator = SCRIPT.parent / "work.py"
    if not validator.is_file():
        raise ValueError("delivery 검증기 .harness/runtime/work.py가 없습니다.")
    env = git_environment()
    if "GIT_INDEX_FILE" in os.environ:
        env["GIT_INDEX_FILE"] = os.environ["GIT_INDEX_FILE"]
    result = subprocess.run([sys.executable, str(validator), "check", "--cwd", cwd, "--delivery"],
                            capture_output=True, text=True, env=env)
    if result.returncode:
        raise ValueError("delivery 검증 실패: " + (result.stderr or result.stdout).strip())


def git_environment():
    return common.git_environment()


def git(cwd, *args):
    return subprocess.check_output(["git", "--no-replace-objects", "-C", str(cwd), *args],
                                   text=True, stderr=subprocess.PIPE, env=git_environment()).strip()


def snapshot(file, cwd, base, draft=True):
    cwd = git(str(cwd), "rev-parse", "--show-toplevel")
    remote = git(cwd, "remote", "get-url", "origin")
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([^/]+/[^/]+?)(?:\.git)?/?", remote)
    if not match:
        raise ValueError("origin은 github.com의 owner/repo Git 원격이어야 합니다.")
    head = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
    if not base or base.startswith("-") or base == head:
        raise ValueError("서로 다른 head와 base 브랜치를 지정하세요.")
    file = str(Path(file).resolve())
    text, title, body, document_sha256 = read_document(file)
    check_delivery(cwd)
    return dict(file=file, cwd=cwd, repo=match[1], head=head, base=base, draft=draft,
                commit=git(cwd, "rev-parse", "HEAD"), document=text, document_sha256=document_sha256,
                title=title, body=body, policy_sha256=common.policy_digest(WORKSPACE))


def current(proposal):
    return snapshot(proposal["file"], proposal["cwd"], proposal["base"], proposal["draft"])


def session_id(value=None):
    value = value or os.environ.get("CODEX_THREAD_ID")
    if not value:
        raise ValueError("Codex 세션 ID가 없어 PR 승인을 연결할 수 없습니다.")
    return value


def state_path(session):
    common.safe_path(WORKSPACE, ".harness", "private", "pr-approvals")
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = STATE_DIR / (hashlib.sha256(session.encode()).hexdigest() + ".json")
    common.require(not path.is_symlink() and not path.with_suffix(".lock").is_symlink(), "승인 상태 symlink를 허용하지 않습니다.")
    return path


def load(path):
    return json.loads(path.read_text()) if path.exists() else {}


def save(path, state):
    common.atomic_write(path, json.dumps(state, ensure_ascii=False) + "\n")


def review(file, cwd, base, draft=True):
    session = session_id()
    proposal = snapshot(file, cwd, base, draft)
    token = hashlib.sha256((session + json.dumps(proposal, sort_keys=True)).encode()).hexdigest()[:12]
    path = state_path(session)
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        save(path, dict(proposal=proposal, token=token, approved=False, consumed=False, invalidated=False))
    print(proposal["document"])
    print(f"대상: {proposal['repo']} · {proposal['head']} → {base} · {'Draft' if draft else 'Ready'} · {proposal['commit'][:9]}")
    print(f"이 파일을 열고 제목·본문 전체를 사용자에게 제시한 뒤 `PR 승인 {token}` 응답을 받으세요.")


def require_approval(state):
    if not state.get("approved") or not state.get("approval_turn") or state.get("approval_session") != session_id() or state.get("consumed") or state.get("invalidated"):
        raise ValueError("검토한 PR에 대한 사용자 승인이 없거나 무효화·사용됐습니다.")
    try:
        if current(state["proposal"]) != state["proposal"]:
            raise ValueError("문서·저장소·브랜치·HEAD가 바뀌었습니다. PR.md를 다시 review하고 승인받으세요.")
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError):
        state.update(approved=False, invalidated=True)
        raise


def create():
    path = state_path(session_id())
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load(path)
        try:
            require_approval(state)
        except (ValueError, OSError, subprocess.CalledProcessError, KeyError):
            save(path, state)
            raise
        state["consumed"] = True
        save(path, state)
    proposal = state["proposal"]
    # Consume before dispatch: a timeout may still have created the PR remotely.
    with tempfile.TemporaryDirectory(prefix="pr-body-") as directory:
        body_file = Path(directory) / "body.md"
        body_file.write_text(proposal["body"], encoding="utf-8")
        args = ["gh", "pr", "create", "--repo", proposal["repo"], "--head", proposal["head"],
                "--base", proposal["base"], "--title", proposal["title"], "--body-file", str(body_file)]
        if proposal["draft"]:
            args.append("--draft")
        subprocess.run(args, cwd=proposal["cwd"], check=True)


def direct_creation(name, command):
    if re.search(r"(?:create_pull_request|createPullRequest|create_pr)$", name):
        return True
    # A command guard catches ordinary CLI/API calls, not arbitrary program semantics.
    return bool(re.search(r"\bgh\b[^\n;&|]*\bpr\s+create\b|createPullRequest", command) or
                (re.search(r"\b(?:gh|curl|http|https)\b", command) and
                 re.search(r"(?:/|\b)pulls(?:\b|[/?])", command) and
                 re.search(r"\bPOST\b|--(?:raw-)?field\b|--data|\s-[fFd]\b", command)))


def work_hook(event):
    try:
        result = subprocess.run([sys.executable, str(SCRIPT.parent / "work.py"), "hook"],
                                input=json.dumps(event, ensure_ascii=False), capture_output=True, text=True)
        output = json.loads(result.stdout) if result.stdout.strip() else {}
        if not isinstance(output, dict):
            raise ValueError("work.py hook 출력은 JSON 객체여야 합니다.")
        blocked = output.get("decision") == "block" or output.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"
        if result.returncode and not blocked:
            raise ValueError((result.stderr or result.stdout).strip() or "work.py hook 실행 실패")
        return output
    except (ValueError, OSError) as error:
        return {"decision": "block", "reason": f"작업 통제 훅을 확인할 수 없습니다: {error}"}


def hook(event):
    common.require(isinstance(event, dict), "hook event는 JSON 객체여야 합니다.")
    output = work_hook(event)
    blocked = output.get("decision") == "block" or output.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"
    kind = event.get("hook_event_name")
    if kind == "UserPromptSubmit":
        session, turn = common.event_proof(event)
        path = state_path(session)
        with path.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = load(path)
            if not state:
                if output:
                    print(json.dumps(output, ensure_ascii=False))
                return
            event_key = common.digest({'session': session, 'turn': turn, 'prompt': event.get('prompt', '')})
            if state.get('last_event') == event_key:
                if output:
                    print(json.dumps(output, ensure_ascii=False))
                return
            state['last_event'] = event_key
            state["approved"] = False
            approved = not blocked and event.get("prompt", "").strip() == "PR 승인 " + state.get("token", "")
            if not approved:
                state["invalidated"] = True
            if approved and not state.get("consumed") and not state.get("invalidated"):
                try:
                    state["approved"] = current(state["proposal"]) == state["proposal"]
                except (ValueError, OSError, subprocess.CalledProcessError, KeyError):
                    state["approved"] = False
                if state["approved"]:
                    state["approval_turn"] = turn
                    state["approval_session"] = session
                else:
                    state["invalidated"] = True
            save(path, state)
        if approved:
            message = "검토한 PR 승인 확인. pr-guard.py create로 생성하세요." if state["approved"] else "검토 내용이 변경·무효화됐거나 이미 사용한 승인입니다. 다시 review하세요."
            specific = output.setdefault("hookSpecificOutput", {"hookEventName": kind})
            specific["additionalContext"] = "\n".join(filter(None, [specific.get("additionalContext"), message]))
        if output:
            print(json.dumps(output, ensure_ascii=False))
        return
    if blocked:
        print(json.dumps(output, ensure_ascii=False))
        return
    if kind != "PreToolUse":
        if output:
            print(json.dumps(output, ensure_ascii=False))
        return
    name = event.get("tool_name", "")
    inputs = event.get("tool_input", {})
    command = inputs.get("command", inputs.get("cmd", "")) if isinstance(inputs, dict) else ""
    if name not in ("Bash", "exec_command", "shell", "shell_command"):
        command = ""
    if direct_creation(name, command):
        raise ValueError(DIRECT)
    if "pr-guard.py" in command:
        words = shlex.split(command)
        invocations = [(i, words[i + 1]) for i, word in enumerate(words[:-1])
                       if Path(word).name == "pr-guard.py" and words[i + 1] in ("create", "hook")]
        if invocations:
            if any(action == "hook" for _, action in invocations):
                raise ValueError("승인 이벤트는 Codex UserPromptSubmit 훅으로만 받습니다.")
            entry = Path(words[1]).resolve() if len(words) == 3 else None
            if (len(words) != 3 or Path(words[0]).name not in ("python3", "python") or
                    not Path(words[1]).is_absolute() or entry != SCRIPT):
                raise ValueError("PR 생성 명령은 python3 <pr-guard.py 절대경로> create 하나로 실행하세요.")
            session, turn = common.event_proof(event)
            path = state_path(session)
            with path.with_suffix(".lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                state = load(path)
                try:
                    require_approval(state)
                    common.require(state.get('approval_turn') == turn, 'PR 승인을 받은 사용자 turn에서만 생성할 수 있습니다.')
                finally:
                    save(path, state)
    if output:
        print(json.dumps(output, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    preview = commands.add_parser("review")
    preview.add_argument("file")
    preview.add_argument("--base", required=True)
    preview.add_argument("--cwd", default=os.getcwd())
    preview.add_argument("--ready", action="store_true")
    commands.add_parser("create")
    commands.add_parser("hook")
    args = parser.parse_args()
    try:
        common.load_config(WORKSPACE)
        if args.action == "review":
            review(args.file, args.cwd, args.base, not args.ready)
        elif args.action == "create":
            create()
        else:
            hook(json.load(sys.stdin))
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as error:
        print(f"PR guard: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
