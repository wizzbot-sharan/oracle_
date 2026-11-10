import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('OracleRecruitingAdapter skips address and phone prefix comboboxes during option extraction', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 }
  });

  const page = {};
  const candidate = {};

  const cityRes = await adapter._extractComboboxOptionsForTest(page, candidate, {
    id: 'city',
    label: 'City *',
    type: 'combobox'
  });
  assert.equal(cityRes, null, 'Address city must be skipped');

  const stateRes = await adapter._extractComboboxOptionsForTest(page, candidate, {
    id: 'region2',
    label: 'State *',
    type: 'combobox'
  });
  assert.equal(stateRes, null, 'State region2 must be skipped');

  const phoneRes = await adapter._extractComboboxOptionsForTest(page, candidate, {
    id: 'phone_country_code',
    label: 'Country code',
    isPhonePrefix: true,
    type: 'combobox'
  });
  assert.equal(phoneRes, null, 'Phone country code prefix must be skipped');
});

test('OracleRecruitingAdapter scrolls combobox dropdown and collects all unique gridcell options', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 }
  });

  // Simulated items rendered in chunks (e.g. 5 on cycle 1, 5 more on cycle 2, then no new items)
  let scrollCycle = 0;
  const chunk1 = ["High School", "Associate's Degree", "Bachelor of Arts / BS"];
  const chunk2 = ["High School", "Associate's Degree", "Bachelor of Arts / BS", "Master of Science (MS) / MA", "Doctorate (PhD)"];

  const mockItems = {
    count: async () => (scrollCycle === 0 ? chunk1.length : chunk2.length),
    nth: (idx) => ({
      innerText: async () => (scrollCycle === 0 ? chunk1[idx] : chunk2[idx])
    })
  };

  const emptyLocator = {
    count: async () => 0,
    isVisible: async () => false,
    first: () => emptyLocator,
    locator: () => emptyLocator
  };

  const mockContainer = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockContainer,
    locator: () => ({
      filter: () => mockItems
    }),
    evaluate: async () => {
      scrollCycle += 1;
    }
  };

  let escapePressed = false;
  const mockPage = {
    locator: () => mockContainer,
    keyboard: {
      press: async (key) => {
        if (key === 'Escape') escapePressed = true;
      }
    }
  };

  let arrowDownPressed = false;
  const mockCandidate = {
    click: async () => {},
    press: async (key) => {
      if (key === 'ArrowDown') arrowDownPressed = true;
    },
    locator: () => emptyLocator
  };

  const options = await adapter._extractComboboxOptionsForTest(mockPage, mockCandidate, {
    id: 'highest_education',
    label: 'Highest Education Level',
    type: 'combobox'
  });

  assert.ok(arrowDownPressed, 'Should have triggered ArrowDown to expand dropdown');
  assert.ok(escapePressed, 'Should have pressed Escape to close dropdown after scanning');
  assert.deepEqual(options, [
    "High School",
    "Associate's Degree",
    "Bachelor of Arts / BS",
    "Master of Science (MS) / MA",
    "Doctorate (PhD)"
  ]);
});
