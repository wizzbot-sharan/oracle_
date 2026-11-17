import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';

test('Application Policy Engine - Declarative Knockouts & Safety Rules', async (t) => {
  const engine = new ResolutionEngine();

  const standardClient = {
    client: {
      full_name: 'Harish Tanniru',
      personal_email: 'harish.tanniru@example.com',
      callable_phone: '+1 408-555-0199',
      sponsorship: 'No',
      visa_type: 'US Citizen'
    },
    additional_information: {
      is_over_18: true,
      eligible_to_work_in_us: true,
      require_future_sponsorship: false,
      convicted_of_felony: false,
      worked_for_company_before: false,
      has_relatives_in_company: false
    }
  };

  const resumeWithOracle = `
HARISH TANNIRU
Software Engineer | harish.tanniru@example.com
SKILLS: Java, Spring Boot, Oracle Database, Microservices, AWS
EXPERIENCE:
Senior Engineer at Tech Corp
- Designed relational schemas on Oracle database.
  `;

  // 1. Age 18+ Knockout
  await t.test('ko_age_18_plus: matches exact Oracle option with typo', async () => {
    const res = await engine.resolveField({
      field: {
        id: 'age_18',
        label: 'Are you 18 years of age or Older? *',
        type: 'combobox',
        options: ['Yes, I am 18 or older', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'Yes, I am 18 or older');
    assert.equal(res.confidence, 1.0);
    assert.equal(res.source, 'stage1_policy');
    assert.equal(res.stage, 'stage1_taxonomy');
  });

  await t.test('ko_age_18_plus: radio matches Yes', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Are you over the age of 18?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'Yes');
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('ko_age_18_plus: checkbox returns true', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'I am at least 18 years of age',
        type: 'checkbox'
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, true);
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('ko_age_18_plus: candidate under 18 yields No', async () => {
    const minorClient = {
      ...standardClient,
      additional_information: { ...standardClient.additional_information, is_over_18: false }
    };
    const res = await engine.resolveField({
      field: {
        label: 'Are you at least 18 years of age?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: minorClient,
      skipLlm: true
    });
    assert.equal(res.value, 'No');
    assert.equal(res.source, 'stage1_policy');
  });

  // 2. Work Authorization Knockout & Sponsorship Isolation
  await t.test('ko_work_authorization: affirmative legal authorization', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Are you legally authorized to work in the United States?',
        type: 'combobox',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'Yes');
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('ko_work_authorization: candidate unauthorized yields No', async () => {
    const unauthClient = {
      ...standardClient,
      additional_information: { ...standardClient.additional_information, eligible_to_work_in_us: false }
    };
    const res = await engine.resolveField({
      field: {
        label: 'Are you legally authorized to work in the country to which you are applying?',
        type: 'combobox',
        options: ['Yes', 'No']
      },
      client: unauthClient,
      skipLlm: true
    });
    assert.equal(res.value, 'No');
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('Sponsorship isolation: sponsorship questions bypass ko_work_authorization', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Will you now or in the future require visa sponsorship for employment?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    // Must be resolved by candidate profile sponsorship logic, NOT ko_work_authorization policy!
    assert.equal(res.value, 'No');
    assert.notEqual(res.source, 'stage1_policy');
  });

  // 3. Criminal Convictions Knockout
  await t.test('ko_criminal_convictions: felony question resolves to No', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Have you ever been convicted of a felony or misdemeanor?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'No');
    assert.equal(res.source, 'stage1_policy');
  });

  // 4. Non-Compete & Restrictive Covenants Knockout
  await t.test('ko_non_compete_restrictions: resolves to No', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Are you subject to any employment agreements, including non-compete or post-employment restrictions?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'No');
    assert.equal(res.source, 'stage1_policy');
  });

  // 5. Background & Drug Screening Consents
  await t.test('ko_background_check_consent: checkbox consent returns true', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Are you willing to undergo a pre-employment background screening?',
        type: 'checkbox'
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, true);
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('ko_drug_screen_consent: combobox consent maps to Consent option', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Drug screening consent',
        type: 'combobox',
        options: ['Consent', 'Decline']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'Consent');
    assert.equal(res.source, 'stage1_policy');
  });

  // 6. Essential Job Functions Knockout
  await t.test('ko_essential_job_functions: affirmative ability', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Are you able to perform the essential functions of the job with or without reasonable accommodation?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'Yes');
    assert.equal(res.source, 'stage1_policy');
  });

  // 7. Government Debarment Knockout
  await t.test('ko_government_debarment: debarment resolves to No', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Have you been debarred, suspended, or proposed for debarment by any government agency?',
        type: 'combobox',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'No');
    assert.equal(res.source, 'stage1_policy');
  });

  // 8. Employee Referral Gate
  await t.test('ref_employee_referral_gate: referral question resolves to No', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Were you referred by a current employee?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'No');
    assert.equal(res.source, 'stage1_policy');
  });

  // 9. Conditional Follow-up Neutralizer
  await t.test('ref_conditional_followup_neutralizer: referral name follow-up resolves to N/A', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'If yes, name of the person that referred you:',
        type: 'text'
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'N/A');
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('ref_conditional_followup_neutralizer: "if other specify" resolves to N/A', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'If other source, please specify:',
        type: 'text'
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'N/A');
    assert.equal(res.source, 'stage1_policy');
  });

  // 10. Sourcing Channel
  await t.test('src_application_channel: social media platform resolves to LinkedIn', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Please specify social media platform:',
        type: 'combobox',
        options: ['LinkedIn', 'Facebook', 'Twitter / X', 'Other']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'LinkedIn');
    assert.equal(res.source, 'stage1_policy');
  });

  await t.test('src_application_channel: "how did you hear" combobox resolves to LinkedIn', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'How did you hear about this position?',
        type: 'combobox',
        options: ['LinkedIn', 'Company Website', 'Career site', 'Other']
      },
      client: standardClient,
      skipLlm: true
    });
    assert.equal(res.value, 'LinkedIn');
    assert.equal(res.source, 'stage1_policy');
  });

  // 11. Anti-Collision Guards
  await t.test('Collision guard: technical skill with "Oracle Database" is NOT answered No', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Do you have experience with Oracle Database?',
        type: 'radio',
        options: ['Yes', 'No']
      },
      client: standardClient,
      resumeText: resumeWithOracle,
      skipLlm: true
    });
    // Must NOT be rejected by non-compete or ex-employer rule!
    assert.equal(res.value, 'Yes');
    assert.notEqual(res.source, 'stage1_policy');
  });

  // 12. Strict Safety Abort on Option Mismatch
  await t.test('Strict Safety Abort: options mismatch safely aborts policy matching without guessing', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Are you 18 years of age or older?',
        type: 'combobox',
        options: ['Red', 'Blue', 'Green'] // Impossible options
      },
      client: standardClient,
      skipLlm: true
    });
    // Policy engine must NOT guess or force "Yes" when options do not match >= 80%
    assert.equal(res.value, null);
    assert.equal(res.stage, 'stage5_operator');
  });
});
