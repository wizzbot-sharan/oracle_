import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeAddress } from '../src/domain/address-decomposer.js';
import { CanonicalProfile, cleanInstitutionName } from '../src/domain/canonical-profile.js';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';
import { Phase3AnswerResolution } from '../src/phases/phase3-answer-resolution.js';

test('decomposeAddress strips candidate name and cleans multiline address string', () => {
  const candidateIdentity = {
    fullName: 'Aditya Pola',
    firstName: 'Aditya',
    lastName: 'Pola'
  };

  const multiline = 'Aditya Pola\nCharlotte, NC 28202\nUnited States';
  const decomposed = decomposeAddress(multiline, 'Charlotte, NC', 'North Carolina', candidateIdentity);

  assert.equal(decomposed.city, 'Charlotte');
  assert.ok(!decomposed.city.includes('Aditya'));
  assert.ok(!decomposed.city.includes('\n'));
  assert.equal(decomposed.stateAbbr, 'NC');
  assert.equal(decomposed.postalCode, '28202');
});

test('CanonicalProfile cleans literal "NULL" strings from profile fields', () => {
  const profile = CanonicalProfile.from({
    client: {
      client: {
        first_name: 'Jayaprakash',
        last_name: 'NULL',
        full_name: 'Jayaprakash NULL'
      },
      additional_information: {
        middle_name: 'null'
      }
    }
  });

  assert.equal(profile.identity.firstName, 'Jayaprakash');
  assert.equal(profile.identity.lastName, '');
  assert.equal(profile.identity.middleName, '');
});

test('cleanInstitutionName cleans resume highlight bloat and UTF-8 quotes', () => {
  const bloated = 'Dakota State University, Madison, SD \u2014 GPA: 4.0/4.0 \u2014 Selected for DSU-AI Sweden Program, Summer 2026';
  const clean = cleanInstitutionName(bloated);
  assert.equal(clean, 'Dakota State University, Madison, SD');

  const withQuotes = 'St. Maryâ€™s University \u2014 Magna Cum Laude';
  const cleanQuotes = cleanInstitutionName(withQuotes);
  assert.equal(cleanQuotes, "St. Mary's University");
});

test('Phase 3 resolveValues skips purely optional fields in Strict Required-Only mode', async () => {
  const phase3 = new Phase3AnswerResolution({
    store: {
      read: async () => ({}),
      write: async () => {}
    }
  });

  const template = {
    fields: [
      { id: 'first_name', label: 'First Name', type: 'text', required: true },
      { id: 'last_name', label: 'Last Name', type: 'text', required: true },
      { id: 'how_did_you_hear', label: 'How did you hear about this opportunity?', type: 'combobox', required: false },
      { id: 'referral_code', label: 'Referral Code', type: 'text', required: false },
      { id: 'phone_number', label: 'Phone Number', type: 'tel', required: true, isPhoneNumber: true },
      { id: 'phone_country_code', label: 'Country code', type: 'combobox', required: false, isPhonePrefix: true }
    ]
  };

  const client = {
    client: {
      first_name: 'John',
      last_name: 'Doe',
      callable_phone: '+1 9132918861'
    },
    additional_information: {
      primary_phone: '+1 9132918861'
    }
  };

  const resolved = await phase3.resolveValues(template, client, [], [], {}, '', false, true);

  // Required and compulsory whitelist fields must be resolved
  assert.ok(resolved['first_name']);
  assert.equal(resolved['first_name'].value, 'John');
  assert.ok(resolved['last_name']);
  assert.equal(resolved['last_name'].value, 'Doe');
  assert.ok(resolved['phone_number']);
  assert.ok(resolved['phone_country_code']);

  // Purely optional fields must be completely skipped
  assert.equal(resolved['how_did_you_hear'].source, 'skipped_optional');
  assert.equal(resolved['how_did_you_hear'].value, null);
  assert.equal(resolved['referral_code'].source, 'skipped_optional');
  assert.equal(resolved['referral_code'].value, null);
});

