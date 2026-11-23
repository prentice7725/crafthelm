# Generic / Custom Host Adapter

특정 벤더 CLI에 종속되지 않고 임의의 AI IDE/채팅 세션(`host_native_session`) 또는 사용자 정의 단일 공급자 CLI(`--cli <command>`)를 연결하는 범용 어댑터입니다.

- **인세션 모드 (CLI 미지정):** 현재 대화를 이끄는 AI 호스트 세션이 그대로 Lead/Subagent 역할을 수행하고, CraftHelm의 결정적 CLI(`interview`, `contract`, `checkpoint`, `verify`, `review-package`, `approval`)가 증거·교열·승인 게이트를 강제합니다.
- **사용자 정의 CLI 모드 (`--cli <cmd>` 또는 `host_config.cli_command`):** 지정된 단일 CLI만 탐지/실행하며, 미설치 시 거짓 성공 없이 `UNAVAILABLE`을 반환합니다.
- 교열에는 `hosts/universal/skills/kouetsu/` 또는 대상 프로젝트 `.agents/skills/kouetsu/`를 사용합니다.
