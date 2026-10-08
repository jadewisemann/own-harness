# own-harness

Codex 작업에 pstack의 조사·설계·구현·독립 검증 흐름과 로컬 Git·승인 검사를 연결합니다. 단일 Git 저장소와 여러 저장소를 담은 상위 폴더에 설치할 수 있습니다.

`pstack-codex`는 판단 절차를 안내하는 스킬입니다. Bun으로 실행하는 JavaScript runtime은 작업 계약, 단계 근거, 현재 파일·HEAD·index, 승인 상태를 검사합니다. 명시적으로 아이디어를 위임한 작업은 추가로 필수 브리프와 단계별 근거 파일을 검사합니다. 이 검사는 사고의 충분함, 제품 품질, 모든 파일 쓰기의 차단이나 OS 보안 격리를 보장하지 않습니다.

## 저장소 구조

문서와 배포 대상별 코드를 나눕니다. `packages/codex/`는 Codex용 설치본이며, `packages/omp/`는 작업 폴더·worktree 준비와 문서 인계를 담당하는 OMP 플러그인입니다. OMP 연결 방법과 서브에이전트 격리 경계는 [OMP 사용법](packages/omp/README.md)을 참고하세요. Codex 플러그인 형식과 별도 제어 화면·CLI는 설계 중입니다.

```text
own-harness/
├── AGENTS.md                 # 이 저장소의 작업 지침
├── DESIGN.md                 # 지속적 설계와 미확정 제안
├── README.md                 # 사용법과 저장소 안내
├── docs/                     # 공개 가능한 설명과 연결 경계
├── packages/
│   ├── omp/                  # OMP 작업 준비·인계 플러그인
│   └── codex/                # 현재 Codex용 설치본
│       ├── harness.js        # 설치·갱신·제거 진입점
│       ├── runtime/          # 실행 검사와 상태 처리
│       ├── skills/           # 함께 배포하는 스킬
│       ├── templates/        # 설치에 사용하는 지침 틀
│       └── tests/            # 해당 배포본의 검사
├── package.json              # 저장소 공통 Bun 요구 사항과 검사 명령
└── .github/workflows/        # 저장소 CI
```

로컬 작업 기록은 Git에서 제외되는 `work/<task>/`에 둡니다. WORK는 이번 작업의 범위와 진행 상황, HANDOFF는 인계 시점의 기록, `evidence/`는 실제 검증 근거를 담습니다. 설치된 `.harness/`의 실행 파일·통제 상태는 배포 소스와 구분합니다.

추가 배포 대상은 별도 제어 화면과 제어 CLI입니다. 새 대상은 `packages/<target>/`으로 분리하며, 공통 코드의 추출 기준과 미확정인 배포 형식은 [DESIGN.md](DESIGN.md)에 기록합니다. 모든 테스트는 저장소 루트에서 `bun test`로 실행할 수 있습니다.

## 외부 상태 스티어링

설치된 Codex 훅과 OMP 플러그인은 workspace 최상단의 `state.json`을 읽습니다. 프로젝트 → 작업 → 등록된 서브 workspace 순서로 합성하며, 하위에 명시한 항목만 덮어씁니다. 파일이나 키가 없으면 상위의 현재 값을 사용합니다. 상위 변경과 하위 키 삭제는 다음 훅부터 반영됩니다.

프로젝트의 `state.json` 예시:

```json
{
  "mode": "pstack-design",
  "control": "auto",
  "instruction": "기존 DESIGN.md와 작업 범위를 확인하고 진행한다."
}
```

작업의 `work/example-change/state.json`에 아래 내용만 쓰면 작업 방식과 추가 지침은 상속하고, 해당 작업의 변경 실행을 보류합니다.

```json
{"control": "human"}
```

- `mode`: `work`, `pstack`, `design`, `pstack-design`. 해당 방식의 지침을 전달하며 기존 단계·승인 검사는 유지합니다.
- `control`: `auto` 또는 `human`. `human`에서는 명시적으로 지원하는 읽기 전용 도구만 허용합니다. 셸 명령과 알 수 없는 도구는 보류합니다. `auto`가 commit·push·PR·배포 승인까지 만들지는 않습니다.
- `instruction`: 추가 지침 문자열. 하위 값이 상위 문장 전체를 교체합니다. 빈 문자열은 추가 지침을 비우고, 키 삭제는 상속으로 돌아갑니다.

