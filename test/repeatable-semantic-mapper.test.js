import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceToBoolean } from '../src/domain/coercion.js';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('coerceToBoolean treats negative phrases as false', () => {
  assert.equal(coerceToBoolean('I am not a protected veteran'), false);
  assert.equal(coerceToBoolean('No, I do not have a disability and have not had one in the past'), false);
  assert.equal(coerceToBoolean('Not Applicable'), false);
  assert.equal(coerceToBoolean('None'), false);
  assert.equal(coerceToBoolean('Never'), false);
  assert.equal(coerceToBoolean(false), false);
  assert.equal(coerceToBoolean('false'), false);

  assert.equal(coerceToBoolean(true), true);
  assert.equal(coerceToBoolean('true'), true);
  assert.equal(coerceToBoolean('Yes'), true);
  assert.equal(coerceToBoolean('Agree'), true);
});

test('ResolutionEngine resolves standalone veteran checkboxes to false for non-veteran candidates', async () => {
  const engine = new ResolutionEngine();
  const candidate = {
    client: { full_name: 'Test Candidate' },
    additional_information: {
      veteran_status: 'I am not a protected veteran',
      disability_status: 'No, I do not have a disability and have not had one in the past'
    }
  };

  const disabledVet = await engine.resolveField({
    field: { id: 'disabled_veteran', label: 'Disabled Veteran', type: 'checkbox' },
    client: candidate
  });
  assert.equal(disabledVet.value, false);

  const wartimeVet = await engine.resolveField({
    field: { id: 'active_duty_wartime_or_campaign_badge_veterans', label: 'Active Duty Wartime or Campaign Badge Veterans', type: 'checkbox' },
    client: candidate
  });
  assert.equal(wartimeVet.value, false);

  const separatedVet = await engine.resolveField({
    field: { id: 'recently_separated_veteran', label: 'Recently Separated Veteran', type: 'checkbox' },
    client: candidate
  });
  assert.equal(separatedVet.value, false);
});

test('OracleRecruitingAdapter extracts date parts accurately', () => {
  const adapter = new OracleRecruitingAdapter();

  assert.equal(adapter._extractDatePartForTest('01/2020', 'month'), 'January');
  assert.equal(adapter._extractDatePartForTest('01/2020', 'year'), '2020');
  assert.equal(adapter._extractDatePartForTest('11/2023', 'month'), 'November');
  assert.equal(adapter._extractDatePartForTest('11/2023', 'year'), '2023');
  assert.equal(adapter._extractDatePartForTest('Present', 'month'), 'November');
  assert.equal(adapter._extractDatePartForTest('Present', 'year'), '2026');
});

test('OracleRecruitingAdapter maps repeatable group child fields to candidate records', () => {
  const adapter = new OracleRecruitingAdapter();

  const expRecord = {
    title: 'Senior Software Engineer',
    company: 'Enterprise Cloud Corp',
    country: 'United States',
    city: 'New Haven',
    phone: '+1 555-0199',
    ok_to_contact_supervisor: 'Yes',
    leaving_reason: 'Relocation',
    startDate: '03/2021',
    endDate: 'Present',
    description: 'Designed and built distributed microservices.'
  };

  assert.equal(adapter._resolveChildAnswerForTest({ id: 'employer_name', label: 'Employer Name' }, expRecord), 'Enterprise Cloud Corp');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'country_code', label: 'Employer Country' }, expRecord), 'United States');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'employer_city', label: 'Employer City' }, expRecord), 'New Haven');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'employer_phone', label: 'Employer Phone' }, expRecord), '+1 555-0199');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'ok_to_contact_supervisor', label: 'OK to Contact Supervisor' }, expRecord), 'Yes');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'leaving_reason', label: 'Reason for Leaving' }, expRecord), 'Relocation');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'job_title', label: 'Job Title' }, expRecord), 'Senior Software Engineer');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'start_date', label: 'Start Date Month' }, expRecord), 'March');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'start_date_start_date_year', label: 'Start Date Year' }, expRecord), '2021');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'current_job', label: 'Current Job' }, expRecord), true);
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'responsibilities', label: 'Responsibilities' }, expRecord), 'Designed and built distributed microservices.');

  const eduRecord = {
    degree: "Master's Degree",
    institution: 'University of Texas at Dallas',
    fieldOfStudy: 'Computer Science',
    graduated: true,
    graduationYear: '2024'
  };

  assert.equal(adapter._resolveChildAnswerForTest({ id: 'educational_establishment', label: 'School' }, eduRecord), 'University of Texas at Dallas');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'content_item_id', label: 'Degree' }, eduRecord), "Master's Degree");
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'major', label: 'Major' }, eduRecord), 'Computer Science');
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'graduated', label: 'Graduated' }, eduRecord), true);
  assert.equal(adapter._resolveChildAnswerForTest({ id: 'graduation_year', label: 'Graduation Year' }, eduRecord), '2024');
});

