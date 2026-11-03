# Oracle Recruiting Cloud application workflow

Local-first Playwright and React implementation of a four-phase job-application workflow. It currently uses JSON files for persistence and keeps the seams needed to replace them with Supabase PostgreSQL later.

## Implemented phases

- `src/phases/phase1-ingest-auth.js` - CSV ingestion, URL canonicalization, unique-link selection, email login, tenant-aware OTP retrieval, and per-user/tenant OTP locking.
- `src/phases/phase2-scan-normalize.js` - control discovery, conditional branch exploration, nested condition paths, repeatable group discovery, artifact capture, and versioned templates. The scanner has no Submit call path.
- `src/phases/phase3-answer-resolution.js` - one application per user/job, question-bank resolution, structured repeatable answers, unresolved required fields, and dashboard answer saves.
- `src/phases/phase4-apply-review-submit.js` - isolated browser session, user-specific filling, read-back results, review approval, and a separate typed job-ID submission gate.

The Oracle-specific implementation is isolated in `src/adapters/oracle/oracle-recruiting.js`. Mailbox matching is isolated in `src/adapters/mail`.

## Run locally

```bash
cp .env.example .env
npm install
npm run seed
npm run dev
```

Open `http://localhost:5173`. The server runs on `http://localhost:4100`.

Useful commands:

```bash
npm test
npm run ingest
npm run auth -- 20283127
# Or run auth directly on any Oracle URL:
npm run auth -- "https://eohh.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/428288" test@example.com
npm run scan -- 20283127
npm run resolve
npm run prepare:application -- APPLICATION_ID
```

`npm run scan` performs a real authorized login and sends an OTP. It captures sanitized runtime artifacts under `data/runtime/`, which is gitignored.

## Current pilot scope

- Verified against Oracle Recruiting Cloud job `20283127`.
- Verified with direct email login and a six-box OTP screen.
- Verified against Oracle-workflow sender variation through the supplied Zoho mail-reader endpoints.
- Verified nested Employee Referral conditions and repeatable Experience, Education, and Supporting Link groups.
- Verified that the discovered Submit button is detected but never clicked during scanning.

The next Oracle variant to add should be a genuinely multi-page application. The current scanner models page data, but the supplied pilot form exposes all sections and Submit on one application URL, so advancing through required multi-page forms has not yet been validated.

## Safety constraints

- Mail-reader calls stay on the server.
- Two OTP requests for the same candidate and tenant cannot run concurrently.
- Ambiguous OTP matches fail safely.
- Phase 4 cannot submit without verified fill results, approval, a live reviewed browser session, and exact job-ID confirmation.
- Do not expose the server publicly until authentication, authorization, encryption, and a secured mail-reader endpoint are added.
