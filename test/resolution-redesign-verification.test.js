import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';
import { CanonicalProfile } from '../src/domain/canonical-profile.js';

test('Verification: Client AWL-45416 on job_57 resolves options accurately with zero mismatches', async () => {
  const engine = new ResolutionEngine();

  const client = {
    client: {
      applywizz_id: 'AWL-45416',
      full_name: 'Abdullah Zubair Mohd',
      personal_email: 'code.zbr2@gmail.com',
      callable_phone: '+14143347435',
      salary_range: 'USD Yearly: 60k-80k, Hourly: 20-40',
      visa_type: 'Other',
      work_auth_details: 'Over 18: yes, Eligible in US: yes, Authorized w/o Visa: yes, Needs Sponsorship: no'
    },
    additional_information: {
      full_address: '1619 W Timber Ridge Ln, Oak Creek, WI, 53154, United States',
      highest_education: "Bachelor’s Degree",
      university_name: 'Osmania University',
      cumulative_gpa: '85%',
      role: 'Software Developer',
      alternate_job_roles: 'Java Developer,Software Engineer',
      gender: 'Male',
      is_hispanic_latino: 'Decline to Self-Identify',
      race_ethnicity: 'I don’t wish to answer',
      veteran_status: 'I am not a protected veteran',
      disability_status: 'No, I do not have a disability',
      is_over_18: true,
      eligible_to_work_in_us: true,
      require_future_sponsorship: false,
      willing_to_relocate: true,
      github_url: 'https://github.com/zbrabd',
      linked_in_url: 'https://linkedin.com/in/zubairabdullah214'
    }
  };

  // 1. Currency Dropdown: Must resolve to "US Dollar", NOT raw salary string
  const currencyRes = await engine.resolveField({
    field: {
      id: 'salary_expectation_in_local_currency',
      label: 'Salary Expectation in Local Currency',
      type: 'combobox',
      options: [
        'Euro',
        'Pound Sterling',
        'Irish Pound',
        'Indian Rupee',
        'UAE Dirham',
        'Australian Dollar',
        'Brazilian Real',
        'Canadian Dollar',
        'US Dollar',
        'Polish Zloty'
      ]
    },
    client
  });
  assert.equal(currencyRes.value, 'US Dollar');
  assert.equal(currencyRes.stage, 'stage3_domain');

  // 2. Total Compensation Range Bucket: Must resolve to "60,001 - 70,000", NOT raw salary string
  const compRes = await engine.resolveField({
    field: {
      id: 'please_select_your_total_compensation_expectations_including_base_and_bonus',
      label: 'Please select your total compensation expectations (including base and bonus).',
      type: 'combobox',
      options: [
        '0 - 10,000',
        '10,001 - 20,000',
        '20,001 - 30,000',
        '30,001 - 40,000',
        '40,001 - 50,000',
        '50,001 - 60,000',
        '60,001 - 70,000',
        '70,001 - 100,000',
        '100,001 - 125,000',
        '125,001 - 150,000'
      ]
    },
    client
  });
  assert.equal(compRes.value, '60,001 - 70,000');
  assert.equal(compRes.stage, 'stage3_domain');

  // 3. Salary Alignment Radio: Must resolve to "Yes", NOT raw salary string
  const alignRes = await engine.resolveField({
    field: {
      id: 'do_your_salary_expectations_align',
      label: 'Do your salary expectations align with the posted salary range?',
      type: 'radio',
      options: ['Yes', 'No']
    },
    client
  });
  assert.equal(alignRes.value, 'Yes');

  // 4. High School Diploma Radio: Must NOT be filled with university name
  const hsRes = await engine.resolveField({
    field: {
      id: 'high_school_diploma',
      label: 'Do you have a high school diploma or equivalent?',
      type: 'radio',
      options: ['Yes', 'No']
    },
    client
  });
  // Since client has Bachelor's degree, must resolve to Yes or null, never university name
  assert.notEqual(hsRes.value, 'Osmania University');
  assert.ok(hsRes.value === 'Yes' || hsRes.value === null);

  // 5. DEI Consent Radio: Must NOT be filled with Gender "Male"
  const deiRes = await engine.resolveField({
    field: {
      id: 'dei_acknowledgement',
      label: 'Diversity, Equity, Inclusion and Belonging: We are committed to an inclusive workplace...',
      type: 'radio',
      options: ['I hereby understand and acknowledge', 'I decline to acknowledge']
    },
    client
  });
  assert.notEqual(deiRes.value, 'Male');

  // 6. Referral Source Radio: "How did you hear about us?"
  const hearRes = await engine.resolveField({
    field: {
      id: 'how_did_you_hear',
      label: 'How did you hear about us?',
      type: 'radio',
      options: ['Agency/Search Firm', 'Blue Shield of California Career Website', 'Social Media', 'Other']
    },
    client
  });
  // "Social Media" matches best option instead of hardcoded unmatched "LinkedIn"
  assert.equal(hearRes.value, 'Social Media');

  // 7. Unknown Custom Screening Question: Must return null for operator review (Stage 5)
  const unknownRes = await engine.resolveField({
    field: {
      id: 'custom_pcaob',
      label: 'Have you ever been suspended or barred from being associated with any entity or issuer by the Public Company Accounting Oversight Board?',
      type: 'radio',
      options: ['Yes', 'No']
    },
    client
  });
  // Without past QB or LLM, it should cleanly fall to Stage 5 operator review
  assert.equal(unknownRes.value, null);
  assert.equal(unknownRes.stage, 'stage5_operator');
});

test('Verification: Zero ambiguous fallbacks when options cannot match', async () => {
  const engine = new ResolutionEngine();

  const client = {
    client: { full_name: 'Test Candidate' },
    additional_information: {}
  };

  const res = await engine.resolveField({
    field: {
      id: 'unknown_combobox',
      label: 'Select your preferred working shift',
      type: 'combobox',
      options: ['Morning (6am - 2pm)', 'Evening (2pm - 10pm)', 'Night (10pm - 6am)']
    },
    client
  });

  // Must be null, stage5_operator, never an arbitrary default
  assert.equal(res.value, null);
  assert.equal(res.stage, 'stage5_operator');
  assert.equal(res.confidence, 0);
});
