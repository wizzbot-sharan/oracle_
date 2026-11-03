import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('Phase 4 radio filling targets visible label when input is hidden', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let labelClicked = false;
  let radioClicked = false;

  const mockRadio = {
    getAttribute: async (attr) => attr === 'id' ? 'radio-no-disability' : null,
    click: async () => { radioClicked = true; }
  };

  const mockLabel = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockLabel,
    click: async () => { labelClicked = true; }
  };

  const mockGroup = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockGroup,
    scrollIntoViewIfNeeded: async () => {},
    getByRole: (role, opts) => {
      if (role === 'radio') return mockRadio;
      return mockRadio;
    },
    locator: () => mockLabel
  };

  const page = {
    getByRole: (role) => {
      if (role === 'radiogroup') return mockGroup;
      return mockGroup;
    },
    locator: (selector) => {
      if (selector.includes('radio-no-disability')) return mockLabel;
      return { count: async () => 0, isVisible: async () => false, first: () => ({}) };
    },
    mouse: { wheel: async () => {} }
  };

  await adapter._fillFieldForTest(page, {
    id: 'do_you_have_a_disability',
    type: 'radio',
    label: 'Do you have a disability?'
  }, 'No, I do not have a disability and have not had one in the past');

  assert.ok(labelClicked, 'Expected visible label to be clicked for hidden Oracle radio input');
});

test('Phase 4 multi-checkbox fills only desired selections without affecting others', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  const checkedState = {
    'Asian': false,
    'White': false
  };

  const mockRow = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockRow,
    scrollIntoViewIfNeeded: async () => {},
    locator: (selector) => {
      if (selector.includes('cx-select-pills-container') || selector.includes('button.cx-select-pill-section')) {
        return { count: async () => 0, isVisible: async () => false, first: () => ({}) };
      }
      const optionName = selector.includes('Asian') ? 'Asian' : (selector.includes('White') ? 'White' : null);

      const mockOptionItem = {
        count: async () => 1,
        isVisible: async () => true,
        first: () => mockOptionItem,
        isChecked: async () => optionName ? checkedState[optionName] : false,
        click: async () => {
          if (optionName) checkedState[optionName] = !checkedState[optionName];
        },
        locator: (subSelector) => {
          return {
            count: async () => 1,
            isVisible: async () => true,
            first: () => mockOptionItem,
            isChecked: async () => optionName ? checkedState[optionName] : false,
            click: async () => {
              if (optionName) checkedState[optionName] = !checkedState[optionName];
            }
          };
        }
      };

      return mockOptionItem;
    }
  };

  const page = {
    locator: () => mockRow,
    mouse: { wheel: async () => {} }
  };

  await adapter._fillFieldForTest(page, {
    id: 'select_the_races_you_identify_with',
    type: 'multi-checkbox',
    label: 'Select the races you identify with.',
    options: ['Asian', 'White']
  }, ['Asian']);

  assert.equal(checkedState['Asian'], true, 'Expected Asian to be checked');
  assert.equal(checkedState['White'], false, 'Expected White to remain unchecked');
});

test('Phase 4 dynamically routes to combobox when live DOM element has role=combobox', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  const pressedKeys = [];
  let typed = '';
  let dropdownOpen = true;

  const mockOption = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockOption,
    filter: () => mockOption
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

  const mockLiveComboboxInput = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockLiveComboboxInput,
    click: async () => {},
    fill: async (v) => { typed = v; },
    pressSequentially: async (c) => { typed += c; },
    press: async (key) => {
      pressedKeys.push(key);
      if (key === 'Enter') dropdownOpen = false;
    },
    inputValue: async () => '50001',
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => true, // has cx-select-input
    getAttribute: async (attr) => {
      if (attr === 'role') return 'combobox';
      if (attr === 'aria-expanded') return dropdownOpen ? 'true' : 'false';
      if (attr === 'aria-invalid') return 'false';
      return null;
    }
  };

  const page = {
    locator: (selector) => {
      if (selector.includes('listbox') || selector.includes('cx-select-dropdown--open')) return mockDropdown;
      return mockLiveComboboxInput;
    },
    mouse: { wheel: async () => {} }
  };

  // Field type in static template is 'text', but live DOM role is 'combobox'
  await adapter._fillFieldForTest(page, {
    id: 'postal_code',
    sourceName: 'postalCode',
    type: 'text',
    label: 'Postal Code'
  }, '50001');

  assert.ok(pressedKeys.includes('ArrowDown'), 'Expected ArrowDown to be pressed despite static type=text');
  assert.ok(pressedKeys.includes('Enter'), 'Expected Enter to be pressed despite static type=text');
});

test('Phase 4 checkbox filling successfully handles ID-less checkbox by targeting visible label', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let checkboxChecked = false;
  let customButtonClicked = false;

  const mockCheckboxInput = {
    count: async () => 1,
    isVisible: async () => false, // visually hidden input
    isChecked: async () => checkboxChecked,
    first: () => mockCheckboxInput,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { checkboxChecked = !checkboxChecked; }
  };

  const mockCustomButton = {
    count: async () => 1,
    isVisible: async () => true, // custom visible button
    first: () => mockCustomButton,
    click: async () => {
      customButtonClicked = true;
      checkboxChecked = true;
    }
  };

  const page = {
    locator: (selector) => {
      if (selector.includes('input[type="checkbox"]')) {
        return mockCheckboxInput;
      }
      if (selector.includes('.apply-flow-input-checkbox__button') || selector.includes('label')) {
        return mockCustomButton;
      }
      return { count: async () => 0, isVisible: async () => false, first: () => ({}) };
    },
    getByRole: () => mockCheckboxInput,
    getByText: () => mockCustomButton,
    mouse: { wheel: async () => {} }
  };

  // Field has sourceId: null
  await adapter._fillFieldForTest(page, {
    id: 'i_agree_to_receive_marketing_communications',
    sourceId: null,
    sourceName: null,
    type: 'checkbox',
    label: 'I agree to receive marketing communications'
  }, true);

  assert.equal(customButtonClicked, true, 'Expected custom button to be clicked for ID-less checkbox');
  assert.equal(checkboxChecked, true, 'Expected checkbox state to become true');
});
