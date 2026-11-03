# Oracle Recruiting Cloud application workflow

## Phase 1: ingest and authenticate

Input is a CSV containing `user_id`, `job_id`, and `job_url`. URLs are canonicalized before unique scan targets are selected. Authentication uses email and a tenant-aware OTP matcher. A lock prevents two simultaneous OTP requests for the same user and Oracle tenant.

Output:

- canonical job rows;
- unique scan targets;
- an authenticated browser session for each scan target;
- durable run events.

## Phase 2: scan and normalize

The scanner reads visible controls, explores direct radio branches, opens repeatable groups once, and records the form. It must never click Submit. Raw scan evidence and a normalized form template are stored separately.

Output:

- one versioned template per unique job form;
- conditions such as `visibleWhen`;
- repeatable group definitions;
- selector candidates and control types.

## Phase 3: resolve and review answers

One application instance is created per `user_id + job_id`. Fields are resolved against that user's question bank. Unknown or ambiguous fields remain null and are shown in the dashboard. Saving a reviewed answer updates both the application and that user's question bank.

Output:

- application values with source and confidence;
- an explicit unresolved-field list;
- reusable reviewed question-bank entries.

## Phase 4: fill, verify, review, submit

Each application runs in an isolated Playwright browser context. The runner authenticates as the correct user, fills values, reads them back, and stops at review. Submission is a separate action requiring `reviewStatus=approved` and a typed job-ID confirmation.

Output:

- field-by-field fill verification;
- review-ready state;
- submission receipt only after explicit approval.

## Production constraints

- Keep mailbox access server-side.
- Encrypt credentials, candidate data, and file URLs at rest.
- Serialize OTP requests by `candidateEmail + tenantHost`.
- Start with low browser concurrency and measure Railway memory.
- Persist browser run state so failed workers can resume safely.