test('createOrResolveApplications strictly scopes resolution to options.jobKeys when provided', async () => {
  let writtenApplications = [];
  const mockStore = {
    read: async (key) => {
      if (key === 'jobs') {
        return {
          assignments: [
            { jobId: 'job-1', jobKey: 'job-1', applywizzId: 'user-1', tenantHost: 'host1.oraclecloud.com' },
            { jobId: 'job-2', jobKey: 'job-2', applywizzId: 'user-1', tenantHost: 'host2.oraclecloud.com' },
            { jobId: 'job-3', jobKey: 'job-3', applywizzId: 'user-2', tenantHost: 'host3.oraclecloud.com' }
          ]
        };
      }
      if (key === 'form-templates') {
        return {
          'job-1': { fields: [{ id: 'first_name', label: 'First Name', required: true }] },
          'job-2': { fields: [{ id: 'first_name', label: 'First Name', required: true }] },
          'job-3': { fields: [{ id: 'first_name', label: 'First Name', required: true }] }
        };
      }
      if (key === 'applications') return [];
      if (key === 'clients') return [];
      if (key === 'question-bank') return [];
      return {};
    },
    write: async (key, val) => {
      if (key === 'applications') writtenApplications = val;
    },
    loadClients: async () => [{ client: { applywizz_id: 'user-1', first_name: 'Alex' }, additional_information: {} }],
    loadQuestionBank: async () => []
  };

  const phase3 = new Phase3AnswerResolution({ store: mockStore });
  phase3.loadClients = async () => ({
    'user-1': { client: { applywizz_id: 'user-1', first_name: 'Alex', last_name: 'Smith' }, additional_information: {} }
  });

  // Resolve ONLY for job-2
  await phase3.createOrResolveApplications({ jobKeys: ['job-2'] });

  assert.equal(writtenApplications.length, 1);
  assert.equal(writtenApplications[0].jobId, 'job-2');
});

test('inspectLiveControlState strictly differentiates phone number and country code and rejects +1 as prefilled phone', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Load realistic Oracle Recruiting phone compound DOM
  await page.setContent(`
    <html>
      <body>
        <div class="input-row-composite__input phone-row__prefix">
          <input autocomplete="none" name="phoneNumber" id="country-codes-dropdownphoneNumber" type="text" role="combobox" value="+1" class="cx-select-input">
        </div>
        <div class="input-row-composite__input phone-row__number">
          <input type="tel" class="input-row__control phone-row__input" autocomplete="tel-national" aria-label="Phone Number" value="">
        </div>
      </body>
    </html>
  `);

  const phoneField = {
    id: 'phone_number',
    label: 'Phone Number',
    type: 'tel',
    isPhoneNumber: true,
    sourceName: 'phoneNumber'
  };

  const prefixField = {
    id: 'phone_country_code',
    label: 'Country code',
    type: 'combobox',
    isPhonePrefix: true,
    sourceId: 'country-codes-dropdownphoneNumber',
    sourceName: 'phoneNumber'
  };

  // Inspect phone field when national input is empty (even though country code prefix input has "+1")
  const phoneState = await adapter._inspectLiveControlStateForTest(page, phoneField);
  assert.equal(phoneState.hasValue, false, 'National phone field must NOT evaluate to hasValue: true when empty');

  // Inspect prefix field
  const prefixState = await adapter._inspectLiveControlStateForTest(page, prefixField);
  assert.equal(prefixState.hasValue, true, 'Prefix combobox with +1 must evaluate to hasValue: true');
  assert.equal(prefixState.currentValue, '+1');

  // Fill national digits and verify
  await page.locator('.phone-row__number input[type="tel"]').fill('9132918861');
  const filledPhoneState = await adapter._inspectLiveControlStateForTest(page, phoneField);
  assert.equal(filledPhoneState.hasValue, true, 'Phone with 10 digits must evaluate to hasValue: true');
  assert.equal(filledPhoneState.currentValue, '9132918861');

  await browser.close();
});

test('controlDescriptor 6-layer engine detects core identity and address fields as required', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Test DOM where theme CSS omitted asterisk class on First Name and Address 1
  await page.setContent(`
    <html>
      <body>
        <div class="input-row">
          <label id="lbl-fn">First Name</label>
          <input id="fn" aria-labelledby="lbl-fn" name="firstName" type="text">
        </div>
        <div class="input-row">
          <label id="lbl-addr">Address1</label>
          <input id="addr1" aria-labelledby="lbl-addr" name="addressLine1" type="text">
        </div>
        <div class="phone-row__prefix">
          <input id="cc" role="combobox" name="phoneNumber" type="text" aria-label="Country code">
        </div>
        <div class="input-row">
          <label id="lbl-opt">How did you hear about us?</label>
          <input id="opt" aria-labelledby="lbl-opt" name="referralSource" type="text">
        </div>
      </body>
    </html>
  `);

  const fnDesc = await adapter._controlDescriptorForTest(page.locator('#fn'));
  assert.equal(fnDesc.required, true, 'First Name must evaluate to required: true via Compulsory Whitelist');

  const addrDesc = await adapter._controlDescriptorForTest(page.locator('#addr1'));
  assert.equal(addrDesc.required, true, 'Address 1 must evaluate to required: true via Compulsory Whitelist');

  const ccDesc = await adapter._controlDescriptorForTest(page.locator('#cc'));
  assert.equal(ccDesc.required, true, 'Country code combobox must evaluate to required: true');

  const optDesc = await adapter._controlDescriptorForTest(page.locator('#opt'));
  assert.equal(optDesc.required, false, 'Purely optional question must evaluate to required: false');

  await browser.close();
});

