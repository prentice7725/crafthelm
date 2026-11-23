# Waterfall Lifecycle

- `requirements`, `architecture`, `detailed_design`, `integration`, `human_acceptance` 단계마다 별도 승인 게이트를 둔다.
- `execution: "full"` 계약이라도 필수 단계 승인(`stage_approvals`) 없이는 다음 단계로 진행할 수 없다 (`APPROVAL_REQUIRED`).
- 단계 승인은 해당 단계 산출물 해시에 결합된다.
