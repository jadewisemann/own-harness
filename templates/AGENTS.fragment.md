## own-harness

- 같은 폴더에 `AGENTS.md`가 있으면 먼저 읽고 기존 지침을 따른다.
- 비단순 엔지니어링 작업은 로컬 `.agents/skills/pstack-codex/SKILL.md`를 읽고 진행한다. 설치된 실행 도구와 작업 기록은 스킬의 `references/workspace.md`를 따른다. 작업 도구는 `{{HARNESS_ROOT}}/.harness/runtime/work.py`다.
- 시작에는 현재 요청·운영 규칙·해당 WORK만 읽는다. 도메인 문서·설계·지식은 조사 질문을 정한 뒤 필요한 부분만 읽고 현재 소스와 대조한다.
- 제품 변경과 전달은 등록된 worktree에서 한다. 사용자 통제·PR 승인과 검증 기록을 우회하지 않는다.
- 실제 WORK·계약 기준점·통제 증빙·개인 경로 등 내부 메타데이터를 공개 저장소·PR 본문·외부 공유 문서로 복사하지 않는다.
