# Active Context: Oracle Recruiting Cloud Application Automation

## How to use this file

Read this file first when continuing this project in another chat. Treat it as the handoff source for product intent, verified behavior, architecture decisions, current implementation state, and next work. Inspect the referenced source files before changing behavior because this file records context and rationale, while the code remains authoritative for implementation details.

Last updated: 2026-11-04 (Asia/Kolkata).

## Objective

Build a locally testable, production-oriented system that automates authorized job applications on Oracle Recruiting Cloud for multiple users. The system must ingest user/job assignments, scan each unique job form once, normalize the form for a React dashboard, resolve answers from a multi-tier resolution engine (client profile, question bank, parsed resume), fill the real application for the correct user, stop for review, and submit only after explicit approval.

Expected production scale:

- Approximately 500 candidate profiles (`data/clients.json` populated with 179 active profiles, 731 KB).
- 988 job assignments in `data/oracle_jobs.csv` collapsing to ~150–200 unique job requisitions.
- Approximately 2,500-5,000 application instances in production.
- Concurrent Playwright workers in production, limited according to Railway memory measurements (capped at 3 workers locally with a 10s cooldown).
- Supabase PostgreSQL as the future database.
- Railway as the future deployment platform.
- Local JSON persistence during the pilot.

All users and test accounts are authorized for this workflow.

## Confirmed product decisions

- Every target site is Oracle Recruiting Cloud, although each company may use a different Oracle tenant and customized form.
- Use Playwright for browser automation.
- Every application requires email-based account access or login.
- OTP codes must be retrieved automatically from authorized mailbox data; no human OTP entry is planned.
- Browser actions require human-like pacing plus observable readiness checks.
- A dummy scanning user is allowed because scanning may save exploratory choices in Oracle candidate history.
- The scanner may select radio answers and open repeatable `+ Add` sections to reveal hidden fields.
- The scanner must never click Submit.
- The production application runner uses the correct user's email, answers, resume, and cover letter.
- The dashboard contains the final review and approval controls.
- Submission is an explicit, separate action after review.
- The current question bank is JSON. Later it becomes PostgreSQL data.
- User answers include structured data such as work history and education, not only strings.
- Production user records will eventually contain S3 resume links.
- Local testing uses synthetic PDF files.

## Four-phase workflow

### Phase 1: ingestion and authentication

Input is a CSV with:

```csv
user_id,job_id,job_url
```
(and production CSV `data/oracle_jobs.csv` with `company_name,job_url,score,client_name,applywizz_id`).

Responsibilities:

1. Validate every row.
2. Canonicalize Oracle URLs and remove tracking parameters.
3. Confirm the CSV job ID matches the URL job ID.
4. Preserve every `user_id + job_id` assignment.
5. Select unique canonical URLs for scanning.
6. Open the job and click Apply Now.
7. Switch from phone to email if Oracle presents that variant.
8. Type the email with human pacing.
9. Select only required authentication checkboxes.
10. Ignore hidden honeypot inputs.
11. Trigger OTP delivery.
12. Retrieve and verify the correct OTP email.
13. Enter either one OTP input or six single-digit inputs.
14. Continue to the application form.
15. **Skip handling**: If no Apply button exists (`NO_APPLY_BUTTON`) or candidate already applied (`ALREADY_APPLIED`), log and cleanly skip.

Two OTP requests for the same `candidateEmail + tenantHost` must be serialized because the messages may otherwise be indistinguishable.

Implementation: `src/phases/phase1-ingest-auth.js`.

### Phase 2: scan and normalize

Responsibilities:

1. Wait for the application page to stabilize.
2. Extract visible controls, labels, required state, accessible roles, source names, source IDs, options, and section information.
3. Ignore hidden inputs, honeypots, helper textareas, and profile-import controls that are not application questions.
4. Explore every direct radio option using controlled dummy answers.
5. Track nested trigger paths, for example:
   - `Opportunity source = Employee Referral`
   - `Were you referred by a current employee? = Yes`
   - employee number, department, and employee name become visible.
6. Open repeatable Experience, Education, and Supporting Link groups once.
7. Record their child fields and roll back the temporary row.
8. Save raw HTML and screenshot evidence separately from the normalized template.
9. Version the normalized template.
10. Detect Submit but never click it.

