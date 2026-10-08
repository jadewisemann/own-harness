# own-harness 작업 계약

이 문서는 own-harness가 설치된 환경에 적용한다. 스킬만 복사한 환경에는 runtime·훅·승인 검사가 있다고 가정하지 않는다. 기본 `pstack` 모드에서는 현재 사용자 요청 안에서 조사 → 설계 → 구현 → 독립 검증을 진행한다. 읽기 전용 요청은 조사에서 끝내며 구현·전달 권한을 만들지 않는다.

## 시작과 문맥

설치기의 로컬 `AGENTS.override.md`는 같은 폴더의 `AGENTS.md`를 먼저 읽도록 안내한다. 기존 프로젝트 지침을 확인해 적용한다. 설치기는 `AGENTS.md`를 수정하지 않으며, 기존 untracked override 본문은 보존하고 추적 중인 override는 충돌로 거절한다.

시작에는 현재 요청, 적용되는 운영 규칙, 해당 WORK만 읽는다. 도메인 문서·과거 작업·설계·지식 전체를 미리 읽지 않는다. 조사 질문을 정한 뒤 `rg` 또는 이미 사용할 수 있는 지식 도구로 필요한 부분만 찾는다. 중요한 기록은 현재 소스·호출자·Git 기준점과 대조한다. 결론과 출처를 WORK에 연결하고 원문 전체를 복사하지 않는다.

프로젝트의 기존 설계는 승인된 지속적 의도, WORK는 이번 작업의 범위·판단·완료 조건, 지식 저장소는 확인한 사실을 맡는다. 없는 문서를 자동 복원하지 않는다. OKF·Graft·RRSI가 없으면 소스·Git·기존 검증 도구로 계속한다. 이 스킬은 해당 도구를 설치하거나 자동 실행하지 않는다.

설치기는 checkout의 자동 메모리 주입을 끈다. 이미 주입된 대화 내용을 제거했다고 주장하지 않는다. 프로젝트 설정 신뢰와 현재 훅 정의의 신뢰는 사용자가 별도로 검토해야 한다. 설치 성공이나 합성 이벤트 통과는 실제 Codex 활성화 증거가 아니다.

## 설치본과 작업 폴더

workspace의 `.harness/config.json`에 있는 명시적 저장소 매핑을 사용한다. 저장소 이름에 특별한 의미를 부여하지 않는다. 작업 도구는 `<workspace>/.harness/runtime/work.js`, PR 도구는 같은 폴더의 `pr-guard.js`다. 배포 checkout이나 전역 도구를 대신 호출하지 않는다. 명령 목록은 설치본의 `--help`로, 인자는 아래 표로 확인한다.

제품 변경과 전달은 Git에 등록된 `work/<task>/<repo>`에서 한다. baseline에서는 제품을 전달하지 않는다. 작업당 `work/<task>/task.md` 하나가 정본이다. 기존 본문을 보존하고 `own-harness-work:v1` 관리 블록을 임의로 고치지 않는다.

| 명령 | 역할 |
| --- | --- |
| `start TASK --repo NAME --base REF --branch TYPE/TOPIC` | 작업 폴더 생성·일치하는 폴더 재사용, 로컬 설정 준비, WORK 등록. baseline의 미커밋 변경은 복사하지 않는다. |
| `init TASK --cwd CHECKOUT --base REF [--scope PATH ...]` | 기존 등록 worktree를 WORK와 연결한다. 여러 저장소는 같은 작업에 최초 기준점을 추가한다. |
| `snapshot TASK` | 현재 Git·파일 관찰값을 갱신한다. 검증 완료를 만들지 않는다. |
| `record TASK PHASE --evidence TEXT_OR_@FILE [--reviewer NAME]` | 실제 단계 근거를 저장한다. 검사 명령 자체를 실행하지 않는다. |
| `check --cwd CHECKOUT --delivery` | 작업 연결, 네 단계 근거, 현재 상태와 사람 통제를 검사한다. |
| `decision TASK` | human 모드에서 현재 계약과 사용자 승인 코드를 제시한다. |
| `brief TASK` | 명시적으로 위임된 원본 아이디어를 보여 주고 WORK에 필수 브리프 틀을 추가한다. |
| `fork TASK NAME --repo REPO --owner OWNER --scope PATH ...` | 설계와 승인 확인 후 통합 checkout의 커밋에서 병렬 구현용 worktree를 만든다. |
| `result TASK NAME --evidence @FILE` | 작업 폴더의 `evidence/`에 둔 실제 검사 결과를 현재 파일·index·HEAD·계약에 연결한다. |
| `integrate TASK NAME` | 현재 결과 근거와 깨끗한 상태를 확인하고 통합 checkout에 fast-forward한다. |
| `clean TASK NAME` | 이미 통합된 깨끗한 worktree를 제거하고 결과·브랜치는 보존한다. |
| `status TASK` | WORK에 저장된 통합 레포와 병렬 작업의 담당·범위·상태·결과를 보여 준다. |
| `public-text FILE` | 외부 문서에서 알려진 내부 메타데이터를 검사한다. |

