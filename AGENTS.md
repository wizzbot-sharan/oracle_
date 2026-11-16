# AGENTS.md — Oracle Recruiting Automation Rules of Engagement

This document governs the operational behavior, architectural boundaries, and safety protocols for AI assistants working in this repository.

---

## 1. Operating Modes & User Intent Guardrails

The agent must immediately determine the mode from the user's prompt and strictly adhere to its boundaries:

| Mode | Trigger Phrases | Allowed Actions | Forbidden Actions |
| :--- | :--- | :--- | :--- |
| **Diagnostic / Read-Only** | *"just tell"*, *"just check"*, *"why is this failing"*, *"get a report"* | Read files, execute read-only queries (`SELECT`), explain root causes. | **DO NOT modify any code, create new files, or run mutating SQL (`UPDATE`/`DELETE`/`INSERT`).** |
| **Planning Mode** | *"/plan"*, *"/grill-me"*, *"let's create a plan"* | Ask clarifying questions (one at a time), write an implementation plan artifact, await approval. | **DO NOT execute code changes until the user explicitly says "Proceed" or approves the plan.** |
| **Execution Mode** | *"proceed"*, *"implement"*, *"do it"*, *"fix it"* | Edit files, run migrations, run automated test suites, verify outcomes. | **DO NOT claim completion without running `npm test` and confirming 0 test failures.** |

---

## 2. Core Architecture: The 4-Phase Lifecycle

Never blur or mix the responsibilities of the 4 workflow phases:

```
Phase 1: Ingest & Auth
  └── Authenticates with candidate company_email + Zoho IMAP OTP polling.

Phase 2: Form Scanning & Normalization
  └── Multi-page Playwright crawler. Expands comboboxes, explores conditional branches (100ms Knockout settle).
  └── CRITICAL: Scanner NEVER clicks Submit and NEVER enters candidate identity.

Phase 3: Answer Resolution
  └── 3-Pillar Knowledge Triad:
        Pillar 1: Candidate CRM profile facts (clients.json)
        Pillar 2: Structured ATS resume (resume_parsed table)
        Pillar 3: Past approved Q&A memory (question_bank table)
  └── Tiers 1–3 resolve deterministically. Remaining questions go to Claude LLM candidate-level batching.
  └── CRITICAL: Scope Phase 3 strictly to newly scanned job keys, never sweep the entire historical database blindly.

Phase 4: Form Fill & Live Submission
  └── Deterministic DOM filler across 3 worker slots with 30-second global launch stagger.
  └── Fills repeatable drawers (Experience/Education) with clean drawer detach waits.
  └── Captures pre-submit visual audit screenshot on final review page.
  └── Clicks Submit, waits 10 seconds post-submit settlement, captures receipt screenshot.
  └── Records entry in applied_jobs table and updates applications table to status: 'submitted'.
```

---

## 3. Database & Timestamp Safety Rules (Non-Destructive)

1. **Non-Destructive Storage**:
   - Never run `DELETE`, `TRUNCATE`, or `DROP` on `applications`, `jobs`, `question_bank`, `resume_parsed`, or `applied_jobs`.
   - Historical runs must always remain intact for operator audits.
2. **Timestamp Preservation on Untouched Rows**:
   - In SQL upsert queries, **never** hardcode `updated_at = NOW()` on conflict across batch arrays.
   - Always use:
     ```sql
     updated_at = COALESCE(EXCLUDED.updated_at, applications.updated_at, NOW())
     ```
   - Untouched rows during state updates must preserve their existing `updated_at` so date filters remain accurate.
3. **IST Timezone Standard**:
   - PostgreSQL stores raw UTC (`TIMESTAMPTZ`).
   - All operator dashboard views, date filters (`Today`, `Yesterday`, `All Time`), and displayed timestamps must be converted and sorted in **Indian Standard Time (IST, UTC+05:30)** using `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`.

---

## 4. LLM & Anthropic Token Conservation

1. **Disable Thinking for Structured ATS Extractions**:
   - When calling Claude (`claude-haiku-5-5` or `claude-3-5-haiku`) for structured JSON resume parsing, always pass `thinking: { type: 'disabled' }`. This frees 2,500+ tokens for JSON output and prevents output truncation errors.
2. **Pillar 2 Signal Density**:
   - Never dump raw 15KB JSON into Claude prompts. Use `#buildStructuredResumeSummary` to send high-density summaries (skills array, domains, title, degree, and top 3 highlights per role).
3. **Pacing & Backoff**:
   - Enforce minimum 1.5s delay between candidate batch calls with exponential backoff on HTTP 429/529.

---

## 5. Verification & Completion Protocol

Before declaring any implementation complete:
1. Run `npm test` and verify that all unit/integration tests pass with **0 failures**.
2. If web frontend code changed (`web/src/`), run `npm run build` to confirm the Vite bundle compiles cleanly.
3. If database schema changed, verify the migration with `node scripts/run-migration.js` and query the schema to confirm constraints.
4. Report exact test pass counts and verify live behavior.

---

## 6. Communication Style

- Keep responses **concise, technical, and direct**.
- When explaining findings, use structured bullet points and markdown tables.
- Always link directly to relevant source files and line ranges using standard markdown links (e.g. `[server.js](file:///Users/sharan/Desktop/oracle/src/server.js#L250-L260)`).