Implementation: `src/phases/phase2-scan-normalize.js` and `src/adapters/oracle/oracle-recruiting.js`.

### Phase 3: answer resolution and dashboard review

Responsibilities:

1. Create one application instance for every `user_id + job_id`.
2. Reuse the form template scanned once for the unique job.
3. Multi-tier resolution: pull answers across Tier 1 (Client Profile), Tier 2 (Question Bank), and Tier 3 (Parsed Resume).
4. Evaluate through the 5-stage matching cascade: Intent Taxonomy &rarr; Token-Sort Fuzzy &rarr; Semantic Synsets & Option Reducer &rarr; LLM Fallback &rarr; Dashboard Review.
5. Apply dynamic type coercion and best-match option ranking (`src/domain/coercion.js`).
6. Preserve answer source, confidence, and reviewed state.
7. Leave unknown required answers null.
8. Render all fields (both resolved and unresolved) in the React dashboard.
9. Render conditional fields dynamically when their parent values activate them.
10. Render repeatable groups as arrays of structured objects.
11. Save manually reviewed or edited answers to both the application instance and the user's question bank (Confidence 1.0).
12. Re-resolve previously null values when new question-bank or file values become available.

Implementation: `src/phases/phase3-answer-resolution.js` and `web/src/App.jsx`.

### Phase 4: fill, verify, review, and submit

Responsibilities:

1. Create an isolated Playwright browser context for one application (max 3 concurrent locally).
2. Log in using the correct user's real email.
3. Retrieve the OTP using the same tenant-aware process as Phase 1.
4. Fill simple and structured fields from the application values with dynamic live role detection and best-match option mapping.
5. Upload the correct user's files.
6. Add repeatable Experience and Education rows.
7. Read values back after filling and record per-field results.
8. Stop in `needs_review` state.
9. Require explicit review approval.
10. Require the operator to type the exact job ID.
11. Require the same live reviewed browser session.
12. Only then click Oracle Submit and store a receipt.

Implementation: `src/phases/phase4-apply-review-submit.js`.

Phase 4 has been implemented and guarded but has not been run through a complete real fill because the dummy question bank is intentionally incomplete. No application has been submitted.

## Verified Oracle pilot

Sample job:

```text
https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/20283127/?utm_medium=jobboard&utm_source=linkedin
```

Canonical job URL:

```text
https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/20283127
```

Pilot facts:

- Oracle tenant host: `egup.fa.us2.oraclecloud.com`.
- Tenant key: `egup`.
- Job ID: `20283127`.
- Job title observed: Industrial ML Software Engineer.
- Career site observed: Vertiv Careers.
- Authorized test email: `lokesh.matla@applywizard.ai`.
- Apply Now opened a direct email authentication screen.
- This tenant did not show the phone-to-email switch.
- This tenant did not show an authentication consent checkbox.
- The authentication page contained a hidden honeypot textbox.
- Oracle sent a six-digit OTP.
- The OTP UI used six separate single-digit textboxes.
- The observed OTP email expired after 10 minutes.
- Authentication and scanning were successfully executed using the local code.
- The application header claimed `step 1 of 4`, but every section and Submit appeared on one application URL.
- The scanner therefore treats visible navigation controls and Submit presence as authoritative rather than trusting the displayed step count.
- Version 4 of the live template is stored in `data/form-templates.json`.
- The latest live scan found 27 normalized fields, three conditional discoveries, and three repeatable groups.
- Submit was detected and never clicked.

The dummy Oracle application may retain exploratory radio choices because Oracle saves candidate form state. This is expected for the scanner account.

## Important form findings

Observed field families include:

- Text, email, telephone, URL, and textarea inputs.
- Custom Oracle radio pills.
- Native statutory radio inputs.
- Checkboxes and multi-checkbox groups.
- Oracle virtualized combobox grids.
- Compound phone number controls.
- Month/year controls.
- Resume and cover-letter file uploads.
- Repeatable Experience rows.
- Repeatable Education rows.
- Repeatable supporting links.
- Disability, veteran, diversity, job-alert, and e-signature fields.

Verified conditional paths:

1. `How did you come to know about this opportunity? = Other`
   - Reveals required `If Other Source, Please specify`.
2. `How did you come to know about this opportunity? = Employee Referral`
   - Reveals required `Were you referred by a current employee?`.
