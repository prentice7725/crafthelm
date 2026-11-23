# NOTICE — Kouetsu Universal Skill Package

- Upstream Repository: https://github.com/prentice7725/kouetsu
- Upstream Version: 1.0.2
- License: MIT (`Copyright (c) 2026 prentice7725`)

## Compatibility & Packaging Statement

This directory packages the MIT-licensed Kouetsu (`1.0.2`) Markdown instruction and language pattern references (`references/ko.md`, `references/ja.md`, `references/en.md`) as a host-agnostic skill package for Antigravity and generic/custom CraftHelm hosts.

- Upstream `prentice7725/kouetsu` (`v1.0.2`) contains Markdown/JSON instructions only and no executable scripts.
- CraftHelm verifies rule parity against the upstream `references/{ko,ja,en}.md` SHA-256 digest without invoking external provider CLIs.
- Kouetsu checks prose content, clarity, and surface patterns. It is not a visual layout/typesetting engine and does not verify code correctness or factual truth.