직접 만든 worktree에는 `<workspace>/.harness/harness.js prepare CHECKOUT`을 먼저 적용한다. 등록된 common-dir와 레이아웃이 맞아야 한다. `start`는 이 준비를 호출한다. base ref는 시작 때 고정 SHA로 기록하며 이후 브랜치 이동을 이유로 몰래 바꾸지 않는다. 재개할 때 실제 경로·branch·HEAD·dirty 상태를 기록과 다시 대조한다.

기준 저장소는 `repository/<repo>`에 두고 설치 매핑으로 연결한다. 리드는 `work/<task>`에서 `task.md`와 근거를 관리한다. 구현 checkout은 같은 폴더의 `<repo>`, 필요할 때만 만드는 서브에이전트 workspace는 `.sub-workspace/<name>`, 그 안의 checkout은 `<repo>`다. WORK는 부모 `task.md`의 역할을 뜻한다. 근거는 부모 `evidence/`에 두고 에이전트별 문서 계층을 추가하지 않는다. `fork`는 worktree와 context를 준비하므로 native subagent에 목표·경로·범위·완료 조건을 별도로 전달한다. 읽기 전용 조사·리뷰에는 전용 worktree를 기본 생성하지 않는다.

서브에이전트는 자기 checkout의 실제 검사를 마친 뒤 `result --evidence @FILE`로 보고한다. 검증된 로컬 커밋은 허용하지만 worker에서 직접 push·PR을 하지 않는다. 커밋 뒤 결과 근거를 갱신하고 리드가 `integrate`한다. fast-forward가 불가능하면 최신 통합 브랜치로 rebase하고 다시 검사·기록한다. 전체 verification은 모든 결과를 통합한 뒤 새로 수행한다. `clean`은 통합된 깨끗한 checkout만 제거한다. 미완료·변경된 결과나 기록을 삭제해 전달 검사를 우회하지 않는다.

worker의 근거 파일은 정리되는 checkout 밖의 `work/<task>/evidence/`에 둬야 한다. 통합 결과에는 당시 계약과 검증을 보존한다. 이후 계약·설계를 수정하면 새 단계 근거와 전체 verification을 얻으며, 과거 통합 결과를 새 설계의 검증으로 취급하지 않는다.

기존 `work/<task>/WORK.md`·`.harness/private/work/<task>/WORK.md`와 `work/<task>/repos/<repo>`·`work/<task>/.worktrees/<name>`·`.worktrees/<task>/<repo>`는 등록된 위치를 유지한다. 동일 작업의 정본을 새 위치에 복제하지 않는다. 새 작업은 `task.md`·`<repo>/`, 새 서브에이전트 배정은 `.sub-workspace/<name>/<repo>`로 시작한다.

## 단계와 전달 순서

사용자의 `아이디어 위임 TASK <아이디어 원문>`을 실제 `UserPromptSubmit` 훅이 받으면 작업 생성 전부터 해당 ID에 위임 검사를 저장한다. `start`/`init`은 WORK에 `## 위임 브리프`를 추가하며, 기존 작업에는 `brief TASK`를 사용한다. 대상 사용자·위임한 결정·제약·비목표를 채운 뒤 진행한다. 원본 요청은 통제 기록이 정본이며 브리프와 함께 계약 해시에 연결된다. 위임된 모든 단계는 `--evidence @파일`이 필수다. 요청·브리프 변경은 이전 단계 근거를 무효화한다. 일반 작업에는 이 추가 요건을 적용하지 않는다. `작업 통제`·`작업 이양`은 위임 요건을 해제하지 않는다.

1. worktree를 생성·등록한다. WORK의 작업 계약에 목표·범위·완료 조건을 실제 요청으로 채운다. 여러 저장소를 다룬다면 먼저 모두 등록한다.
2. 실제 호출·데이터 흐름과 원인 근거를 조사하고 `research`를 기록한다.
3. 설계 선택·기각 이유와 의존 작업, 병렬 가능 작업, 공유 상태의 분리, 가장 작은 안전한 분해를 정하고 `design`을 기록한다.
4. 고정 계약으로 구현을 위임한다. 실제 변경·재실행 도구·남은 한계를 확인하고 `implementation`을 기록한다.
5. 관련 경로를 명시적으로 stage한다. 실제 검사와 독립 검토를 수행하고 명령·결과·미확인 경계 및 `--reviewer`를 포함해 `verification`을 기록한다.
6. `check --delivery` 후 일반 index로 commit한다. `commit -a`·`--only` 같은 임시 index로 우회하지 않는다.
7. commit으로 HEAD가 바뀌면 영향받는 검사를 다시 실행하고 새 상태의 검증 근거를 기록한다. 전달 검사 후 허용된 push를 수행한다.