3. Employee Referral plus `Were you referred by a current employee? = Yes`
   - Reveals required employee number.
   - Reveals required employee department/function.
   - Reveals required employee name.

Selecting Yes for prior Vertiv employee, prior Vertiv contractor, and future visa assistance did not reveal extra fields on this job.

Oracle regenerates transient element IDs after form changes. Field identity therefore uses stable semantics such as source name, accessible label, role, and control type. Transient DOM IDs are selector candidates, not canonical field identities.

## Verified login & authentication variants

Reconnaissance across three live Oracle Recruiting Cloud variants (`eohh.fa.us2`, `hdjq.fa.us2`, `ibcjqy.fa.ocs`):
- **Phone vs. Email Toggle**:
  - In phone mode: inputs include `input[type="tel"][aria-label="Phone Number"]` and `#country-codes-dropdownphone-number`. The toggle button displays `"Do you want to communicate by email instead?"` (class `.quick-apply-flow-verify-method__button`).
  - In email mode: the toggle button displays `"Do you want to communicate by phone instead?"`.
  - The login adapter checks if phone mode or the switch-to-email button is visible, clicks it, and waits for `input[type="email"], input[name="primary-email"]`.
- **Cancel vs. Next Button Discrimination**:
  - Some tenants render textless icon-only Next buttons (`text: ""` with `aria-label="Next"` and class `apply-flow-pagination__button theme-color-1`).
  - Other tenants place Cancel and Next side-by-side sharing `.apply-flow-pagination__button`. Cancel has class `text-color-secondary`.
  - Next locator strictly excludes Cancel (`:not(.text-color-secondary):not(:has-text("Cancel"))`) and matches `theme-color-1`, `[aria-label="Next" i]`, or `[title="Next" i]`.
- **Visible Legal Disclaimer Checkboxes**:
  - Mandatory checkbox `#legal-disclaimer-checkbox` ("I agree with the terms and conditions") is checked only when visible. Hidden vendor/cookie checkboxes are ignored.
- **Human Pacing & Action Gaps**:
  - Keystroke delay: 50-200ms (`HUMAN_DELAY_MIN_MS`, `HUMAN_DELAY_MAX_MS`).
  - Action gap: 1000-2000ms delay between actions (`ACTION_GAP_MIN_MS`, `ACTION_GAP_MAX_MS`).
  - Post-Next wait: 3000-5000ms pause after clicking Next before checking OTP or handing to next phase (`POST_NEXT_WAIT_MIN_MS`, `POST_NEXT_WAIT_MAX_MS`).

Oracle virtualized comboboxes render only part of their option list at once. Exact option harvesting remains unfinished. The dashboard currently renders these as searchable/free-entry controls until the option collector is implemented.

## OTP mail behavior and matching policy

Mailbox reader base URL:

```text
https://zoho-mail-reader.onrender.com/api/zoho/ui
```

Available endpoints supplied by the user:

```text
GET /users
GET /inbox?email={EMAIL}&limit={LIMIT}&start={START}
GET /message?email={EMAIL}&accountId={ACCOUNT_ID}&folderId={FOLDER_ID}&messageId={MESSAGE_ID}
```

The OTP sender cannot be hard-coded. Messages may come from:

- `no-reply@oracle.com`.
- An Oracle Cloud workflow domain such as `*@workflow.email.*.ocs.oraclecloud.com`.
- A company-branded sender.

The matcher combines these signals:

- Exact candidate recipient.
- Message time relative to the login request.
- Subject intent such as Confirm Identity, Verify, Verification Code, One-Time Passcode, Security Code, or Access Code.
- Verification wording near a standalone six-digit number.
- Known Oracle sender family.
- Configured company sender domains.
- Exact Oracle tenant host found in email URLs or hosted assets.
- Tenant key found as a distinct sender/body token.

Ambiguous messages fail safely. OTP values are used in memory, are not logged, and are marked consumed per attempt.

Implementation:

- `src/adapters/mail/otp-matcher.js`
- `src/adapters/mail/zoho-mail-reader.js`
- `recon/otp-email-matching-policy.json`

Security warning: during the pilot, the supplied mail-reader endpoints returned inbox metadata and full message bodies without an authentication token. Keep these calls server-side. Add authentication and authorization before exposing the system publicly.

