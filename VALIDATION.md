# V1 validation — 2026-10-14

Status: local Windows engineering checks passed; real QQ/ZJU accounts await user-owned credential entry. No actual email or attachments were accessed for these checks.

Baseline: codefuturist/email-mcp `99ce431aa81dd4cafc2879bd35b6ee3acd0f2d74`. Before modification, upstream typecheck/build and all 150 unit tests passed. LGPL license/history/author retained.

Researcher V1: Node.js 24.15.0; Windows x64. Commands actually executed:

- `npm run typecheck`: passed, including retained upstream TypeScript.
- `npm run build`: passed.
- `npm run lint`: passed (new-module error-level checks; advisory style diagnostics are not acceptance errors).
- `npm test`: 35 passed, 25 unit + 10 loopback protocol/MCP integration tests.
- `npm audit --omit=dev --audit-level=high`: zero runtime dependency advisories at this check. Legacy development dependencies retain 10 advisories (1 low/3 moderate/6 high); no claim of vulnerability-free dependencies.
- `node scripts/stdio-smoke.mjs`: actual process handshake and exactly 9 read-only tools; no write tools.
- `powershell -NoProfile -File scripts/windows-credential.ps1 self-test`: random synthetic Credential Manager item written/read/verified and deleted; no true mailbox secrets read.
- legacy `node dist/main.js scheduler`: refused with READ_ONLY before queue processing.
- Codex registration: independent stdio entry added; all pre-existing TOML values compared and preserved; local backup retained. A client serializer's omitted empty args default was restored. Existing model/reasoning/context/MATLAB settings unchanged.

Coverage: UTF-8/GBK/GB18030, Base64/quoted-printable, nested MIME, text/HTML, duplicate attachment names, invalid mail dates, explicit truncation and large-message rejection; source ID/UIDVALIDITY/cursor invalidation; fixed paging while new mail arrives; Unicode search failure returning false and bounded fallback; finite connection retries; multi-account failure isolation; missing configured folders and local partial checkpoint/report persistence; full title RV association with original CSV unchanged.

Review scenarios: invitation vs review deadlines, R0/R1, extension history, conflicting dates, reminder then receipt, refusal/cancellation, cross-account duplicates, different manuscript IDs kept separate, ambiguous dates/timezones, quoted receipt exclusion, read/editor decision/local archive not treated as submission.

Safety scenarios: service-level direct IMAP writes and SMTP send refused; SMTP transport denied; old scheduler refused; future confirmed-draft interface refused; connection boundary forces read-only folder opens and blocks writes; malicious message returned only as untrusted data; mark_read rejected by MCP schema; raw reads used BODY.PEEK and EXAMINE; before/after sampled counts and flags identical; attachment storage uses hash/index, never MIME names; CSV formula protection and Markdown HTML escaping checked.

The loopback server is deliberately synthetic and does not validate all vendor-specific protocol behaviors, mailbox history, actual certificates, ZJU application-password eligibility, QQ account permissions or folder names. Real account validation remains pending. Linux CI is defined separately and should be checked on the PR; this local record does not claim a Linux run.

Public examples contain only example.invalid addresses and synthetic journals/manuscripts. No user account, mail, local paths, REVIEW_INDEX or report enters this repository. Inherited release/Docker/external-AI workflows are disabled; only the independent synthetic CI may run.
