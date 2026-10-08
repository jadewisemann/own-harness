# 출처와 포팅 범위

이 패키지는 공식 pstack 배포판이 아닌 Codex용 파생 스킬이다. 설명과 절차를 독립적으로 재작성했으며 원본 MIT 고지를 [LICENSE](../LICENSE)에 보존한다.

- 원본: [cursor/plugins의 pstack](https://github.com/cursor/plugins/tree/9f451cf875ad1239912762f67741e8e5ba6ac0f1/pstack).
- 분석 기준: commit `9f451cf875ad1239912762f67741e8e5ba6ac0f1`, plugin version `0.15.15`, 2026-10-07 확인.
- 흐름의 근거: 같은 commit의 `pstack/skills/poteto-mode/SKILL.md`, 그 아래 `playbooks/{investigation,bug-fix,feature,refactoring,perf-issue,eval,authoring-a-skill}.md`, `skills/{architect,arena,swarm,interrogate,how,why,show-me-your-work}/SKILL.md`.
- 24개 원칙의 대응: `references/principles.md`의 각 `principle-*` 제목은 같은 commit의 `pstack/skills/<제목>/SKILL.md`와 대응한다. 현재 upstream과 같다고 주장하지 않는다.

## 보존한 규칙

실제 흐름 조사, 데이터 모양 우선, 함수 경계를 넘는 두 설계, 독립 후보와 판정, 리드의 선택·검증 소유권, 실제 경로에서의 수정 전후 재현, 호출자 전체 확인, 상태 분리, 검증 단위, 재실행 가능한 증거를 보존했다. Arena의 후보 작성 종료 전 판정 금지와 합성 후 재검증도 유지했다.

## 의도적으로 바꾼 실행 방식

| 원본의 수단/정책 | 이 패키지의 선택과 경계 |
| --- | --- |
| Cursor `Task`, `poteto-agent`, 역할별 Claude/Grok 모델 | 현재 Codex 기본 도구와 부모 모델 상속. 같은 모델 독립 검토는 multi-model 합의가 아니다. 없는 공급자를 모사하거나 외부 CLI를 자동 실행하지 않는다. |
| 다수의 leaf skill과 playbook dispatch | 하나의 진입점과 작업별 참고 문서. 관련 경로·원칙만 읽어 불필요한 문맥을 줄인다. |
| Agent readonly/cloud/worktree 옵션 | 실제 노출 도구를 사용한다. 공유 파일 시스템에서는 별도 쓰기 경로나 단일 writer를 둔다. 프롬프트 계약을 보안 격리로 주장하지 않는다. |
| 기본 PR 열기, 넓은 external-action autonomy | 사용자가 허용한 범위와 현 checkout의 승인 규칙 우선. 조사에서 PR을 만들지 않으며 PR 요청도 병합 권한이 아니다. |
| 모든 playbook step을 그대로 todo에 복제 | 관찰 가능한 완료 조건과 네 항목 Checkpoint. 수행하지 못한 검증·독립성은 결과에 남긴다. |
| TSV decision log와 Cursor transcript 위치 | own-harness 설치 환경은 로컬 WORK를 사용하고, 스킬 단독 환경은 프로젝트의 기존 기록을 우선 재사용한다. 관례가 없으면 `work/<task>/plan.md`. 실제 증거와 현재 상태를 대조한다. |
| 기능별 global setup, 자동 모델 fallback | 전역 설정·모델 등록부·새 dependency가 없다. 거절·실패·누락을 밝히고 native 수행 범위 안에서 진행한다. |
| cloud fleet, Graphite/Origin stack 운영, watcher, 자동 wake-up | 이 버전에 구현하지 않았다. 기존 native 기능을 사용하려면 해당 사용자 요청·도구·승인 절차가 필요하다. 자동 병합 수단은 포함하지 않는다. |

이는 51개 원본 스킬·23개 playbook 전체의 호환 구현이 아니다. 핵심 엔지니어링 흐름과 24개 원칙을 보존한 지침형 스킬이다. 스킬 자체는 실행을 차단하지 않는다. own-harness의 별도 runtime은 작업 기록·Git 상태·승인 상태를 검사하지만 사고의 충분함이나 제품 품질을 보장하지 않는다. 두 구성 요소의 기능을 같다고 표현하지 않는다.

Codex 형식과 로컬 탐색은 [공식 Skills 문서](https://learn.chatgpt.com/docs/build-skills), native 위임의 역할·모델 상속은 [공식 Subagents 문서](https://learn.chatgpt.com/docs/agent-configuration/subagents)를 참고했다. 실제 호출 인자는 항상 현재 세션의 도구 schema를 따른다.