Codex의 서브 상태는 `work/<task>/.sub-workspace/<name>/state.json`에 둡니다. 저장소 checkout 안의 동명 파일은 제어 파일로 탐색하지 않습니다. OMP의 임시 workspace 연결은 [OMP 사용법](packages/omp/README.md)을 따릅니다. 상태 파일은 사용자가 관리하며 설치·업데이트·제거로 덮어쓰거나 지우지 않습니다.

`null`, 알 수 없는 항목·값, 손상된 JSON, 심볼릭 링크와 특수 파일은 오류입니다. 오류 중에는 읽기 도구 외 실행을 보류합니다. 초기 상태는 외부 지정이 없는 상태이며 기존 동작을 유지합니다. 이미 실행 중인 명령을 중단하거나 변경을 되돌리는 기능은 없습니다. 네 방식의 개별 승인 체계와 별도 제어 화면·CLI는 후속 설계 범위입니다.

## CI와 배포 묶음

GitHub Actions는 push·PR·수동 실행마다 Linux와 macOS에서 전체 테스트를 실행합니다. 각 환경의 로그와 JUnit 결과를 14일간 보관하며, 두 환경이 모두 통과하면 해당 커밋의 Codex·OMP 코드와 문서를 `own-harness.tar.gz`로 묶고 SHA-256 파일을 함께 제공합니다. Actions 실행 화면에서 `own-harness-<커밋 SHA>` 아티팩트를 다운로드할 수 있습니다.

배포 묶음에는 로컬 `work/` 기록이나 설치 환경이 들어가지 않습니다. 이 묶음은 운영 환경 설치나 패키지 레지스트리 게시를 자동으로 수행하지 않습니다.

## 설치

대상 환경은 **Bun 1.4.2 이상, Git 2.31 이상, macOS·Linux의 POSIX 셸**입니다. 외부 npm 패키지는 필요하지 않습니다. PR 생성과 비공개 GitHub 전송 확인에는 인증된 `gh`가 필요합니다. Windows와 다른 에이전트·클라우드 훅 호환은 지원 범위에 포함하지 않습니다.

