import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('phone country code and phone number are resolved to separate structural inputs', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  const filled = {};
  const pressedKeys = [];

  const mockPrefixLocator = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockPrefixLocator,
    click: async () => {},
    fill: async (val) => { filled.countryCode = val; },
    pressSequentially: async (chars) => { filled.countryCode = (filled.countryCode || '') + chars; },
    press: async (k) => { pressedKeys.push(`countryCode:${k}`); },
    inputValue: async () => filled.countryCode,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {},
    getAttribute: async () => 'country-code-listbox'
  };

  const mockNumberLocator = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockNumberLocator,
    click: async () => {},
    fill: async (val) => { filled.phoneNumber = val; },
    pressSequentially: async (chars) => { filled.phoneNumber = (filled.phoneNumber || '') + chars; },
    press: async (k) => { pressedKeys.push(`phoneNumber:${k}`); },
    inputValue: async () => filled.phoneNumber,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {}
  };

  const page = {
    locator: (selector) => {
      if (selector.includes('phone-row__prefix')) return mockPrefixLocator;
      if (selector.includes('phone-row__number') || selector.includes('phone-row__input')) return mockNumberLocator;
      return { count: async () => 0, isVisible: async () => false, first: () => ({ count: async () => 0 }) };
    },
    getByLabel: () => ({ count: async () => 0, first: () => ({ count: async () => 0 }) }),
    getByRole: () => ({ count: async () => 0, first: () => ({ count: async () => 0 }) }),
    mouse: { wheel: async () => {} }
  };

  // Fill country code (combobox)
  await adapter._fillFieldForTest(page, {
    id: 'phone_country_code',
    sourceName: 'phoneNumber',
    type: 'combobox',
    label: 'Country/Region code'
  }, '+1');

  assert.equal(filled.countryCode, '+1');
  assert.ok(pressedKeys.includes('countryCode:Enter'));

  // Fill phone number (tel)
  await adapter._fillFieldForTest(page, {
    id: 'phone_number',
    sourceName: 'phoneNumber',
    type: 'tel',
    label: 'Phone Number'
  }, '1234567890');

  assert.equal(filled.phoneNumber, '1234567890');
});

test('phone number verification passes when Oracle formats raw digits into national format', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  const mockFormattedInput = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockFormattedInput,
    click: async () => {},
    fill: async () => {},
    pressSequentially: async () => {},
    press: async () => {},
    // Oracle auto-formats 1234567890 into (123) 456-7890
    inputValue: async () => '(123) 456-7890',
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {}
  };

  const page = {
    locator: () => mockFormattedInput,
    getByLabel: () => mockFormattedInput,
    getByRole: () => mockFormattedInput,
    mouse: { wheel: async () => {} }
  };

  // Should succeed without throwing FIELD_VERIFICATION_FAILED
  await assert.doesNotReject(async () => {
    await adapter._fillFieldForTest(page, {
      id: 'phone_number',
      sourceName: 'phoneNumber',
      type: 'tel',
      label: 'Phone Number'
    }, '1234567890');
  });
});

