# own-harness

Codex 작업에 pstack의 조사·설계·구현·독립 검증 흐름과 로컬 Git·승인 검사를 연결합니다. 단일 Git 저장소와 여러 저장소를 담은 상위 폴더에 설치할 수 있습니다.

`pstack-codex`는 판단 절차를 안내하는 스킬입니다. 별도 runtime은 작업 계약, 단계 근거, 현재 파일·HEAD·index, 승인 상태를 검사합니다. 이 검사는 사고의 충분함, 제품 품질, 모든 파일 쓰기의 차단이나 OS 보안 격리를 보장하지 않습니다.

## 설치

대상 환경은 **Python 3.9 이상, Git 2.31 이상, macOS·Linux의 POSIX 셸**입니다. 외부 Python 패키지는 필요하지 않습니다. PR 생성과 비공개 GitHub 전송 확인에는 인증된 `gh`가 필요합니다. Windows와 다른 에이전트·클라우드 훅 호환은 지원 범위에 포함하지 않습니다.

아래 경로와 작업 이름은 가상 예시입니다. 이미 Git 저장소가 있는 baseline 폴더에 설치하세요.

```sh
git clone https://github.com/jadewisemann/own-harness.git
cd own-harness
python3 harness.py install /absolute/path/project
python3 harness.py doctor /absolute/path/project
```

여러 저장소가 있는 상위 폴더는 저장소 이름과 상대 경로를 명시합니다. 상위 폴더 자체는 Git 저장소가 아니어도 됩니다.

```sh
python3 harness.py install /absolute/path/workspace --repo api=api --repo web=web
python3 harness.py doctor /absolute/path/workspace
```

설치기는 실행 파일을 대상의 `.harness/`에 복사합니다. 각 설치는 자기 runtime 사본을 사용하므로 배포 저장소의 checkout을 바꿔도 설치본이 곧바로 바뀌지 않습니다. 설정은 `.harness/config.json`에 저장됩니다. 기본 단일 저장소 매핑은 `{"schema":1,"repos":{"project":"."}}`입니다.

설치기는 baseline과 등록된 worktree에 다음 항목을 연결합니다.

- 기존 Git 훅을 이어 실행하는 로컬 wrapper와 제외 규칙.
- checkout의 `.codex/hooks.json`, 자동 메모리 주입을 끄는 `.codex/config.toml`.
- `.agents/skills/pstack-codex`와 로컬 `AGENTS.override.md`의 짧은 관리 블록.

기존 내용과 최초 설정값을 기록하고, 충돌이나 관리 파일의 사용자 변경이 있으면 덮어쓰지 않습니다. 전역 설정, Git 작성자 정보, Codex 신뢰 상태는 자동 변경하지 않습니다. 기존 전역 훅은 계속 별도로 적용될 수 있습니다. 자세한 연결 경계는 [adapters.md](docs/adapters.md)에 있습니다.

