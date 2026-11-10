import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';

test('ResolutionEngine handles dynamic intent taxonomy without hardcoded fallbacks', async () => {
  const engine = new ResolutionEngine();

  const candidate = {
    client: {
      full_name: 'Sai Kiran Akula',
      first_name: 'Sai Kiran',
      last_name: 'Akula',
      personal_email: 'saikiran.akula@example.com',
      callable_phone: '+1 214 555 0199',
      salary_range: 'USD Yearly: 100k-130k'
    },
    additional_information: {
      full_address: '15295 Salano Creek Drive, Stonelake Estates West, Frisco, Texas, 75035, United States',
      location: 'Frisco, Texas, United States',
      state_of_residence: 'Texas',
      is_hispanic_latino: 'No',
      gender: 'Male',
      race_ethnicity: 'Asian',
      veteran_status: 'I am not a protected veteran',
      disability_status: 'No, I do not have a disability and have not had one in the past',
      eligible_to_work_in_us: true,
      requires_sponsorship: false,
      linkedin_url: 'https://www.linkedin.com/in/saikiran-akula',
      github_url: 'https://github.com/saikiran-akula',
      education_records: [{ degree: "Master's Degree", institution: "University of Texas at Dallas" }],
      experience_records: [{ title: 'Software Engineer', company: 'Enterprise Corp' }]
    }
  };

  const resumeText = `
    SAI KIRAN AKULA
    Software Engineer with expertise in building scalable distributed systems and event-driven architectures.
    Proficient in Java, Python, and Object-Oriented Design (OOP) principles.
    Extensive experience developing REST APIs and microservices using Spring Boot and Docker on AWS.
  `;

  // 1. Identity & Contact
  const fnameRes = await engine.resolveField({ field: { label: 'Legal First Name', type: 'text' }, client: candidate });
  assert.equal(fnameRes.value, 'Sai Kiran');
  assert.equal(fnameRes.confidence, 1.0);

  const emailRes = await engine.resolveField({ field: { label: 'Primary Email Address', type: 'email' }, client: candidate });
  assert.equal(emailRes.value, 'saikiran.akula@example.com');

  // 2. Location & Address (Fixing duplication and substring cross-talk)
  const cityRes = await engine.resolveField({ field: { label: 'City *', type: 'combobox' }, client: candidate });
  assert.equal(cityRes.value, 'Frisco');

  const stateRes = await engine.resolveField({ field: { label: 'State *', type: 'combobox' }, client: candidate });
  assert.equal(stateRes.value, 'Texas');

  const zipRes = await engine.resolveField({ field: { label: 'ZIP Code *', type: 'text' }, client: candidate });
  assert.equal(zipRes.value, '75035');

  const streetRes = await engine.resolveField({ field: { label: 'Address Line 1 *', type: 'text' }, client: candidate });
  assert.equal(streetRes.value, '15295 Salano Creek Drive');

  // 3. Substring bug fix: "ethnicity" must NOT match "city"!
  const raceRes = await engine.resolveField({ field: { label: 'visually identified ethnicity or race', type: 'combobox' }, client: candidate });
  assert.notEqual(raceRes.value, 'Texas');
  assert.notEqual(raceRes.value, 'Frisco');
  assert.equal(raceRes.value, 'Asian');

  // 4. Truthiness bug fix: Hispanic/Latino "No" must resolve to false / "No"
  const hispCheckbox = await engine.resolveField({ field: { label: 'I am Hispanic or Latino.', type: 'checkbox' }, client: candidate });
  assert.equal(hispCheckbox.value, false);

  const hispRadio = await engine.resolveField({ field: { label: 'Are you Hispanic or Latino?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(hispRadio.value, 'No');

  // 5. Work Auth & Sponsorship
  const sponsorRes = await engine.resolveField({ field: { label: 'Will you now or in the future require visa sponsorship for employment?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(sponsorRes.value, 'No');

  const legalAuthRes = await engine.resolveField({ field: { label: 'Are you legally authorized to work in the country where the job is posted?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(legalAuthRes.value, 'Yes');

  // 6. Dynamic Technical Screening (Zero-Cost Resume Regex)
  const oopRes = await engine.resolveField({ field: { label: 'Do you have experience with object-oriented design and programming?', type: 'radio', options: ['Yes', 'No'] }, client: candidate, resumeText });
  assert.equal(oopRes.value, 'Yes');

  const microservicesRes = await engine.resolveField({ field: { label: 'Do you have experience designing and developing microservices?', type: 'radio', options: ['Yes', 'No'] }, client: candidate, resumeText });
  assert.equal(microservicesRes.value, 'Yes');

  const distRes = await engine.resolveField({ field: { label: 'Have you worked on building scalable distributed systems?', type: 'radio', options: ['Yes', 'No'] }, client: candidate, resumeText });
  assert.equal(distRes.value, 'Yes');

  // 7. Repeatable Groups
  const expRes = await engine.resolveField({ field: { label: 'Work Experience', type: 'repeatable-group' }, client: candidate });
  assert.equal(Array.isArray(expRes.value), true);
  assert.equal(expRes.value.length, 1);
  assert.equal(expRes.value[0].company, 'Enterprise Corp');

  // 8. Communications Consent
  const consentRes = await engine.resolveField({ field: { label: 'I agree to receive updates about new job opportunities.', type: 'checkbox' }, client: candidate });
  assert.equal(consentRes.value, true);

  // 9. Disclosures & Corporate Compliance (Family 5)
  // Prior Employment
  const wspEmp = await engine.resolveField({ field: { label: 'Have you ever been employed by WSP USA or any entity of WSP Global to your knowledge?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(wspEmp.value, 'No');

  const hexEmp = await engine.resolveField({ field: { label: 'Have you previously worked at Hexaware in any capacity?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(hexEmp.value, 'No');

  const fhEmp = await engine.resolveField({ field: { label: "Have you ever been employed with First Horizon bank, First Tennessee bank, or First Horizon National Corporation or any of its subsidiaries? If yes, list the dates of your previous employment and any other names used while employed. Otherwise, enter 'Not Applicable'.", type: 'textarea' }, client: candidate });
  assert.equal(fhEmp.value, 'Not Applicable');

  // Relatives at Company
  const hexRel = await engine.resolveField({ field: { label: 'Do you have any relatives currently working at Hexaware in any capacity?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(hexRel.value, 'No');

  const wspRel = await engine.resolveField({ field: { label: 'Do you have a close relative who is currently a public agency employee or an employee of WSP?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(wspRel.value, 'No');

  // Referral
  const refRes = await engine.resolveField({ field: { label: 'Did a WSP employee refer you to this job posting?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(refRes.value, 'No');

  // Public Agency / Restrictions / Outside Activities
  const pubAgency = await engine.resolveField({ field: { label: 'Have you or do you currently work for a public agency or institution?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(pubAgency.value, 'No');

  const restrictions = await engine.resolveField({ field: { label: 'Would you be subject to any restrictions from a former employer upon joining WSP?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(restrictions.value, 'No');

  // Background & Drug Screening
  const bgCheck = await engine.resolveField({ field: { label: 'Are you willing to undergo a pre-employment background check?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(bgCheck.value, 'Yes');

  const drugScreen = await engine.resolveField({ field: { label: 'Do you consent to a pre-employment drug screen?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(drugScreen.value, 'Yes');

  // Relocation & Domestic Travel
  const travelDom = await engine.resolveField({ field: { label: 'Are you willing and able to travel domestically?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(travelDom.value, 'Yes');

  const reqTravel = await engine.resolveField({ field: { label: 'This role may require travel as part of regular job responsibilities. Are you able to meet this requirement?', type: 'radio', options: ['Yes', 'No'] }, client: candidate });
  assert.equal(reqTravel.value, 'Yes');

  // Availability & Notice Period
  const startAvail = await engine.resolveField({ field: { label: 'When is the earliest you can start?', type: 'text' }, client: candidate });
  assert.equal(startAvail.value, 'Immediately');

  const noticeDays = await engine.resolveField({ field: { label: 'Notice Period in Days', type: 'text' }, client: candidate });
  assert.equal(noticeDays.value, '15');

  const joinMonth = await engine.resolveField({ field: { label: 'Can Join By Month', type: 'combobox' }, client: candidate });
  assert.equal(joinMonth.value, 'November');

  // Compensation
  const compExp = await engine.resolveField({ field: { label: 'What are your salary expectations?', type: 'textarea' }, client: candidate });
  assert.equal(compExp.value, 'USD Yearly: 100k-130k');

  const payRange = await engine.resolveField({ field: { label: 'What is your desired pay or pay range?', type: 'textarea' }, client: candidate });
  assert.equal(payRange.value, 'USD Yearly: 100k-130k');

  // Organization, Specialization & Experience
  const currOrg = await engine.resolveField({ field: { label: 'Current Organization', type: 'text' }, client: candidate });
  assert.equal(currOrg.value, 'Enterprise Corp');

  const specField = await engine.resolveField({ field: { label: 'Specialization', type: 'combobox' }, client: candidate });
  assert.equal(specField.value, 'Computer Science');

  const totExp = await engine.resolveField({ field: { label: 'Total Experience In Years', type: 'text' }, client: candidate });
  assert.equal(totExp.value, '2');

  const agreeCheck = await engine.resolveField({ field: { label: 'I Agree', type: 'checkbox' }, client: candidate });
  assert.equal(agreeCheck.value, true);
});
