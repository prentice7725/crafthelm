# TDD (Test-Driven Development)

- 새 기능(`feature`)과 버그 수정(`bugfix`)은 가능한 한 수정 전 실패 재현(RED), 통과 구현(GREEN), 정리(REFACTOR) 순서로 작업한다.
- 수정 전에 이미 통과하던 테스트는 새 기능의 유효성 증거로 인정하지 않는다.
- 리팩터링(`refactor`·`characterization_first`)은 변경 전 기준선 GREEN과 특성화 테스트 보존을 함께 검증한다.
- 재현이 어려운 간헐 장애는 관측 내용, 가설, 반증 계획을 적어 예외 사유로 남긴다.
