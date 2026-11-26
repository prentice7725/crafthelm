# Editorial Policy — Kouetsu Integration & Presentation Boundary

## 역할과 한계

- CraftHelm은 `prentice7725/kouetsu` v1.0.2 (MIT)의 내용(Content), 명확성(Clarity), 표면(Surface) 3계층 교열 규칙을 검토 보고서(`review-package.md`)에 적용한다.
- Kouetsu는 글꼴·여백·PDF 레이아웃 도구가 아니며, 코드 결함 부재나 사실 진위를 증명하지 않는다.
- 문서 교열 결과는 `reports/editorial-report.json`에 분리 기록하며, 교열을 실행하지 않았을 때는 `executed: false, status: "MISSING"`으로 기록한다.

## 교열 게이트

1. `kouetsu-check.mjs`는 미치환 자리표시자(`{{...}}`)나 금지 문구(`AI가 검증했다` 등)가 들어 있으면 보고서 발행을 차단한다.
2. `review-package.mjs`는 증거 매니페스트의 수용 기준 ID·상태·근거 링크가 보고서 본문과 어긋나거나 깨진 파일 링크가 있으면 `REVIEW_PACKAGE_VALIDATION_FAILED`로 발행을 차단한다.
3. 보고서의 핵심 결정·위험·승인 절에 `[확인 필요]` 또는 `[needs confirmation]` 표시가 남아 있으면 `review-package.mjs`가 체크포인트 상태를 `BLOCKED`로 바꾸고 인수 제출을 막는다.
4. 한국어·일본어·영어 표면 패턴(번역투 명사화, 빈 수식어, 표지판 표현, 부정 병렬 등)이 2회를 넘어 반복되면 `kouetsu-check.mjs`가 수정 대상으로 보고해 발행을 실패로 처리한다.
