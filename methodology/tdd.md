# TDD (Test-Driven Development)

- 새 기능(`feature`) 및 버그수정(`bugfix`)은 가능한 한 RED 재현(수정 전 실패 증거) → GREEN 구현 → REFACTOR 순서를 따른다.
- 수정 전 이미 통과한 테스트는 새 기능의 유효성 입증으로 인정하지 않는다.
- 리팩터링(`refactor` / `characterization_first`)은 변경 전 기준선 GREEN과 특성화 테스트 보존을 검증한다.
- 재현 불가능한 간헐 장애는 관측·가설·반증 계획으로 예외 사유를 기록한다.