## Data model decisions

Do not duplicate the complete form DOM per user. Use three conceptual layers:

1. Form template per unique job/form version:
   - normalized fields;
   - conditions;
   - repeatable group schemas;
   - selectors and source metadata;
   - raw scan artifact references.
2. Application instance per `user_id + job_id`:
   - values;
   - answer source;
   - confidence;
   - review state;
   - fill results;
   - submission receipt.
3. Question bank per user:
   - reusable reviewed answers keyed by normalized field ID.

Raw HTML and screenshots exist for debugging evidence, not as the primary application data model.

Current local stores:

- `data/jobs.json`
- `data/clients.json` (179 candidate profiles, 731 KB)
- `data/oracle_jobs.csv` (988 rows across clients)
- `data/users.json` (legacy test users)
- `data/question-bank.json`
- `data/form-templates.json`
- `data/applications.json`
- `data/runs.json`

## Architecture and important files

Entry points:

- `src/server.js`: local JSON HTTP server used by the dashboard.
- `src/cli.js`: seed, ingest, scan, resolve, and prepare commands.
- `src/workflow.js`: dependency composition.
- `src/seed.js`: seeds the sample without overwriting a newer live template.

Phase modules:

- `src/phases/phase1-ingest-auth.js`
- `src/phases/phase2-scan-normalize.js`
- `src/phases/phase3-answer-resolution.js`
- `src/phases/phase4-apply-review-submit.js`

Adapters:

- `src/adapters/oracle/oracle-recruiting.js`
- `src/adapters/mail/otp-matcher.js`
- `src/adapters/mail/zoho-mail-reader.js`

Domain and storage:

- `src/domain/coercion.js` (Type coercion & Best-Match Option Selection)
- `src/domain/form-template.js`
- `src/storage/json-store.js`
- `src/storage/run-log.js`
- `src/shared/csv.js`
- `src/shared/url.js`
- `src/shared/locks.js`

Scripts:

- `scripts/fetch_clients.mjs`: Applywizz candidate fetcher, active reconciler, and pruner.

Dashboard:

- `web/src/App.jsx`
- `web/src/styles.css`
- `web/vite.config.js`

Documentation, reports, and reconnaissance:

- `README.md`
- `scaling_report.md`: comprehensive technical scaling report and roadmap.
- `docs/WORKFLOW.md`
- `recon/findings.md`
- `recon/job-20283127.form-template.json`
- `recon/section-1-accessibility.yml`
- `recon/control-metadata.json`
- `recon/experience-expanded.yml`
- `recon/education-expanded.yml`
- `recon/dashboard-smoke.png`

Synthetic files:

- `output/pdf/dummy-resume.pdf`
- `output/pdf/dummy-cover-letter.pdf`
- `scripts/generate_dummy_pdfs.py`

The module design intentionally places Oracle-specific behavior behind one adapter. The phase modules coordinate the workflow without depending on Oracle DOM details. JSON persistence can later be replaced with Supabase without rewriting the browser adapter.

## Current commands

Initial setup:

```bash
cp .env.example .env
npm install
npm run seed
npm run dev
```

Dashboard:

```text
http://localhost:5173
```

Server:

```text
http://localhost:4100
```

Useful commands:

```bash
# Full test suite (49 passing tests)
npm test

# Fetch & synchronize clients from Applywizz API
node scripts/fetch_clients.mjs

# Ingest target jobs
npm run ingest

npm run auth -- 20283127
# Or test auth directly on any Oracle URL without ingesting first:
npm run auth -- "https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594" your-email@example.com
npm run scan -- 20283127
npm run resolve
npm run prepare:application -- APPLICATION_ID
npm exec vite -- --config web/vite.config.js build
```

`npm run scan` performs a real login and sends an OTP. Run it only with an authorized test account.

The development server does not use Node watch mode because this environment hit an `EMFILE: too many open files` error while watching the dependency tree.

## Validation already completed