test('controlDescriptor correctly identifies optional fields with unevaluated Knockout template syntax as required: false', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Test Oracle Knockout markup where unevaluated element.isRequired string is present,
  // but CSS class input-row__label--required is NOT applied (meaning element.isRequired evaluated to false)
  await page.setContent(`
    <html>
      <body>
        <div class="input-row input-row--text">
          <label class="input-row__label" data-bind="css: {'input-row__label--required': element.isRequired}" id="addr2-label" for="addr2">
            Address Line 2
          </label>
          <input id="addr2" name="addressLine2" type="text" data-bind="value: element.value">
        </div>
        <div class="input-row input-row--text">
          <label class="input-row__label" data-bind="css: {'input-row__label--required': element.isRequired}" id="tax-label" for="tax">
            Tax District
          </label>
          <input id="tax" name="taxDistrict" type="text" data-bind="value: element.value">
        </div>
      </body>
    </html>
  `);

  const addr2Desc = await adapter._controlDescriptorForTest(page.locator('#addr2'));
  assert.equal(addr2Desc.required, false, 'Address Line 2 without required CSS class must evaluate to required: false');

  const taxDesc = await adapter._controlDescriptorForTest(page.locator('#tax'));
  assert.equal(taxDesc.required, false, 'Tax District without required CSS class must evaluate to required: false');

  await browser.close();
});

