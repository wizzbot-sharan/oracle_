import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionEngine, isPiiOrPersonalQuestion } from '../src/domain/resolution-engine.js';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('Resolution Engine collision guards', async (t) => {
  const engine = new ResolutionEngine();

  const candidate = {
    client: {
      full_name: 'Nikesh Reddy Addula',
      personal_email: 'nikesh.reddy@example.com',
      salary_range: '$110,000 - $130,000'
    },
    additional_information: {
      full_address: '12 Buchanan St, Glasgow, Scotland, G1 3HL',
      state_of_residence: 'Scotland',
      location: 'Glasgow, Scotland, United Kingdom',
      country: 'United Kingdom',
      availability: 'Immediate',
      notice_period: '1 Month',
      experience_records: [
        {
          title: 'Mechanical Engineer',
          company: 'Professional Experience', // poisoned placeholder
          startDate: '01/2022',
          endDate: 'Present'
        }
      ]
    }
  };

  const resumeText = `
NIKESH REDDY ADDULA
Glasgow, UK | nikesh.reddy@example.com

PROFESSIONAL EXPERIENCE
Mechanical Design Engineer                                                    Jan 2022 - Present
Strathclyde Dynamics Ltd | Glasgow, UK
- Designed thermal systems and fluid flow analysis.
  `;

  await t.test('State guard: "Please state your notice period" does not resolve to Scotland', async () => {
    const res = await engine.resolveField({
      field: { label: 'Please state your notice period or availability to start *', type: 'text' },
      client: candidate,
      resumeText
    });
    // Should NOT be Scotland!
    assert.notEqual(res.value, 'Scotland');
    assert.equal(res.value, '1 Month');
  });

  await t.test('State guard: "Please state your salary expectations" does not resolve to Scotland', async () => {
    const res = await engine.resolveField({
      field: { label: 'Please state your salary and package requirements *', type: 'text' },
      client: candidate,
      resumeText
    });
    assert.notEqual(res.value, 'Scotland');
    assert.equal(res.value, '$110,000 - $130,000');
  });

  await t.test('Legitimate State field resolves to Scotland', async () => {
    const res = await engine.resolveField({
      field: { id: 'region2', label: 'State *', type: 'combobox' },
      client: candidate,
      resumeText
    });
    assert.equal(res.value, 'Scotland');
    assert.equal(res.stage, 'stage1_taxonomy');
  });

  await t.test('Company name guard: rejects "Professional Experience" placeholder and extracts real company from resume', async () => {
    const res = await engine.resolveField({
      field: { label: 'Current or most recent employer *', type: 'text' },
      client: candidate,
      resumeText
    });
    assert.notEqual(res.value, 'Professional Experience');
    assert.equal(res.value, 'Strathclyde Dynamics Ltd');
  });

  await t.test('Repeatable group experience sanitizes "Professional Experience"', async () => {
    const res = await engine.resolveField({
      field: { id: 'experience', label: 'Experience', type: 'repeatable-group' },
      client: candidate,
      resumeText
    });
    assert.ok(Array.isArray(res.value));
    assert.equal(res.value[0].company_name, 'Strathclyde Dynamics Ltd');
    assert.notEqual(res.value[0].company_name, 'Professional Experience');
  });

  await t.test('Referral guard: referral full name does not resolve to candidate own name', async () => {
    const res = await engine.resolveField({
      field: { label: 'If yes, please tell us their full name and email address', type: 'text' },
      client: candidate,
      resumeText
    });
    // Must not be candidate's own name
    assert.notEqual(res.value, 'Nikesh Reddy Addula');
  });

  await t.test('Notice Period resolves against options list', async () => {
    const res = await engine.resolveField({
      field: {
        label: 'Notice Period',
        type: 'combobox',
        options: ['Immediate', '2 Weeks', '1 Month', '3 Months']
      },
      client: candidate,
      resumeText
    });
    assert.equal(res.value, '1 Month');
  });

  await t.test('isPiiOrPersonalQuestion protects country and nationality', () => {
    assert.equal(isPiiOrPersonalQuestion('Country'), true);
    assert.equal(isPiiOrPersonalQuestion('Country of residence'), true);
    assert.equal(isPiiOrPersonalQuestion('Nationality'), true);
    assert.equal(isPiiOrPersonalQuestion('State'), true);
  });

  await t.test('Phase 4 matching guard: "Country" does NOT match sponsorship or country code', () => {
    const adapter = new OracleRecruitingAdapter();
    const values = {
      country: { questionLabel: 'Country', value: 'United States' },
      sponsorship: { questionLabel: 'Do you require sponsorship to work in the country to which you are applying?', value: 'No' },
      phone_prefix: { questionLabel: 'Country code', value: '+1' }
    };

    // 1. Legitimate country control
    const countryMatch = adapter.matchLiveControl({ label: 'Country *', id: 'live_country' }, values);
    assert.equal(countryMatch?.targetFieldId, 'country');
    assert.equal(countryMatch?.answer, 'United States');

    // 2. Sponsorship question containing word "country" must match sponsorship, NOT country!
    const sponsorMatch = adapter.matchLiveControl({ label: 'Do you require sponsorship to work in the country to which you are applying? *', id: 'live_sponsor' }, values);
    assert.equal(sponsorMatch?.targetFieldId, 'sponsorship');
    assert.equal(sponsorMatch?.answer, 'No');

    // 3. Country code question must NOT match "country"
    const prefixMatch = adapter.matchLiveControl({ label: 'Country code *', id: 'live_prefix' }, values);
    assert.equal(prefixMatch?.targetFieldId, 'phone_prefix');
    assert.equal(prefixMatch?.answer, '+1');
  });
});