test('ResolutionEngine resolves repeatable groups with bi-directional normalization', async () => {
  const engine = new ResolutionEngine();
  const candidate = {
    client: { full_name: 'Vadiraja Korlahalli' },
    additional_information: {
      role: 'Full Stack Engineer',
      alternate_job_roles: 'Java Developer, Cloud Architect',
      experience: '5',
      experience_records: [{
        title: 'Lead Developer',
        company: 'Innovative Tech',
        startDate: '06/2019',
        endDate: 'Present',
        description: 'Led cloud migration to AWS.'
      }],
      education_records: [{
        degree: "Master's Degree",
        institution: 'Purdue University',
        fieldOfStudy: 'Computer Engineering',
        graduationYear: '2019'
      }],
      linkedin_url: 'https://linkedin.com/in/vkorlahalli'
    }
  };

  const resumeText = 'Experienced in English communication. Built scalable AWS services.';

  // 1. Experience bi-directional keys
  const expRes = await engine.resolveField({
    field: { id: 'experience', label: 'Work Experience', type: 'repeatable-group' },
    client: candidate
  });
  assert.equal(Array.isArray(expRes.value), true);
  assert.equal(expRes.value[0].company, 'Innovative Tech');
  assert.equal(expRes.value[0].employer_name, 'Innovative Tech');
  assert.equal(expRes.value[0].job_title, 'Lead Developer');
  assert.equal(expRes.value[0].current_job, true);

  // 2. Education bi-directional keys
  const eduRes = await engine.resolveField({
    field: { id: 'education', label: 'Education', type: 'repeatable-group' },
    client: candidate
  });
  assert.equal(Array.isArray(eduRes.value), true);
  assert.equal(eduRes.value[0].institution, 'Purdue University');
  assert.equal(eduRes.value[0].educational_establishment, 'Purdue University');
  assert.equal(eduRes.value[0].content_item_id, "Master's Degree");
  assert.equal(eduRes.value[0].major, 'Computer Engineering');

  // 3. Technical Skills
  const skillRes = await engine.resolveField({
    field: { id: 'skill', label: 'Skill', type: 'repeatable-group' },
    client: candidate
  });
  assert.equal(Array.isArray(skillRes.value), true);
  assert.equal(skillRes.value[0].skills, 'Full Stack Engineer');
  assert.equal(skillRes.value[0].years_of_experience, '5');

  // 4. Languages require explicit candidate records and proficiency.
  const languageCandidate = structuredClone(candidate);
  languageCandidate.additional_information.language_records = [{ language: 'English', reading: 'High Proficiency' }];
  const langRes = await engine.resolveField({
    field: { id: 'language', label: 'Language', type: 'repeatable-group' },
    client: languageCandidate,
    resumeText
  });
  assert.equal(Array.isArray(langRes.value), true);
  assert.equal(langRes.value[0].content_item_id, 'English');
  assert.equal(langRes.value[0].reading, 'High Proficiency');

  // 5. Resume mention alone leaves language proficiency for operator review.
  const emptyLangRes = await engine.resolveField({
    field: { id: 'language', label: 'Language', type: 'repeatable-group' },
    client: candidate,
    resumeText: 'No languages mentioned here.'
  });
  assert.equal(emptyLangRes.value, null);
  assert.equal(emptyLangRes.stage, 'stage5_operator');

  // 6. Supporting Links
  const linksRes = await engine.resolveField({
    field: { id: 'supporting_links', label: 'Supporting Links', type: 'repeatable-group' },
    client: candidate
  });
  assert.equal(Array.isArray(linksRes.value), true);
  assert.equal(linksRes.value[0].site_link_2, 'https://linkedin.com/in/vkorlahalli');
});

test('OracleRecruitingAdapter repeatable group pre-check skips additions when cards are already present', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let addClicked = false;
  const mockPage = {
    evaluate: async () => [
      { title: "Bachelor's Degree", subtitle: 'Purdue University', isInvalid: false }
    ],
    locator: (selector) => ({
      count: async () => 1,
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => { addClicked = true; },
        scrollIntoViewIfNeeded: async () => {}
      })
    }),
    getByRole: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => { addClicked = true; }
      })
    })
  };

  const group = {
    id: 'education',
    label: 'education',
    addButton: 'ADD EDUCATION',
    children: [
      { id: 'content_item_id', label: 'Degree' },
      { id: 'major', label: 'Major' }
    ]
  };

  const rows = [
    { degree: "Master's Degree", major: 'Computer Science', institution: 'UT Dallas' }
  ];

  const result = await adapter._fillRepeatableGroupForTest(mockPage, group, rows);

  assert.equal(addClicked, false, 'Must NOT click Add button when cards are already present');
  assert.equal(result?.prefilled, true, 'Should mark prefilled as true');
});

test('OracleRecruitingAdapter repeatable group fills drawer when zero cards are detected', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let addClicked = false;
  let saveClicked = false;
  const filledFields = {};

  const makeLocator = (type) => ({
    count: async () => 1,
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {},
    pressSequentially: async (val) => { filledFields[type] = (filledFields[type] || '') + val; },
    inputValue: async () => filledFields[type] || '',
    click: async () => {
      if (type === 'add') addClicked = true;
      if (type === 'save') saveClicked = true;
    },
    fill: async (val) => { filledFields[type] = val; },
    waitFor: async () => {},
    filter: () => makeLocator(type),
    first: () => makeLocator(type)
  });

  const mockPage = {
    evaluate: async () => [], // Zero cards
    locator: (selector) => {
      if (selector.includes('drawer__save') || selector.includes('Save') || selector.includes('Done')) {
        return makeLocator('save');
      }
      if (selector.includes('apply-flow-drawer')) {
        return makeLocator('drawer');
      }
      return makeLocator('field');
    },
    getByRole: (role, opts) => {
      if (role === 'button') return makeLocator('add');
      return makeLocator('role');
    },
    getByLabel: (label) => makeLocator(label)
  };

  const group = {
    id: 'education',
    label: 'education',
    addButton: 'ADD EDUCATION',
    children: [
      { id: 'major', label: 'Major', type: 'text' }
    ]
  };

  const rows = [
    { degree: "Bachelor's Degree", major: 'Computer Science', institution: 'SCSVMV' }
  ];

  await adapter._fillRepeatableGroupForTest(mockPage, group, rows);

  assert.equal(addClicked, true, 'Must click Add button when 0 cards are detected');
  assert.equal(saveClicked, true, 'Must click Save button to close drawer');
});
