import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';
import { ResolutionEngine } from '../src/domain/resolution-engine.js';

test('Address Line 1 bypasses combobox selection and presses Escape to dismiss popup', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let typedValue = '';
  let escapePressed = false;
  let blurred = false;

  const mockLocator = {
    first: () => mockLocator,
    last: () => mockLocator,
    count: async () => 1,
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    getAttribute: async (attr) => (attr === 'role' ? 'combobox' : null),
    evaluate: async (fn) => {
      const fakeEl = {
        classList: { contains: (cls) => cls === 'cx-select-input' },
        closest: (cls) => null,
        getAttribute: (attr) => (attr === 'aria-haspopup' ? 'grid' : null),
        blur: () => { blurred = true; },
        readOnly: false,
        disabled: false
      };
      return fn(fakeEl);
    },
    fill: async (v) => { typedValue = v; },
    pressSequentially: async (c) => { typedValue += c; },
    press: async (k) => {
      if (k === 'Escape') escapePressed = true;
    },
    inputValue: async () => typedValue
  };

  const mockPage = {
    locator: () => mockLocator,
    getByLabel: () => mockLocator,
    waitForLoadState: async () => {},
    mouse: { wheel: async () => {} },
    viewportSize: () => ({ height: 900 })
  };

  const field = {
    id: 'address_line1',
    label: 'Address Line 1',
    type: 'combobox',
    sourceId: 'addressLine1-12'
  };

  await adapter._fillFieldForTest(mockPage, field, '645 Kirkland Dr');

  assert.equal(typedValue, '645 Kirkland Dr', 'Must type raw street address');
  assert.equal(escapePressed, true, 'Must press Escape to dismiss Oracle/Google Places popup');
  assert.equal(blurred, true, 'Must blur to commit without triggering location autofill');
});

test('Repeatable drawer matches fields with dynamic instance IDs (prefix/baseName matching)', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let capturedInput = {};

  const mockDrawer = {
    waitFor: async () => {},
    first: () => mockDrawer,
    locator: (selector) => {
      let currentVal = '';
      return {
        first: () => ({
          count: async () => 1,
          isVisible: async () => true,
          scrollIntoViewIfNeeded: async () => {},
          click: async () => {},
          getAttribute: async () => null,
          evaluate: async () => false,
          fill: async (val) => { currentVal = val; capturedInput[selector] = val; },
          pressSequentially: async (c) => { currentVal += c; capturedInput[selector] = currentVal; },
          inputValue: async () => currentVal || 'Microsoft'
        })
      };
    }
  };

  const mockPage = {
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {}
      })
    }),
    getByRole: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {}
      })
    }),
    waitForLoadState: async () => {},
    mouse: { wheel: async () => {} },
    viewportSize: () => ({ height: 900 })
  };

  // Field was scanned with stale counter "-42"
  const childField = {
    id: 'employer_name',
    label: 'Employer',
    type: 'text',
    sourceId: 'employerName-42',
    sourceName: 'employerName'
  };

  // Fill inside drawer context
  await adapter._fillFieldForTest(mockPage, childField, 'Microsoft', {}, { drawer: mockDrawer });

  assert.ok(
    Object.keys(capturedInput).some(s => s.includes('employerName')),
    'Must match using baseName prefix rather than timing out on -42'
  );
});

test('ResolutionEngine normalizes education records with country_code defaulting to United States', async () => {
  const engine = new ResolutionEngine();
  const client = {
    client: { full_name: 'Test Student' },
    additional_information: {
      university_name: 'Northwest Missouri State University',
      highest_education: "Master's Degree",
      zip_or_country: 'United States of America'
    }
  };

  const field = {
    id: 'education',
    label: 'Education',
    type: 'repeatable-group'
  };

  const result = await engine.resolveField({ field, client });
  assert.ok(Array.isArray(result?.value), 'Education must resolve to an array of records');
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].country_code, 'United States');
  assert.equal(result.value[0].institution, 'Northwest Missouri State University');
});
