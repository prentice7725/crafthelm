# Waterfall Lifecycle

- `requirements`, `architecture`, `detailed_design`, `integration`, `human_acceptance` 단계마다 별도 승인 게이트를 둔다.
- `execution: "full"` 계약이라도 필수 단계 승인(`stage_approvals`) 없이는 다음 단계로 넘어가지 못한다(`APPROVAL_REQUIRED`).
- 단계 승인은 해당 단계 산출물의 해시에 묶인다.