- Local dependency installation succeeds.
- Dependency audit reports zero known vulnerabilities.
- **49 automated unit tests pass, 0 failed** (`npm test`).
- Tests cover: CSV parsing, unsafe headers, URL normalization, Oracle-host validation, OTP extraction and scoring, ambiguous OTP rejection, form flattening, conditional visibility, `{ includes: '...' }` conditions, cx-select-pills toggling, single vs multi pill differentiation, ID-less checkbox fill, hidden radio label targeting, multi-checkbox isolation, dynamic combobox routing, submission review gates, Phase 1 skip edge cases (`NO_APPLY_BUTTON`, `ALREADY_APPLIED`), client fetching/reconciliation/pruning (`scripts/fetch_clients.mjs`), and dynamic field type coercion with best-match option selection (`src/domain/coercion.js`).
- The production React build succeeds.
- Local API health and dashboard endpoints succeed.
- Local Playwright Chromium launches outside the macOS sandbox.
- Live Phase 1 and Phase 2 execution succeeds.
- The React dashboard was visually inspected.
- Dashboard conditional behavior was interactively verified:
  - selecting Employee Referral reveals the referral question;
  - selecting Yes reveals employee number, department, and employee name.
- Synthetic PDFs were rendered and visually verified as one-page documents.
- No application was submitted.

## Safety invariants

Preserve these invariants in future changes:

- Scanner paths detect Submit and stop before it.
- Submission remains a separate Phase 4 method.
- Submission requires `reviewStatus = approved`.
- Submission requires every recorded fill result to be verified.
- Submission requires a live reviewed browser session.
- Submission requires exact typed job-ID confirmation.
- Mailbox calls remain server-side.
- OTP values do not appear in logs or persisted data.
- Candidate browser contexts do not share cookies or local storage.
- Candidate answers remain isolated by user ID and application ID.
- Raw DOM evidence is sanitized before long-term production storage.
- CAPTCHA and rate limits are respected rather than bypassed.
- Browser readiness is determined by observable conditions as well as pacing delays.

## Known gaps & Current Status

### Multi-page traversal

Phase 2 scanner now includes a multi-page walker that scans controls page by page, clicks the safe Next button to advance through steps, and stops immediately when Submit is visible (never clicking Submit).

### Repeatable group dynamic discovery and dashboard rendering

- Dashboard `RepeatableGroup` component updated to look up `field.children ?? field.fields ?? []`, ensuring expanded child rows (employer, title, dates, school, degree) render immediately upon clicking `+ Add`.
- Scanner `#scanRepeatableGroups` upgraded with generic discovery for arbitrary `+ Add` buttons (Certifications, Licenses, Skills, References, etc.) and automatic rollback cleanup.
- Custom styled Oracle checkboxes with `opacity: 0` / `.input-row__hidden-control` are now detected via visible wrapper/label queries.

### Virtualized combobox options

Oracle country, nationality, school, degree, veteran, gender, job family, and similar lists are virtualized. 
- Solution established: Dynamic Option Provider via live DOM inspection (`[role="option"]`, `[role="gridcell"]`) coupled with `src/domain/coercion.js` (`scoreOptionMatch` and `findBestOptionMatch`) to score and choose the closest candidate answer.

### Phase 4 live fill

Phase 4 is implemented with live role detection, pill/radio handling, and strict submission gates.
- Completion criterion: populate candidate answers via Phase 3 resolution, run Prepare, verify every filled value against Oracle, inspect the browser at review, and leave Submit untouched.

### Production persistence and worker queue

The current JsonStore is local. 3-worker concurrency queue locally (`src/phases/scan-queue.js`) with 10s cooldown. Later migrating to Supabase PostgreSQL + S3 on Railway.

---

## New Architectural Advancements & Scaling Specifications (Established 2026-11-04)

### 1. Phase 1 Skip Edge Case Handling
- **`NO_APPLY_BUTTON`**: When an Oracle job requisition has expired, closed, or does not render an Apply button within 25 seconds, the adapter cleanly skips the job without throwing an unhandled exception or breaking the scanner loop (`src/adapters/oracle/oracle-recruiting.js:148-156`).
- **`ALREADY_APPLIED`**: If candidate has already applied (detected either on the initial job page or within the 10s post-login settle window with message 'applied to this job'), the adapter returns `{ status: 'skipped', reason: 'already_applied' }` (`src/adapters/oracle/oracle-recruiting.js:353-362`).
- Both skip cases are verified via dedicated unit tests in `test/phase1-skip-edge-cases.test.js`.

