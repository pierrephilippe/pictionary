---
name: pictiofady-maintainer
description: Maintain, debug, review, test, or document the PictioFady repository. Use for React/PWA UX, drawing or holographic projection, multiplayer room rules, WebSocket protocol, Cloudflare Worker/Durable Object, security, reliability, tests, Wrangler configuration, and project documentation. Do not use for generic questions unrelated to this repository.
---

# PictioFady Maintainer

Operate on this repository with minimal context while preserving its product, realtime, and security contracts.

## Start with a narrow pass

1. Run `git status --short` and preserve every pre-existing change.
2. Classify the request with the router below.
3. Read only the selected reference, then locate symbols with `rg -n` before opening code slices.
4. Prefer current code, schemas, configuration, and tests over prose when they disagree.
5. Expand to another reference only when the change crosses that boundary.

## Route context progressively

- For screens, copy, responsive behavior, accessibility, drawing controls, joining, QR codes, fullscreen, projection layouts, or visual QA, read [references/product-ux.md](references/product-ux.md).
- For domain rules, phases, roles, commands, snapshots, drawing synchronization, persistence, alarms, WebSockets, HTTP APIs, or security boundaries, read [references/architecture.md](references/architecture.md).
- For test selection, build commands, generated files, browser/device checks, CI, Wrangler, or delivery evidence, read [references/verification.md](references/verification.md).
- For a deep audit, consult only the relevant section of `docs/quality-audit.md` or `security_best_practices_report.md`; do not preload either report.

## Implement from the source of truth

- Trace one behavior end to end only as far as needed: UI event -> `ClientCommand` -> room authorization/mutation -> persisted snapshot or delta -> client reducer/render.
- Change shared contracts in `src/shared/protocol.ts` first, then adapt domain, server, client, and tests in the same task.
- Keep authoritative game decisions in `src/domain` and `src/server`; hidden or disabled React controls are never authorization.
- Keep local-only concerns such as draft settings, tool choice, projection preferences, and in-progress pointer state out of durable room state.
- Add or update the smallest regression test that would fail before the change.

## Verify proportionally

- From the repository root, run `.agents/skills/pictiofady-maintainer/scripts/verify.sh client|domain|server|protocol|docs|all`.
- Use a targeted scope while iterating. Run `all` or `npm run check` before handing off code, protocol, or configuration changes.
- Report the exact checks run and distinguish automated evidence from device-only validation.

## Keep this context useful

- Update only the reference whose durable contract changed.
- Put universal, always-relevant rules in root `AGENTS.md`; keep details here or in references so they load progressively.
- Avoid counts, line numbers, screenshots, transient findings, and copied implementation details that will become stale.
- Keep handoff concise: outcome, important files, checks, and any remaining manual validation.