Bun이 없다면 [공식 설치 안내](https://bun.com/docs/installation)에 따라 설치한 뒤 `bun --version`으로 확인하세요.

Git 파일명은 UTF-8을 지원하며 해석할 수 없는 바이트가 있으면 검증을 거절합니다. runtime은 프로세스 간 `.lock.d` 디렉터리 잠금을 사용합니다. 강제 종료 후 잠금이 남으면 실행 중인 프로세스가 없는지 확인한 뒤 오류에 표시된 잠금만 제거하세요.

아래 경로와 작업 이름은 가상 예시입니다. 이미 Git 저장소가 있는 baseline 폴더에 설치하세요.

```sh
git clone https://github.com/jadewisemann/own-harness.git
cd own-harness
bun packages/codex/harness.js install /absolute/path/project
bun packages/codex/harness.js doctor /absolute/path/project
```

여러 저장소가 있는 상위 폴더는 저장소 이름과 상대 경로를 명시합니다. 상위 폴더 자체는 Git 저장소가 아니어도 됩니다.

```sh
bun packages/codex/harness.js install /absolute/path/workspace --repo api=repository/api --repo web=repository/web
bun packages/codex/harness.js doctor /absolute/path/workspace
```

설치기는 실행 파일을 대상의 `.harness/`에 복사합니다. 각 설치는 자기 runtime 사본을 사용하므로 배포 저장소의 checkout을 바꿔도 설치본이 곧바로 바뀌지 않습니다. 설정은 `.harness/config.json`에 저장됩니다. 기본 단일 저장소 매핑은 `{"schema":1,"repos":{"project":"."}}`입니다.

설치기는 baseline, 작업 폴더와 등록된 worktree에 다음 항목을 연결합니다.

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

아래는 Codex 설치본의 작업 순서입니다. 작업 하나를 폴더 하나로 관리합니다. 리드는 이 폴더에서 오케스트레이션하고, 실제 변경은 해당 레포 checkout에서 수행합니다. OMP의 `.sub-workspace` 내부 관리는 [OMP 사용법](packages/omp/README.md)을 따릅니다.

```text
workspace/
├── repository/
│   ├── api/                          # 기준 저장소
│   └── web/
└── work/
    └── example-change/
        ├── task.md                  # 작업 기록의 정본
        ├── api/                     # 통합 worktree
        ├── web/
        ├── evidence/
        └── .sub-workspace/          # 병렬 구현이 필요할 때 생성
            └── api-payment/         # 서브에이전트 workspace
                └── api/             # 서브에이전트 worktree
```

`task.md` 하나에 계약·단계 근거와 병렬 작업의 담당·범위·결과를 보관합니다. 이 문서에서 WORK는 그 기록의 역할을 뜻합니다. 별도의 `agents/`, 에이전트별 `TASK.md`·`RESULT.md`는 만들지 않습니다. `work/<task>`와 등록된 `.sub-workspace/<name>`에도 로컬 지침·스킬·훅이 연결됩니다. 이 폴더 자체는 제품 Git 저장소가 아니며 회사 공통 지식은 작업 폴더 밖의 기존 저장 위치를 참조합니다. 새 저장소 매핑 이름으로 `evidence`·`repos`는 대소문자와 관계없이 사용하지 않습니다.

설치한 뒤에는 **설치본**의 CLI를 사용합니다. 다음은 단일 저장소 예시입니다. 여러 저장소에서는 `--repo api`처럼 매핑 이름을 쓰고, 같은 작업에 필요한 저장소를 모두 등록한 뒤 계약을 확정합니다.

```sh
workspace=/absolute/path/project
runtime="$workspace/.harness/runtime"
task=example-change
checkout="$workspace/work/$task/project"
bun "$runtime/work.js" start "$task" --repo project --base origin/main --branch feat/example-change
```

`start`는 `work/<task>/<repo>`를 만들고 작업 폴더와 checkout의 로컬 설정을 준비한 뒤 WORK에 등록합니다. baseline의 미커밋 변경은 복사하지 않습니다. base는 로컬에서 해석 가능한 ref여야 하므로 필요하면 먼저 허용된 fetch로 갱신하세요. 제품 변경과 전달은 등록된 worktree에서 진행합니다.

1. `work/example-change/task.md`의 **작업 계약**에 목표·범위·완료 조건을 실제 요청으로 채웁니다. 같은 문서를 정본으로 유지합니다.
2. 조사로 실제 호출·데이터 흐름을 확인합니다. 설계에서 선택 이유, 대안, 의존 작업, 병렬 가능 작업, 공유 상태 분리 방법을 정합니다. 각 단계의 실제 근거 파일을 만든 뒤 차례로 기록합니다.

```sh
bun "$runtime/work.js" record "$task" research --evidence "@$workspace/work/$task/evidence/research.md"
bun "$runtime/work.js" record "$task" design --evidence "@$workspace/work/$task/evidence/design.md"
```

3. 허용된 변경을 구현하고 구현 근거를 기록합니다. 아래 파일 이름과 stage 대상은 예시이며 실제 변경에 맞춰 바꿉니다.

```sh
bun "$runtime/work.js" record "$task" implementation --evidence "@$workspace/work/$task/evidence/implementation.md"
git -C "$checkout" add -- src/example.js tests/example.test.js
```

4. stage한 상태에서 실제 검사와 독립 검토를 수행합니다. `verification.md`에 명령·결과·검토자·미확인 범위를 남긴 뒤 기록하고 전달 상태를 검사합니다.

```sh
bun "$runtime/work.js" record "$task" verification --evidence "@$workspace/work/$task/evidence/verification.md" --reviewer independent-reviewer
bun "$runtime/work.js" check --cwd "$checkout" --delivery
git -C "$checkout" commit -m "fix: handle example input"
```

5. commit으로 HEAD가 바뀌면 영향을 받는 검사를 다시 실행하고 새 상태의 근거를 기록합니다. 그 뒤 push합니다.

```sh
bun "$runtime/work.js" record "$task" verification --evidence "@$workspace/work/$task/evidence/verification-after-commit.md" --reviewer independent-reviewer
bun "$runtime/work.js" check --cwd "$checkout" --delivery
git -C "$checkout" push -u origin feat/example-change
```

`record`는 입력한 보고를 저장하며 테스트를 대신 실행하지 않습니다. 예시 파일을 만들었다는 이유로 통과를 기록하지 마세요. `snapshot`도 실제 상태만 갱신하며 검증을 대신하지 않습니다. 검증 뒤 코드·index·HEAD·WORK 본문·실행 정책이 바뀌면 필요한 근거를 다시 얻습니다. `commit -a`나 `--only`의 임시 index 대신 명시적으로 stage한 일반 index를 사용합니다.

이미 만든 worktree는 `work/<task>/<repo>` 구조와 Git 등록이 맞아야 합니다. `prepare`로 설치 상태를 연결하고 `init`으로 등록합니다. 경로 범위를 제한하려면 최초 `init` 때 `--scope`를 사용합니다.

```sh
existing_checkout="$workspace/work/another-task/project"
bun "$workspace/.harness/harness.js" prepare "$existing_checkout"
bun "$runtime/work.js" init another-task --cwd "$existing_checkout" --base origin/main --scope src --scope tests
```

## 필요한 경우에만 병렬 구현

읽기 전용 조사·리뷰는 기준 커밋을 정해 진행합니다. 동시에 코드를 수정할 때만 `fork`로 필요한 레포의 별도 worktree를 만들고, 현재 세션의 native subagent에게 그 경로와 범위를 전달합니다. CLI가 에이전트를 자동 실행하지는 않습니다. `research`·`design` 근거와 필요한 사용자 승인을 먼저 갖춰야 합니다.

```sh
bun "$runtime/work.js" fork "$task" api-payment --repo project --owner payment-builder --scope src/payment
bun "$runtime/work.js" status "$task"
```

생성 경로는 `work/<task>/.sub-workspace/api-payment/project`입니다. `api-payment`는 배정 이름이고 마지막 `project`는 `--repo`로 지정한 저장소 이름입니다. 작업용 통합 checkout의 깨끗한 현재 커밋에서 새 브랜치를 만들며, 미커밋 변경은 복사하지 않습니다. 한 checkout의 작성자는 한 명으로 유지합니다.

구현 담당자가 변경을 stage하고 실제 검사를 마친 뒤 작업 폴더의 `evidence/`에 결과 근거를 작성합니다. `result`는 이 폴더 안의 파일만 받으므로 worktree를 정리해도 근거가 남습니다. 결과는 현재 파일·index·HEAD·계약에 묶이며, 로컬 커밋 후에는 새 HEAD에서 필요한 검사를 다시 수행하고 결과를 다시 기록합니다.

```sh
bun "$runtime/work.js" result "$task" api-payment --evidence "@$workspace/work/$task/evidence/api-payment.md"
# 허용된 로컬 커밋과 새 HEAD 검사를 수행한 뒤 result를 다시 기록
bun "$runtime/work.js" integrate "$task" api-payment
bun "$runtime/work.js" clean "$task" api-payment
```

`integrate`는 검증 근거가 현재 상태와 맞는 깨끗한 worker 브랜치를 통합 checkout에 fast-forward로 반영합니다. 통합 브랜치가 앞서가 분기됐다면 worker에서 그 브랜치로 rebase하고 범위·검사 결과를 확인한 뒤 `result`를 다시 기록합니다. 충돌을 자동 해결하거나 실패를 통합 완료로 기록하지 않습니다.

`clean`은 이미 통합된 깨끗한 worktree만 제거하며 결과 기록과 브랜치는 유지합니다. 병렬 작업의 로컬 커밋 검사는 최종 전달 검사와 구분됩니다. worker에서 직접 push·PR을 생성할 수 없으며, 리드는 모든 결과를 통합한 뒤 `implementation`·독립 `verification`을 기록하고 여러 레포의 최종 조합을 검사합니다. worker 결과가 바뀌면 이전 전체 검증을 재사용할 수 없습니다.

통합된 결과는 당시 계약과 검사의 이력으로 남습니다. 이후 계약·설계를 바꾸면 현재 단계의 근거와 전체 검증을 다시 기록합니다. 과거 통합 기록을 새 설계의 검증으로 대신하지 않습니다.

## 아이디어를 맡기는 모드

사용자가 같은 Codex 채팅에서 다음처럼 **작업 ID와 아이디어를 포함한 메시지**를 직접 보내면 해당 작업에 위임 검사가 활성화됩니다. 작업 생성 전에도 보낼 수 있습니다.

```text
아이디어 위임 example-change 팀에서 쓸 간단한 작업 현황판을 만들어 줘
```

`UserPromptSubmit` 훅이 요청 원문과 세션·턴을 로컬 통제 기록에 저장합니다. 자연어의 모든 위임 표현을 자동 분류하지 않으며, 일반 작업에는 추가 검사를 적용하지 않습니다. 활성화된 작업에서는 `pstack-codex`를 읽고 다음 순서로 진행합니다.

1. `start` 또는 `init`으로 작업을 등록합니다. 이미 있는 작업이면 `bun "$runtime/work.js" brief "$task"`로 원본 아이디어를 확인하고 브리프 틀을 추가합니다.
2. WORK의 작업 계약(목표·범위·완료 조건)과 `## 위임 브리프`(대상 사용자·위임한 결정·제약·비목표)를 실제 요청으로 채웁니다. 필요한 정보만 질문하고, 사용자가 맡긴 결정은 그 범위에서 판단합니다.
3. 조사 → 설계 → 구현 → 검증 순서로 실제 근거 파일을 만들고 `record ... --evidence @파일`로 연결합니다. 검증에는 독립 검토자도 기록합니다.

브리프 누락·빈 항목·자리표시자·단계 누락·변경된 근거 파일은 단계/전달 검사에서 거절됩니다. 원본 위임 요청이나 브리프가 바뀌면 research부터 다시 기록해야 합니다. `작업 통제`와 `작업 이양`을 사용해도 위임 검사는 유지됩니다. 위임은 추가 실행 권한이나 PR 승인을 만들지 않습니다.

## 사람이 결정하는 모드

기본 `pstack` 모드는 현재 요청 범위에서 에이전트가 판단합니다. 사용자는 **같은 Codex 채팅에 직접** 다음 메시지를 보낼 수 있습니다.

| 사용자 메시지 | 효과 |
| --- | --- |
| `작업 통제 example-change` | human 모드로 전환. 조사·설계 기록은 허용하고, 현재 계약 승인 전 구현·검증 기록과 전달 검사를 막습니다. |
| `작업 이양 example-change` | 현재 요청·계약 범위에서 pstack 판단을 재개합니다. |
| `작업 승인 example-change <코드>` | human 모드에서 제시된 현재 계약만 승인합니다. |

human 모드에서는 에이전트가 `bun "$runtime/work.js" decision "$task"`로 계약과 코드를 보여 줍니다. 실제 사용자의 메시지를 `UserPromptSubmit` 훅이 수신해야 승인이 기록됩니다. 계약 변경 후에는 새 코드가 필요합니다. 하위 에이전트·합성 이벤트·승인 파일 편집으로 대신하지 않습니다. 통제 이양은 commit·push·PR·배포 권한을 새로 만들지 않습니다.

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
bun "$runtime/pr-guard.js" review /absolute/path/PR.md --cwd "$checkout" --base main
```

에이전트는 `PR.md`를 편집기로 열고 제목·본문 전체, head → base, HEAD, Draft 여부와 출력된 `PR 승인 <검토 코드>`를 보여 줍니다. 사용자가 같은 채팅에서 그 문구를 직접 보낸 뒤 아래 명령을 **단독 실행**하고 생성한 PR을 채팅에 연결합니다.

```sh
bun /absolute/path/project/.harness/runtime/pr-guard.js create
```

문서·HEAD·저장소·브랜치·base·Draft 상태가 바뀌거나 다른 요청이 들어오면 다시 review합니다. 실패 후 재시도 전에는 실제 PR 존재 여부를 조회합니다. 직접 `gh`·API·브라우저 생성이나 훅 이벤트 흉내로 우회하지 않습니다.

## 업데이트와 제거

새 배포본을 검토한 뒤 배포 저장소에서 실행합니다.

```sh
git pull --ff-only
bun packages/codex/harness.js update /absolute/path/project
bun packages/codex/harness.js doctor /absolute/path/project
```

업데이트는 최초 원본과 사용자 변경을 보존합니다. runtime·정책 변경으로 기존 근거와 PR 승인이 낡으면 다시 검증·승인해야 합니다. human 통제를 자동으로 이양하지 않습니다. 바뀐 훅 정의도 Codex에서 다시 검토하세요.

Python 설치본도 새 배포본의 `bun packages/codex/harness.js update`로 이전합니다. 관리 파일이 원래 설치 상태와 일치하는지 확인한 뒤 JS runtime과 Bun 훅으로 교체합니다. WORK·통제 기록은 보존하지만 실행 정책이 바뀌므로 기존 단계 근거와 승인은 다시 얻어야 합니다.

기존 `work/<task>/WORK.md`·`.harness/private/work/<task>/WORK.md`와 `work/<task>/repos/<repo>`·`work/<task>/.worktrees/<name>`·`.worktrees/<task>/<repo>`는 등록된 위치에서 계속 사용합니다. 업데이트가 기존 기록이나 Git worktree를 자동 이동하지 않습니다. 새 작업은 `task.md`와 직접 배치한 `<repo>/`를, 새 worker는 `.sub-workspace/<name>/<repo>`를 사용합니다. 같은 작업의 기록을 여러 위치에 중복 만들면 거절합니다.

사용을 끝내고 설치를 제거할 때만 다음 명령을 실행합니다.

```sh
bun packages/codex/harness.js uninstall /absolute/path/project
```

제거는 원래 Git 훅·설정과 관리 문서를 복구합니다. WORK·통제 기록·증거와 사용자 branch·worktree는 유지하며, 남은 로컬 기록을 보호하는 제외 규칙도 유지할 수 있습니다. 관리 파일에 사용자 변경이 있으면 충돌을 해결한 뒤 다시 실행하세요.

## 공개 패키지와 비공개 상태

공개 저장소에는 재사용 코드·스킬·템플릿·가상 예제만 둡니다. `work/<task>/`에는 WORK, 작업용 checkout, 병렬 worktree와 근거 파일이 들어갑니다. 설치본의 `.harness/private/`에는 통제·PR 승인과 설치 원본 정보가 들어갑니다. 이 상태와 실제 내부 경로·식별자는 공개 저장소, PR 본문, 외부 공유 문서에 복사하지 마세요. PR에는 문제·변경 동작·관련 검증 결과만 선별합니다.

알려진 내부 WORK/private 이력의 push는 **실제 push URL이 가리키는 GitHub 저장소의 `private=true`가 확인될 때만** 허용합니다. 다른 호스트나 확인할 수 없는 대상은 거절합니다. 일반 코드의 일반 Git 원격 전송은 이 제한과 구분합니다. 텍스트·이력 검사는 모든 자연어 정보 유출을 판별하지 못합니다.

```sh
bun "$runtime/work.js" public-text /absolute/path/PR.md
```

OKF·Graft·RRSI는 이미 있는 환경에서 선택적으로 연결하는 대상입니다. 이 패키지가 설치하거나 실행하지 않습니다. 역할과 확인할 조건은 [adapters.md](docs/adapters.md)를 참고하세요.

## 패키지 검사

배포 저장소에서 실행합니다.

```sh
bun test
```

검사는 임시 Git 저장소와 가짜 `gh`, 격리된 합성 이벤트를 사용합니다. 실제 Git 동작의 회귀 검사는 포함하지만 실제 Codex 훅 활성화, 사용자 신뢰 승인, GitHub PR 생성이나 호스팅된 Linux CI 성공을 증명하지 않습니다. 실행 결과와 실제 환경 확인은 구분해서 기록하세요.

## 출처와 라이선스

MIT 라이선스입니다. 새 코드는 Jade Wisemann의 [LICENSE](LICENSE)를 따릅니다. 포함한 `pstack-codex`는 [pstack](https://github.com/cursor/plugins/tree/9f451cf875ad1239912762f67741e8e5ba6ac0f1/pstack)의 비공식 파생 스킬이며 Lauren Tan의 MIT 고지를 [스킬 LICENSE](packages/codex/skills/pstack-codex/LICENSE)에 보존했습니다. 원본 기준과 포팅 범위는 [upstream.md](packages/codex/skills/pstack-codex/references/upstream.md)에 있습니다.
