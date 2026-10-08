## own-harness

- 같은 폴더에 `AGENTS.md`가 있으면 먼저 읽고 기존 지침을 따른다.
- 훅이 전달하는 현재 외부 상태를 따른다. `mode`가 `pstack`·`pstack-design`이거나 지정되지 않은 비단순 엔지니어링 작업은 로컬 `.agents/skills/pstack-codex/SKILL.md`를 읽는다. `design`·`pstack-design`은 프로젝트 DESIGN.md의 승인된 의도에 작업을 맞춘다. 실행 도구와 작업 기록의 사용법은 스킬의 `references/workspace.md`를 따른다. 작업 도구는 `{{HARNESS_ROOT}}/.harness/runtime/work.js`다.
- `state.json`은 사용자가 선택한 제어 상태다. 사용자의 변경 요청 없이 상태를 바꾸거나 차단 해제를 위해 수정하지 않는다. 모드 선택과 `auto` 상태가 기존 사용자 승인·단계·전달 검사를 대신하지 않는다.
- 시작에는 현재 요청·운영 규칙·해당 WORK만 읽는다. 도메인 문서·설계·지식은 조사 질문을 정한 뒤 필요한 부분만 읽고 현재 소스와 대조한다.
- 작업은 `work/<task>/task.md`와 같은 작업 폴더의 `<repo>` worktree를 기준으로 관리한다. 기준 저장소는 `repository/<repo>`에 매핑한다. 병렬 구현에만 `.sub-workspace/<name>/<repo>`를 만들고 부모 task.md에 담당·범위·결과를 기록한다. 기존 작업의 경로는 설치본 runtime의 판정을 따른다.
- 제품 변경과 전달은 등록된 worktree에서 한다. worker의 로컬 검사와 리드의 통합 검증을 구분하고 사용자 통제·PR 승인과 검증 기록을 우회하지 않는다.
- 실제 WORK·계약 기준점·통제 증빙·개인 경로 등 내부 메타데이터를 공개 저장소·PR 본문·외부 공유 문서로 복사하지 않는다.