### 2. Candidate Ingestion & Reconciliation (`scripts/fetch_clients.mjs`)
- Reads Applywizz API endpoints from `.env` (`ACTIVE_CLIENTS` & `GET_CLIENTS`).
- Captures both `client` and `additional_information` blocks.
- **Active Pruning**: Reconciles local `data/clients.json` against the active list, pruning clients who are no longer active.
- **Batched Upserts**: Fetches client profiles in batches of 5 with a 2-second rate-limiting cooldown.
- Populated `data/clients.json` with **179 real candidate profiles (731 KB)**.
- Verified via unit tests in `test/fetch-clients-sync.test.js`.

### 3. Dynamic Field Type Coercion & Best-Match Option Selection (`src/domain/coercion.js`)
- **Boolean Safety**: Solves JavaScript truthy string trap (`Boolean("No") === true`). Safely maps `"No"`, `"false"`, `0`, `"0"`, `"f"`, `"n"` to boolean `false`.
- **Dynamic Best-Match Option Ranking**:
  - `scoreOptionMatch`: 100 for exact match, 80 for substring containment, 60 * ratio for word token overlap.
  - `findBestOptionMatch`: Finds the highest-scoring option from live form choices.
- **Multi-Select & Radio Coercion**: Handles comma-separated strings (`"Java, Python, C++"`), JSON arrays, and single-choice mapping.
- **Visibility Equivalence**: In `src/domain/form-template.js`, conditional branches equate boolean `true` with `"Yes"` and `false` with `"No"`.
- Verified via 7 unit tests in `test/field-coercion.test.js`.

### 4. The 3 Data Source Tiers (Priority Order & Confidence Caps)

Incoming questions probe candidate data in a strict 3-tier hierarchy:

| Data Tier | Source | What It Contains | Confidence Cap |
|---|---|---|:---:|
| **Tier 1: Client Profile** | `data/clients.json` | Explicit personal data (`full_name`, `phone_number`, `address`, `email`, `highest_education`, `cumulative_gpa`, `work_auth_status`, `visa_type`, `eeo_*`). | **1.0 (Highest)** |
| **Tier 2: Question Bank** | `data/question-bank.json` | Historical bank of confirmed questions and answers previously approved by operators across past jobs. | **0.90 – 0.98** |
| **Tier 3: Parsed Resume** | Client's resume link / PDF / parsed text | Extracted employment history, education, skills, graduation dates, degree names, certifications. | **0.80 – 0.90** |

The final assigned confidence score respects the source ceiling:
$$\text{Final Confidence} = \min(\text{Stage Matching Score}, \text{Tier Confidence Cap})$$

### 5. The 5-Stage Matching Cascade & Similarity Threshold Levels

```
    [Form Question]
           │
           ▼
    [Stage 1: Regex & Intent Taxonomy] ──── Score ≥ 0.95 ───► AUTO-RESOLVE (High)
           │ Score < 0.95
           ▼
    [Stage 2: Token-Sort Fuzzy Match] ───── Score ≥ 0.85 ───► AUTO-RESOLVE (Medium-High)
           │ Score < 0.85
           ▼
    [Stage 3: Semantic Synset Overlap] ──── Score ≥ 0.78 ───► AUTO-RESOLVE (Medium)
           │ Score < 0.78
           ▼
    [Stage 4: LLM API Fallback] ─────────── Score ≥ 0.70 ───► AUTO-RESOLVE (Reasoned)
           │ Score < 0.70 / Disabled
           ▼
    [Stage 5: Dashboard Human Review] ──────────────────────► Flag as 'needs_input' (0.0)
```

#### Detailed Stage Breakdown:
1. **Stage 1: Intent & Regex Slug Taxonomy** (Score $\ge 0.95$): Auto-resolved immediately in 1ms (`WORK_AUTHORIZATION`, `VISA_SPONSORSHIP`, `CLEARANCE`, `GOVERNMENT_OFFICIAL`, `DISABILITY`, `VETERAN`, contact info).
2. **Stage 2: Token-Sort Fuzzy Match** (Levenshtein + Jaccard token overlap):
   - Score $\ge 0.85$: Auto-accept.
   - $0.75 \le \text{Score} < 0.85$: Conditional (verified if available dropdown/radio options also match cleanly via `findBestOptionMatch`).
   - Score $< 0.75$: Reject to Stage 3.
