import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalProfile, parseSalaryRange } from '../src/domain/canonical-profile.js';

test('parseSalaryRange parses shorthand k-notation and compound ranges', () => {
  const s1 = parseSalaryRange('USD Yearly: 60k-80k, Hourly: 20-40');
  assert.equal(s1.currencyCode, 'USD');
  assert.equal(s1.minAnnual, 60000);
  assert.equal(s1.maxAnnual, 80000);
  assert.equal(s1.minHourly, 20);
  assert.equal(s1.maxHourly, 40);
  assert.equal(s1.midpointAnnual, 70000);
  assert.equal(s1.formattedRange, '$60,000 - $80,000 / year');

  const s2 = parseSalaryRange('100k-130k');
  assert.equal(s2.currencyCode, 'USD');
  assert.equal(s2.minAnnual, 100000);
  assert.equal(s2.maxAnnual, 130000);
  assert.equal(s2.midpointAnnual, 115000);

  const s3 = parseSalaryRange('CAD 85,000 - 105,000');
  assert.equal(s3.currencyCode, 'CAD');
  assert.equal(s3.minAnnual, 85000);
  assert.equal(s3.maxAnnual, 105000);

  const s4 = parseSalaryRange('€75,000');
  assert.equal(s4.currencyCode, 'EUR');
  assert.equal(s4.minAnnual, 75000);
  assert.equal(s4.maxAnnual, 75000);

  const sEmpty = parseSalaryRange(null);
  assert.equal(sEmpty.minAnnual, null);
  assert.equal(sEmpty.maxAnnual, null);
});

test('CanonicalProfile normalizes client profile without synthetic defaults', () => {
  const rawClient = {
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

  const profile = CanonicalProfile.from({ client: rawClient });

  assert.equal(profile.applywizzId, 'AWL-45416');
  assert.equal(profile.identity.firstName, 'Abdullah');
  assert.equal(profile.identity.lastName, 'Zubair Mohd');
  assert.equal(profile.identity.fullName, 'Abdullah Zubair Mohd');
  assert.equal(profile.contact.email, 'code.zbr2@gmail.com');
  assert.equal(profile.contact.phoneCountryCode, '+1');
  assert.equal(profile.address.city, 'Oak Creek');
  assert.equal(profile.address.stateAbbr, 'WI');
  assert.equal(profile.address.postalCode, '53154');
  assert.equal(profile.compensation.currencyCode, 'USD');
  assert.equal(profile.compensation.minAnnual, 60000);
  assert.equal(profile.compensation.maxAnnual, 80000);
  assert.equal(profile.workAuth.eligibleInUS, true);
  assert.equal(profile.workAuth.requiresSponsorship, false);
  assert.equal(profile.eeo.gender, 'Male');
  assert.equal(profile.eeo.isHispanic, 'Decline to Self-Identify');
  assert.equal(profile.eeo.raceEthnicity, 'I don’t wish to answer');
  assert.equal(profile.history.highestEducation, "Bachelor’s Degree");
});

test('CanonicalProfile leaves missing fields strictly as null or empty', () => {
  const minimalClient = {
    client: { full_name: 'John Minimal' },
    additional_information: {}
  };

  const profile = CanonicalProfile.from({ client: minimalClient });

  assert.equal(profile.identity.firstName, 'John');
  assert.equal(profile.identity.lastName, 'Minimal');
  assert.equal(profile.eeo.raceEthnicity, '');
  assert.equal(profile.eeo.gender, '');
  assert.equal(profile.address.city, '');
  assert.equal(profile.address.postalCode, '');
  assert.equal(profile.compensation.minAnnual, null);
});
