# Oracle Recruiting Cloud reconnaissance: job 20283127

Scanned on 2026-11-02 with Playwright. The run stopped before Submit.

## Confirmed authentication behavior

- Apply Now opens an email authentication screen.
- This tenant did not show a phone/email switch or consent checkbox.
- The authentication form contains an accessibility-hidden honeypot textbox. It must never be populated.
- Oracle sends a `Confirm your identity` email containing a six-digit OTP that expires after 10 minutes.
- The OTP page uses six separate one-character textboxes.
- The supplied Zoho reader API successfully returned the new message and full HTML body.
- OTP matching must not rely on a fixed sender. Oracle messages may come from `oracle.com`, an Oracle Cloud workflow domain, or a company-configured sender.
- The matcher should correlate the job tenant host with URLs and Oracle-hosted assets in the email body, then combine that evidence with recipient, timing, subject intent, and OTP wording.

## Confirmed application behavior

- The application URL is `/apply/section/1`.
- The header says `step 1 of 4`, but the page contains all sections and a Submit button. Page traversal must therefore be based on visible navigation actions, not the header count.
- Stable Oracle `name` attributes exist for several standard fields, while custom question radio controls often have no stable name. Matching needs a selector cascade rather than a single selector strategy.
- Oracle custom comboboxes use virtualized grids. Only a subset of options exists in the DOM at once.
- Resume is required; cover letter is optional.
- Experience, education, and supporting URLs are repeatable groups.

## Conditional branches found

- `How did you come to know about this opportunity? = Employee Referral`
  - Reveals `Were you referred by a current employee?`.
  - Selecting Yes then reveals required employee number, department, and employee name fields.
- `How did you come to know about this opportunity? = Other`
  - Reveals required `If Other Source, Please specify` textarea.
- Selecting Yes for previous employee, previous contractor, and visa assistance did not reveal additional controls on this job.

## Saved artifacts

- `section-1-accessibility.yml`: initial accessible form tree.
- `control-metadata.json`: control-level HTML metadata with the email value redacted.
- `experience-expanded.yml`: fields revealed by Add Experience.
- `education-expanded.yml`: fields revealed by Add Education.
- `job-20283127.form-template.json`: first normalized form-template draft.
- `otp-email-matching-policy.json`: tenant-aware OTP email scoring and rejection rules.

Temporary experience and education editors were cancelled, and the temporary second supporting URL was removed. Submit was not clicked.