`AGENTS.md`는 수정하지 않습니다. 기존 untracked `AGENTS.override.md`는 본문을 보존하고, 추적 중인 override는 충돌로 거절합니다. Codex는 같은 폴더의 override를 우선 읽으므로 관리 블록은 원래 `AGENTS.md`를 먼저 읽도록 안내합니다. [공식 지침 탐색 문서](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## Codex에서 확인할 것

프로젝트 설정은 프로젝트 루트부터 현재 폴더까지 계층적으로 읽으며, 가까운 설정이 우선합니다. **프로젝트를 신뢰해야** 프로젝트의 설정·훅·규칙이 로드됩니다. [공식 설정 문서](https://learn.chatgpt.com/docs/config-file/config-advanced)

여기에 더해 관리 정책으로 제공되지 않은 훅은 **현재 훅 정의를 검토하고 신뢰해야** 실행됩니다. 새 훅이나 바뀐 훅은 다시 검토해야 합니다. Codex CLI의 `/hooks`에서 출처·명령을 확인하고 신뢰 여부를 직접 결정하세요. 프로젝트 신뢰만으로 개별 훅 신뢰를 대신할 수 없습니다. [공식 훅 문서](https://learn.chatgpt.com/docs/hooks)

`doctor`의 파일·설정 확인은 실제 Codex 활성화의 증명이 아닙니다. 새 checkout에서 스킬이 보이는지, 실제 사용자 메시지가 해당 훅에 도달하는지 확인하세요. 설치·업데이트는 신뢰를 자동 승인하지 않습니다. 테스트의 합성 이벤트도 실제 Codex 활성화나 사용자 승인 증거가 아닙니다.

## 작업 순서

설치한 뒤에는 **설치본**의 CLI를 사용합니다. 다음은 단일 저장소 예시입니다. 여러 저장소에서는 `--repo api`처럼 매핑 이름을 쓰고, 같은 작업에 필요한 저장소를 모두 등록한 뒤 계약을 확정합니다.

```sh
workspace=/absolute/path/project
runtime="$workspace/.harness/runtime"
task=example-change
checkout="$workspace/.worktrees/$task/project"
python3 "$runtime/work.py" start "$task" --repo project --base origin/main --branch feat/example-change
```

`start`는 `.worktrees/<task>/<repo>`를 만들고 로컬 설정을 준비한 뒤 WORK에 등록합니다. baseline의 미커밋 변경은 복사하지 않습니다. base는 로컬에서 해석 가능한 ref여야 하므로 필요하면 먼저 허용된 fetch로 갱신하세요. 제품 변경과 전달은 등록된 worktree에서 진행합니다.

1. `.harness/private/work/example-change/WORK.md`의 **작업 계약**에 목표·범위·완료 조건을 실제 요청으로 채웁니다. 같은 문서를 정본으로 유지합니다.
2. 조사로 실제 호출·데이터 흐름을 확인합니다. 설계에서 선택 이유, 대안, 의존 작업, 병렬 가능 작업, 공유 상태 분리 방법을 정합니다. 각 단계의 실제 근거 파일을 만든 뒤 차례로 기록합니다.

```sh
python3 "$runtime/work.py" record "$task" research --evidence "@$workspace/.harness/private/work/$task/research.md"
python3 "$runtime/work.py" record "$task" design --evidence "@$workspace/.harness/private/work/$task/design.md"
```

3. 허용된 변경을 구현하고 구현 근거를 기록합니다. 아래 파일 이름과 stage 대상은 예시이며 실제 변경에 맞춰 바꿉니다.

```sh
python3 "$runtime/work.py" record "$task" implementation --evidence "@$workspace/.harness/private/work/$task/implementation.md"
git -C "$checkout" add -- src/example.py tests/test_example.py
```

4. stage한 상태에서 실제 검사와 독립 검토를 수행합니다. `verification.md`에 명령·결과·검토자·미확인 범위를 남긴 뒤 기록하고 전달 상태를 검사합니다.

```sh
python3 "$runtime/work.py" record "$task" verification --evidence "@$workspace/.harness/private/work/$task/verification.md" --reviewer independent-reviewer
python3 "$runtime/work.py" check --cwd "$checkout" --delivery
git -C "$checkout" commit -m "fix: handle example input"
```

5. commit으로 HEAD가 바뀌면 영향을 받는 검사를 다시 실행하고 새 상태의 근거를 기록합니다. 그 뒤 push합니다.

```sh
python3 "$runtime/work.py" record "$task" verification --evidence "@$workspace/.harness/private/work/$task/verification-after-commit.md" --reviewer independent-reviewer
python3 "$runtime/work.py" check --cwd "$checkout" --delivery
git -C "$checkout" push -u origin feat/example-change
```

`record`는 입력한 보고를 저장하며 테스트를 대신 실행하지 않습니다. 예시 파일을 만들었다는 이유로 통과를 기록하지 마세요. `snapshot`도 실제 상태만 갱신하며 검증을 대신하지 않습니다. 검증 뒤 코드·index·HEAD·WORK 본문·실행 정책이 바뀌면 필요한 근거를 다시 얻습니다. `commit -a`나 `--only`의 임시 index 대신 명시적으로 stage한 일반 index를 사용합니다.

이미 만든 worktree는 `.worktrees/<task>/<repo>` 구조와 Git 등록이 맞아야 합니다. `prepare`로 설치 상태를 연결하고 `init`으로 등록합니다. 경로 범위를 제한하려면 최초 `init` 때 `--scope`를 사용합니다.

```sh
existing_checkout="$workspace/.worktrees/another-task/project"
python3 "$workspace/.harness/harness.py" prepare "$existing_checkout"
python3 "$runtime/work.py" init another-task --cwd "$existing_checkout" --base origin/main --scope src --scope tests
```

## 사람이 결정하는 모드

기본 `pstack` 모드는 현재 요청 범위에서 에이전트가 판단합니다. 사용자는 **같은 Codex 채팅에 직접** 다음 메시지를 보낼 수 있습니다.

| 사용자 메시지 | 효과 |
| --- | --- |
| `작업 통제 example-change` | human 모드로 전환. 조사·설계 기록은 허용하고, 현재 계약 승인 전 구현·검증 기록과 전달 검사를 막습니다. |
| `작업 이양 example-change` | 현재 요청·계약 범위에서 pstack 판단을 재개합니다. |
| `작업 승인 example-change <코드>` | human 모드에서 제시된 현재 계약만 승인합니다. |

human 모드에서는 에이전트가 `python3 "$runtime/work.py" decision "$task"`로 계약과 코드를 보여 줍니다. 실제 사용자의 메시지를 `UserPromptSubmit` 훅이 수신해야 승인이 기록됩니다. 계약 변경 후에는 새 코드가 필요합니다. 하위 에이전트·합성 이벤트·승인 파일 편집으로 대신하지 않습니다. 통제 이양은 commit·push·PR·배포 권한을 새로 만들지 않습니다.

## PR 승인

코드·검증·commit·push를 끝낸 뒤 실제 checkout에서 검토합니다. 기본은 Draft이며 일반 PR은 review에 `--ready`를 추가합니다.

`PR.md`는 아래 형식을 사용합니다. 본문에는 실제 변경과 확인한 결과를 쓰고 내부 작업 기록은 넣지 않습니다.

```markdown
# PR.md

## 제목

fix: handle empty input

## 본문

빈 입력을 처리할 때 발생하던 오류를 수정합니다.

- 변경: 입력 경계에서 빈 값을 처리합니다.
- 검증: 실제 실행한 검사와 결과를 작성합니다.
```

```sh
python3 "$runtime/pr-guard.py" review /absolute/path/PR.md --cwd "$checkout" --base main
```

에이전트는 `PR.md`를 편집기로 열고 제목·본문 전체, head → base, HEAD, Draft 여부와 출력된 `PR 승인 <검토 코드>`를 보여 줍니다. 사용자가 같은 채팅에서 그 문구를 직접 보낸 뒤 아래 명령을 **단독 실행**하고 생성한 PR을 채팅에 연결합니다.

```sh
python3 /absolute/path/project/.harness/runtime/pr-guard.py create
```

문서·HEAD·저장소·브랜치·base·Draft 상태가 바뀌거나 다른 요청이 들어오면 다시 review합니다. 실패 후 재시도 전에는 실제 PR 존재 여부를 조회합니다. 직접 `gh`·API·브라우저 생성이나 훅 이벤트 흉내로 우회하지 않습니다.

## 업데이트와 제거

새 배포본을 검토한 뒤 배포 저장소에서 실행합니다.

```sh
git pull --ff-only
python3 harness.py update /absolute/path/project
python3 harness.py doctor /absolute/path/project
```

업데이트는 최초 원본과 사용자 변경을 보존합니다. runtime·정책 변경으로 기존 근거와 PR 승인이 낡으면 다시 검증·승인해야 합니다. human 통제를 자동으로 이양하지 않습니다. 바뀐 훅 정의도 Codex에서 다시 검토하세요.

사용을 끝내고 설치를 제거할 때만 다음 명령을 실행합니다.

```sh
python3 harness.py uninstall /absolute/path/project
```

제거는 원래 Git 훅·설정과 관리 문서를 복구합니다. WORK·통제 기록·증거와 사용자 branch·worktree는 유지하며, 남은 로컬 기록을 보호하는 제외 규칙도 유지할 수 있습니다. 관리 파일에 사용자 변경이 있으면 충돌을 해결한 뒤 다시 실행하세요.

## 공개 패키지와 비공개 상태

공개 저장소에는 재사용 코드·스킬·템플릿·가상 예제만 둡니다. 설치본의 `.harness/private/`에는 WORK, 계약 기준점, 통제·PR 승인, 설치 원본 정보가 들어갑니다. 이 상태와 실제 내부 경로·식별자는 공개 저장소, PR 본문, 외부 공유 문서에 복사하지 마세요. PR에는 문제·변경 동작·관련 검증 결과만 선별합니다.

알려진 내부 WORK/private 이력의 push는 **실제 push URL이 가리키는 GitHub 저장소의 `private=true`가 확인될 때만** 허용합니다. 다른 호스트나 확인할 수 없는 대상은 거절합니다. 일반 코드의 일반 Git 원격 전송은 이 제한과 구분합니다. 텍스트·이력 검사는 모든 자연어 정보 유출을 판별하지 못합니다.

```sh
python3 "$runtime/work.py" public-text /absolute/path/PR.md
```

OKF·Graft·RRSI는 이미 있는 환경에서 선택적으로 연결하는 대상입니다. 이 패키지가 설치하거나 실행하지 않습니다. 역할과 확인할 조건은 [adapters.md](docs/adapters.md)를 참고하세요.

## 패키지 검사

배포 저장소에서 실행합니다.

```sh
python3 tests/run.py
```

검사는 임시 Git 저장소와 가짜 `gh`, 격리된 합성 이벤트를 사용합니다. 실제 Git 동작의 회귀 검사는 포함하지만 실제 Codex 훅 활성화, 사용자 신뢰 승인, GitHub PR 생성이나 호스팅된 Linux CI 성공을 증명하지 않습니다. 실행 결과와 실제 환경 확인은 구분해서 기록하세요.

## 출처와 라이선스

MIT 라이선스입니다. 새 코드는 Jade Wisemann의 [LICENSE](LICENSE)를 따릅니다. 포함한 `pstack-codex`는 [pstack](https://github.com/cursor/plugins/tree/9f451cf875ad1239912762f67741e8e5ba6ac0f1/pstack)의 비공식 파생 스킬이며 Lauren Tan의 MIT 고지를 [스킬 LICENSE](skills/pstack-codex/LICENSE)에 보존했습니다. 원본 기준과 포팅 범위는 [upstream.md](skills/pstack-codex/references/upstream.md)에 있습니다.