3. **Stage 3: Fast Semantic Synsets & Option Choice Reducer** (Score $\ge 0.78$): Auto-accept if semantic intent matches AND candidate answer maps cleanly to target options via `src/domain/coercion.js`. Score $< 0.78$ passes to Stage 4.
4. **Stage 4: LLM API Fallback** (Score $\ge 0.70$): Auto-accept reasoned JSON response for complex qualitative screening questions. Score $< 0.70$ passes to Stage 5.
5. **Stage 5: Dashboard Human Review** (Score $< 0.70$ or `null`): Flagged as `needs_input` for operator review.

### 6. Tier × Stage Execution Priority Matrix
Each tier is evaluated through the matching stages in strict priority order:
1. **Tier 1 (Client Profile)** is evaluated first through **Stage 1 ➔ Stage 2 ➔ Stage 3**. If a confident match is found $\to$ Auto-resolve (Cap: `1.0`).
2. **Tier 2 (Question Bank)** is evaluated next through **Stage 1 ➔ Stage 2 ➔ Stage 3**. If a confident match is found $\to$ Auto-resolve (Cap: `0.98`).
3. **Tier 3 (Resume)** is evaluated next through **Stage 1 ➔ Stage 2 ➔ Stage 3**. If a confident match is found $\to$ Auto-resolve (Cap: `0.90`).
4. **Stage 4 (LLM Fallback)** is invoked if all 3 tiers fail Stages 1–3, using combined candidate context.
5. **Stage 5 (Dashboard Review)** handles any remaining unresolved fields.

### 7. Dashboard Visibility & Bidirectional Feedback Policy
- **Comprehensive Question Visibility**: ALL questions—both auto-resolved (green) and unresolved (amber/red)—are rendered in the React dashboard for full operator visibility and auditability.
- **Live Operator Overrides**: Any field can be edited by an operator in the dashboard. Saving updates `data/applications.json` and immediately writes back the confirmed Q&A to `data/question-bank.json` with `Confidence: 1.0` (Human Verified).

### 8. Full Scaling Specification Reference
A complete, standalone architecture specification and workflow diagram report is maintained in `scaling_report.md`.

---

## Recommended next sequence

1. **Step 1: CSV Ingestion Update**:
   - Update `Phase1IngestAuth.prototype.ingestCsv` to accept `data/oracle_jobs.csv` headers (`applywizz_id`, `company_name`, `job_url`, `score`), automatically deduplicating the 988 rows into unique job links in `data/jobs.json`.
2. **Step 2: Client Profile Resolution Bridge & 5-Stage Cascade (Phase 3)**:
   - Update `Phase3AnswerResolution` to incorporate:
     - The 3-tier hierarchy (`clients.json` ➔ `question-bank.json` ➔ parsed resume).
     - The 5-stage matching cascade with score cutoffs (Taxonomy $\ge 0.95$, Fuzzy $\ge 0.85$, Semantic Option Reducer $\ge 0.78$, LLM $\ge 0.70$, Dashboard fallback).
     - Confidence capping by source tier ($\min(\text{Stage Score}, \text{Tier Cap})$).
3. **Step 3: 3-Worker Scanner Queue (`src/phases/scan-queue.js`)**:
   - Implement the FIFO queue orchestrator for Phase 2: cycles 3 dummy scanner emails, opens 3 browsers concurrently, and pauses 10 seconds per worker between jobs.
4. **Step 4: Dashboard Full Question Visibility & Filtering**:
   - Update `web/src/App.jsx` to render **all fields (resolved and unresolved)** for complete operator visibility and override control, alongside dropdown filters for **Client (`applywizz_id`)** and **Job (`jobId`)**.

## Instructions for a future chat

- Continue from the existing implementation; do not rebuild the repository from scratch.
- Read this file, `README.md`, `scaling_report.md`, and `docs/WORKFLOW.md` before changing workflow behavior.
- Run `npm test` before and after meaningful changes.
- Inspect `data/form-templates.json` before rescanning because a scan sends a real OTP and creates a new template version.
- Preserve user changes and the version-4 live template.
- Treat `data/runtime/` as disposable scan evidence; it is gitignored.
- Do not use a real candidate resume or answers for scanner exploration.
- Do not test Submit while developing scanning or filling.