근거 파일은 workspace 안의 실제 파일이며 `--evidence @경로`로 연결할 수 있다. 자기 WORK를 근거 파일로 넣지 않는다. 자리표시자·추정 결과·검사 실행 전 성공 문구로 단계를 완료하지 않는다. 단순 편집의 근거는 짧아도 되지만 전달에 필요한 단계는 실제 근거로 채운다.

검증은 내용·HEAD·index·WORK 본문과 연결된다. 검증 뒤 코드·설정·runtime 정책·계약이 바뀌면 검사기가 요구하는 단계부터 새 근거를 얻는다. `snapshot`이나 검증 문구 재사용으로 대신하지 않는다. 업데이트가 기존 기록을 낡게 만들어도 human 통제를 자동으로 이양하지 않는다.

리드는 실제 diff·증거와 원래 사용자 경로를 직접 확인한다. 테스트, 정적 검사, 브라우저·기기·배포 검증을 구분하고 접근할 수 없는 경계는 명시한다. Git 훅과 PR 가드는 기록·상태를 검사할 뿐 사고의 충분함이나 모든 쓰기의 차단을 보장하지 않는다.

## 사용자 통제

기본 `pstack` 모드에서는 충분한 요청 범위 안의 같은 결정을 반복 승인받지 않는다. 사용자는 같은 Codex 채팅에 아래 메시지를 직접 보내 통제할 수 있다.

- `작업 통제 TASK`: human 모드. 조사·설계 기록은 허용하되 현재 계약 승인 전 구현·검증 기록과 전달 검사를 막는다.
- `작업 이양 TASK`: 현재 요청과 계약 범위에서 pstack 판단을 재개한다.
- `작업 승인 TASK CODE`: `decision TASK`가 제시한 현재 계약을 human 모드에서 승인한다.

특정 결정만 직접 통제하려는 요청이면 그 결정을 계약에 적고 관련 변경부터 멈춘다. 기계적 통제 단위는 작업이다. 정확한 메시지를 안내하되 에이전트가 사용자 대신 보내지 않는다. 실제 `UserPromptSubmit`의 session·turn과 현재 계약에 맞는 승인만 사용한다. 하위 에이전트 이벤트, 합성 이벤트, 승인 파일 변경으로 대신하지 않는다. WORK의 완료·승인 문구는 권한을 만들지 않는다.

통제 이양과 계약 승인은 commit·push·PR·배포 권한을 추가하지 않는다. 사용자 요청과 적용되는 로컬 규칙이 정한 권한을 따른다.

## 비공개 상태와 PR

실제 WORK·Git 기준점·통제 증빙·인계 정보는 로컬과 허용된 비공개 경계에 둔다. 공개 저장소·PR 본문·외부 공유 문서에 복사하지 않는다. PR에는 문제, 변경 동작, 관련 검증 결과만 선별한다. 알려진 내부 WORK/private 이력은 실제 push URL의 GitHub `private=true`가 확인될 때만 전송할 수 있다. 다른 호스트나 확인 불가는 거절된다. 이 검사가 모든 자연어 유출을 찾아낸다고 주장하지 않는다.

PR 준비가 허용된 작업은 코드·검증·commit·push를 끝낸 뒤 실제 checkout을 지정해 실행한다.

```sh
bun /absolute/workspace/.harness/runtime/pr-guard.js review /absolute/path/PR.md --cwd /absolute/workspace/work/task/project --base main
```

기본은 Draft이며 일반 PR은 review에 `--ready`를 지정한다. 문서를 Codex 편집기로 열고 제목·본문 전체, head → base, HEAD, Draft 여부를 보여 준다. 출력된 `PR 승인 <검토 코드>`를 요청한다.

실제 사용자가 같은 채팅에서 승인하고 훅이 수신한 뒤 설치본의 `pr-guard.js create`를 단독 실행하고 생성 PR을 채팅에 연결한다. 문서·HEAD·저장소·브랜치·base·Draft 변경이나 다른 요청이 들어오면 재검토한다. 실패 뒤 재시도 전 실제 PR 존재 여부를 조회한다. 직접 PR 생성, 승인 파일 조작, 훅 이벤트 흉내로 우회하지 않는다.