test('combobox commits matching option when dropdown renders', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let typed = '';
  let dropdownOpen = true;
  const pressedKeys = [];

  const mockOption = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockOption,
    filter: () => mockOption,
    scrollIntoViewIfNeeded: async () => {},
    locator: () => mockOption,
    click: async () => {}
  };

  const mockDropdown = {
    count: async () => (dropdownOpen ? 1 : 0),
    isVisible: async () => dropdownOpen,
    first: () => mockDropdown,
    locator: () => ({
      filter: () => mockOption,
      count: async () => (dropdownOpen ? 1 : 0),
      first: () => mockOption
    })
  };

  const mockInput = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockInput,
    click: async () => {},
    fill: async (v) => { typed = v; },
    pressSequentially: async (c) => { typed += c; },
    press: async (key) => {
      pressedKeys.push(key);
      // Simulate Oracle: after ArrowDown+Enter, Oracle replaces typed text with full label
      if (key === 'Enter' && pressedKeys.includes('ArrowDown')) {
        typed = 'Essex Fells, NJ';
        dropdownOpen = false;
      }
    },
    inputValue: async () => typed,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {},
    getAttribute: async (attr) => {
      if (attr === 'aria-controls') return 'city-listbox';
      if (attr === 'aria-invalid') return 'false';
      if (attr === 'aria-expanded') return dropdownOpen ? 'true' : 'false';
      return null;
    }
  };

  const page = {
    locator: (selector) => {
      if (selector.includes('city-listbox') || selector.includes('cx-select-dropdown--open')) return mockDropdown;
      return mockInput;
    },
    getByLabel: () => mockInput,
    mouse: { wheel: async () => {} }
  };

  await adapter._fillFieldForTest(page, {
    id: 'city',
    sourceName: 'City',
    type: 'combobox',
    label: 'City'
  }, 'Essex Fells');

  assert.ok(pressedKeys.includes('ArrowDown'), 'Expected ArrowDown to be pressed to highlight first option');
  assert.ok(pressedKeys.includes('Enter'), 'Expected Enter to be pressed to commit selection');
  assert.equal(typed, 'Essex Fells, NJ');
});

test('combobox clears input when no dropdown options appear after 3 seconds', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let typed = '';

  const mockEmptyListbox = {
    count: async () => 0,
    isVisible: async () => false,
    first: () => mockEmptyListbox,
    locator: () => ({
      filter: () => ({ count: async () => 0, isVisible: async () => false, first: () => ({}) }),
      count: async () => 0,
      first: () => ({ count: async () => 0, isVisible: async () => false })
    })
  };

  const mockInput = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockInput,
    click: async () => {},
    fill: async (v) => { typed = v; },
    pressSequentially: async (c) => { typed += c; },
    press: async () => {},
    inputValue: async () => typed,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {},
    getAttribute: async () => 'empty-listbox'
  };

  const page = {
    locator: (selector) => {
      if (selector.includes('empty-listbox')) return mockEmptyListbox;
      return mockInput;
    },
    getByLabel: () => mockInput,
    mouse: { wheel: async () => {} }
  };

  await adapter._fillFieldForTest(page, {
    id: 'city',
    sourceName: 'City',
    type: 'combobox',
    label: 'City'
  }, 'NonExistentPlace');

  assert.equal(typed, '', 'Expected input to be cleared for manual review when no dropdown options appear');
});

test('repeatable group clicks Add Education and saves row to collapse drawer', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  const actions = [];
  let drawerOpen = false;

  const mockAddBtn = {
    count: async () => 1,
    first: () => mockAddBtn,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {},
    click: async () => {
      actions.push('click:+add_education');
      drawerOpen = true;
    }
  };

  const mockSaveBtn = {
    count: async () => (drawerOpen ? 1 : 0),
    first: () => mockSaveBtn,
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {},
    click: async () => {
      actions.push('click:add_education_save');
      drawerOpen = false;
    }
  };

  const mockFieldInput = {
    count: async () => 1,
    first: () => mockFieldInput,
    click: async () => {},
    fill: async () => {},
    pressSequentially: async () => {},
    press: async () => {},
    inputValue: async () => 'MIT',
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => {}
  };

  const page = {
    getByRole: (role, opts) => {
      if (role === 'button' && opts?.name?.test?.('ADD EDUCATION')) return mockAddBtn;
      return { count: async () => 0, first: () => ({ count: async () => 0 }) };
    },
    locator: (selector) => {
      if (selector.includes('Add Education') || selector.includes('Save')) return mockSaveBtn;
      return mockFieldInput;
    },
    getByLabel: () => mockFieldInput,
    mouse: { wheel: async () => {} }
  };

  await adapter._fillRepeatableGroupForTest(page, {
    id: 'education',
    label: 'Education',
    addButton: 'ADD EDUCATION',
    children: [{ id: 'school', label: 'School', type: 'text' }]
  }, [
    { school: 'MIT' }
  ]);

  assert.deepEqual(actions, ['click:+add_education', 'click:add_education_save']);
  assert.equal(drawerOpen, false, 'Drawer should be collapsed after save');
});