test('controlDescriptor keeps Cover Letter and Attachment files optional while keeping Resume compulsory', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <body>
        <div class="file-form-element">
          <label for="cover-letter-file">Upload Cover Letter</label>
          <input type="file" id="cover-letter-file" name="attachment-upload">
        </div>
        <div class="file-form-element">
          <label for="extra-file">Upload Attachment</label>
          <input type="file" id="extra-file" name="attachment-upload">
        </div>
        <div class="file-form-element">
          <label for="resume-file">Upload Resume / CV</label>
          <input type="file" id="resume-file" name="resume-upload">
        </div>
      </body>
    </html>
  `);

  const coverDesc = await adapter._controlDescriptorForTest(page.locator('#cover-letter-file'));
  assert.equal(coverDesc.required, false, 'Cover Letter file upload must evaluate to required: false');

  const extraDesc = await adapter._controlDescriptorForTest(page.locator('#extra-file'));
  assert.equal(extraDesc.required, false, 'Generic attachment file upload must evaluate to required: false');

  const resumeDesc = await adapter._controlDescriptorForTest(page.locator('#resume-file'));
  assert.equal(resumeDesc.required, true, 'Resume / CV file upload must evaluate to required: true via Compulsory Whitelist');

  await browser.close();
});

test('visibleRadioGroupLabels resolves chained aria-labelledby IDs and inner labels on screening radiogroups', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Test realistic Oracle Recruiting markup where radiogroup uses aria-labelledby with nested label spans
  await page.setContent(`
    <html>
      <body>
        <div role="radiogroup" aria-labelledby="q1-label">
          <label id="q1-label" class="input-row__label input-row__label--required" aria-labelledby="labelText-q1 instructionsText-q1">
            <span id="labelText-q1">Do you currently or have you in the past worked for Intertrust Group or CSC?</span>
            <span id="instructionsText-q1">Please answer Yes or No.</span>
          </label>
          <div class="input-row__control-container">
            <input type="radio" id="q1-yes" name="q1" value="Yes">
            <label class="apply-flow-input-radio" for="q1-yes">
              <span class="apply-flow-input-radio__label">Yes</span>
            </label>
            <input type="radio" id="q1-no" name="q1" value="No">
            <label class="apply-flow-input-radio" for="q1-no">
              <span class="apply-flow-input-radio__label">No</span>
            </label>
          </div>
        </div>
        <div role="radiogroup" aria-label="Title" class="cx-select-pills-container">
          <button type="button" role="radio" aria-checked="false">Mr.</button>
          <button type="button" role="radio" aria-checked="false">Ms.</button>
        </div>
      </body>
    </html>
  `);

  const labels = await adapter._visibleRadioGroupLabelsForTest(page);
  assert.equal(labels.length, 2, 'Must detect both radiogroups');
  assert.ok(labels.some(l => l.includes('Intertrust Group or CSC')), 'Must detect question with aria-labelledby');
  assert.ok(labels.includes('Title'), 'Must detect radiogroup with aria-label');

  await browser.close();
});

test('inspectLiveControlState detects pre-filled cards in Timeline view and satisfies quota', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    await page.setContent(`
      <html>
        <body>
          <div class="beautiful-timeline__column beautiful-timeline__column--left" data-bind="foreach: experiences">
            <beautiful-timeline-item params="item: $data, type: 'experiences'">
              <div class="beautiful-timeline-item" data-profile-item-tile="true" role="group">
                <div class="beautiful-timeline-item__content">
                  <div class="beautiful-timeline-item__info">
                    <span class="beautiful-timeline-item__title">Data Scientist</span>
                    <span class="beautiful-timeline-item__subtitle">Cipla Ltd.</span>
                  </div>
                </div>
                <div class="beautiful-timeline-item__actions">
                  <button class="beautiful-timeline-item__edit-icon" title="Edit"></button>
                  <button class="beautiful-timeline-item__delete-icon" title="Remove"></button>
                </div>
              </div>
            </beautiful-timeline-item>
            <beautiful-timeline-item params="item: $data, type: 'experiences'">
              <div class="beautiful-timeline-item" data-profile-item-tile="true" role="group">
                <div class="beautiful-timeline-item__content">
                  <div class="beautiful-timeline-item__info">
                    <span class="beautiful-timeline-item__title">Machine Learning Engineer</span>
                    <span class="beautiful-timeline-item__subtitle">Infosys</span>
                  </div>
                </div>
              </div>
            </beautiful-timeline-item>
          </div>
        </body>
      </html>
    `);

    const expField = { id: 'experience', label: 'Work Experience', type: 'repeatable-group' };
    const state = await adapter._inspectLiveControlStateForTest(page, expField);

    assert.equal(state.hasValue, true, 'Repeatable group must report hasValue: true when cards are present');
    assert.ok(state.currentValue.includes('Data Scientist'), 'Current value should include job title');
    assert.ok(state.currentValue.includes('Cipla Ltd.'), 'Current value should include employer');

    // Verify matchesDesired with candidate rows
    const desiredRows = [
      { title: 'Data Scientist', company: 'Cipla Ltd.' },
      { title: 'Machine Learning Engineer', company: 'Infosys' }
    ];
    assert.equal(state.matchesDesired(desiredRows), true, 'Must report matchesDesired: true when existing cards match or meet quota');
  } finally {
    await browser.close();
  }
});

test('inspectLiveControlState detects Standard Flat Tile view and rejects placeholder cards', async () => {
  const { chromium } = await import('playwright');
  const { OracleRecruitingAdapter } = await import('../src/adapters/oracle/oracle-recruiting.js');
  const adapter = new OracleRecruitingAdapter({ headless: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Markup containing 1 valid card and 1 placeholder invalid card
    await page.setContent(`
      <html>
        <body>
          <div class="standard-apply-flow-profile-item">
            <div class="profile-item-list" role="group">
              <article class="apply-flow-profile-item-tile" id="tile-1">
                <div class="apply-flow-profile-item-tile__summary" data-profile-item-tile="true" role="group">
                  <div class="apply-flow-profile-item-tile__summary-content">
                    <div class="apply-flow-profile-item-tile__summary-title">
                      <span>Master of Science in Computer Science</span>
                    </div>
                    <div class="apply-flow-profile-item-tile__summary-subtitle">University of North Carolina</div>
                  </div>
                </div>
              </article>
              <article class="apply-flow-profile-item-tile apply-flow-profile-item-tile--invalid" id="tile-2">
                <div class="apply-flow-profile-item-tile__summary" data-profile-item-tile="true" data-profile-item-invalid="true" role="group">
                  <div class="apply-flow-profile-item-tile__summary-content">
                    <div class="apply-flow-profile-item-tile__summary-title">
                      <span>Unnamed Job Title</span>
                    </div>
                  </div>
                </div>
              </article>
            </div>
            <div class="profile-add-item">
              <button type="button" class="button apply-flow-profile-item-tile__new-tile">
                <span class="button__label">Add Education</span>
              </button>
            </div>
          </div>
        </body>
      </html>
    `);

    const eduField = { id: 'education', label: 'Education', type: 'repeatable-group' };
    const cards = await adapter._inspectExistingRepeatableCardsForTest(page, eduField);

    assert.equal(cards.length, 2, 'Must inspect both tiles');
    const validCards = cards.filter(c => !c.isInvalid);
    assert.equal(validCards.length, 1, 'Only genuine education card should be valid');
    assert.equal(validCards[0].title, 'Master of Science in Computer Science');

    const invalidCards = cards.filter(c => c.isInvalid);
    assert.equal(invalidCards.length, 1, 'Placeholder card must be flagged as invalid');
    assert.equal(invalidCards[0].title, 'Unnamed Job Title');
  } finally {
    await browser.close();
  }
});
