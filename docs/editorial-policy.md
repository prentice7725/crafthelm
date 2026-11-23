# Editorial Policy — Kouetsu Integration & Presentation Boundary

## 역할과 한계

- `prentice7725/kouetsu` v1.0.2 (MIT)의 **Content → Clarity → Surface** 3계층 교열 규칙을 Review Package에 적용한다.
- Kouetsu는 글꼴·여백·PDF 레이아웃 도구가 아니며, 코드 결함 부재나 사실 진위를 증명하지 않는다.
- 문서 교열 결과는 `reports/editorial-report.json`에 분리 기록하며, 교열 미실행 시 `executed: false, status: "MISSING"`으로 정직하게 보고한다.

## 교열 게이트

1. 미치환 자리표시자(`{{...}}`) 또는 금지 문구(`AI가 검증했다`) 포함 시 차단.
2. Evidence Manifest의 AC ID·상태·근거 링크와 보고서 불일치 또는 깨진 파일 링크 존재 시 차단.
3. Critical `[확인 필요]` / `[needs confirmation]` 항목이 남아 있으면 체크포인트를 `BLOCKED`로 전환하고 인수 제출 차단.
4. 한국어/일본어/영어 표면 패턴(번역투 명사화, 빈 수식어, 표지판 표현, 부정 병렬 등)이 2회 초과 반복되면 수정 대상으로 보고.
