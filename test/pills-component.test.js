import test from 'node:test';
import assert from 'node:assert/strict';
import { isFieldVisible } from '../src/domain/form-template.js';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('isFieldVisible evaluates condition with includes against array answers', () => {
  const childField = {
    id: 'government_agency_details',
    label: 'Please specify the government agency and dates',
    visibleWhen: {
      field: 'statements',
      includes: 'You are a current or former government official'
    }
  };

  // Case 1: Answer array contains the trigger statement -> visible
  assert.equal(isFieldVisible(childField, {
    statements: { value: ['You are a current or former government official'] }
  }), true);

  // Case 2: Answer array has other statement -> not visible
  assert.equal(isFieldVisible(childField, {
    statements: { value: ['No statements apply to me'] }
  }), false);

  // Case 3: Empty array or null -> not visible
  assert.equal(isFieldVisible(childField, {
    statements: { value: [] }
  }), false);
  assert.equal(isFieldVisible(childField, {}), false);
});

test('Phase 4 correctly toggles cx-select-pills buttons based on desired answer', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  const clickedPills = [];
  const pillSelection = {
    'Option A': false,
    'Option B': false,
    'No statements apply to me': false
  };

  const mockRow = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockRow,
    scrollIntoViewIfNeeded: async () => {},
    locator: (selector) => {
      for (const opt of Object.keys(pillSelection)) {
        if (selector.includes(opt)) {
          const mockPillBtn = {
            count: async () => 1,
            isVisible: async () => true,
            first: () => mockPillBtn,
            click: async () => {
              clickedPills.push(opt);
              pillSelection[opt] = !pillSelection[opt];
            },
            evaluate: async (fn) => {
              return pillSelection[opt];
            }
          };
          return mockPillBtn;
        }
      }

      if (selector.includes('cx-select-pills-container') || selector.includes('button.cx-select-pill-section')) {
        return {
          count: async () => 3,
          first: () => ({ count: async () => 1, isVisible: async () => true })
        };
      }

      return {
        count: async () => 0,
        isVisible: async () => false,
        first: () => ({ count: async () => 0, isVisible: async () => false })
      };
    }
  };

  const page = {
    locator: () => mockRow,
    mouse: { wheel: async () => {} }
  };

  await adapter._fillFieldForTest(page, {
    id: 'statements',
    type: 'multi-checkbox',
    format: 'pills',
    label: 'Check all of the following statements that apply to you:',
    options: ['Option A', 'Option B', 'No statements apply to me']
  }, ['No statements apply to me']);

  assert.ok(clickedPills.includes('No statements apply to me'), 'Expected "No statements apply to me" pill to be clicked');
  assert.equal(clickedPills.includes('Option A'), false, 'Expected Option A to not be clicked');
  assert.equal(pillSelection['No statements apply to me'], true);
});

test('extractCheckboxGroups differentiates multi-select pills from single-select radio pills', async () => {
  const adapter = new OracleRecruitingAdapter({});

  // Mock page.evaluate to simulate DOM containing both single-select radio pills and multi-select pills
  const mockPage = {
    evaluate: async (fn) => {
      // 1. Single-select radio pill group (e.g. Yes / No)
      const radioRow = {
        closest: (sel) => (sel.includes('.input-row') ? radioRow : null),
        querySelector: (sel) => {
          if (sel.includes('[role="radiogroup"]') || sel.includes('[role="radio"]')) {
            return { getAttribute: () => 'radiogroup' };
          }
          if (sel.includes('.input-row__label')) return { textContent: 'Are you legally authorized to work?' };
          return null;
        },
        querySelectorAll: (sel) => {
          if (sel.includes('button')) return [{ querySelector: () => ({ textContent: 'Yes' }) }, { querySelector: () => ({ textContent: 'No' }) }];
          return [];
        },
        getAttribute: (attr) => attr === 'role' ? null : null,
        classList: { contains: () => false }
      };

      // 2. Multi-select pill group (e.g. statements)
      const multiRow = {
        closest: (sel) => (sel.includes('.input-row') ? multiRow : null),
        querySelector: (sel) => {
          if (sel.includes('[role="radiogroup"]') || sel.includes('[role="radio"]')) return null;
          if (sel.includes('.input-row__label')) return { textContent: 'Check all of the following statements that apply:' };
          if (sel.includes('.cx-multi-select-pills')) return { getAttribute: () => 'statements_qa', id: 'statements_qa' };
          return null;
        },
        querySelectorAll: (sel) => {
          if (sel.includes('button')) {
            return [
              { querySelector: () => ({ textContent: 'Statement 1' }) },
              { querySelector: () => ({ textContent: 'Statement 2' }) }
            ];
          }
          return [];
        },
        getAttribute: (attr) => null,
        classList: { contains: () => false }
      };

      // Mock document.querySelectorAll
      const originalQuery = typeof document !== 'undefined' ? document.querySelectorAll : null;
      globalThis.document = {
        querySelectorAll: (sel) => {
          if (sel.includes('cx-select-pills') || sel.includes('cx-multi-select-pills')) {
            return [radioRow, multiRow];
          }
          return [];
        }
      };

      try {
        return await fn();
      } finally {
        if (originalQuery) {
          globalThis.document.querySelectorAll = originalQuery;
        } else {
          delete globalThis.document;
        }
      }
    }
  };

  const { groups } = await adapter._extractCheckboxGroupsForTest(mockPage);

  // Radio Yes/No should NOT be included in multi-checkbox groups
  assert.equal(groups.some(g => g.label.includes('legally authorized')), false, 'Radio Yes/No group must not be in multi-checkbox groups');

  // Multi-select statements should be included
  const multiGroup = groups.find(g => g.label.includes('Check all of the following'));
  assert.ok(multiGroup, 'Multi-select pill group must be extracted');
  assert.equal(multiGroup.type, 'multi-checkbox');
  assert.equal(multiGroup.format, 'pills');
  assert.deepEqual(multiGroup.options, ['Statement 1', 'Statement 2']);
});

test('dashboard visibleWhen helper in App.jsx handles condition.includes against array answers', () => {
  function visibleWhen(condition, answers) {
    if (!condition) return true;
    if (condition.all) return condition.all.every(item => visibleWhen(item, answers));
    const val = answers[condition.field];
    if (condition.includes !== undefined) {
      return Array.isArray(val) ? val.includes(condition.includes) : val === condition.includes;
    }
    return val === condition.equals;
  }

  const conditionSingle = { field: 'conflict_statements', includes: 'Government Official' };
  assert.equal(visibleWhen(conditionSingle, { conflict_statements: ['Government Official', 'Other'] }), true);
  assert.equal(visibleWhen(conditionSingle, { conflict_statements: ['No statements apply to me'] }), false);
  assert.equal(visibleWhen(conditionSingle, { conflict_statements: [] }), false);
  assert.equal(visibleWhen(conditionSingle, {}), false);

  const conditionNested = {
    all: [
      { field: 'conflict_statements', includes: 'Government Official' },
      { field: 'is_current_employee', equals: 'Yes' }
    ]
  };
  assert.equal(visibleWhen(conditionNested, {
    conflict_statements: ['Government Official'],
    is_current_employee: 'Yes'
  }), true);
  assert.equal(visibleWhen(conditionNested, {
    conflict_statements: ['Government Official'],
    is_current_employee: 'No'
  }), false);
});

test('toggleMultiOption toggles pill selection state on and off', async () => {
  const adapter = new OracleRecruitingAdapter({
    actionGap: { min: 0, max: 0 },
    postNextWait: { min: 0, max: 0 },
    humanDelay: { min: 0, max: 0 }
  });

  let isSelected = false;
  let clickCount = 0;

  const mockPillBtn = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockPillBtn,
    click: async () => {
      clickCount += 1;
      isSelected = !isSelected;
    },
    evaluate: async () => isSelected
  };

  const mockRow = {
    count: async () => 1,
    isVisible: async () => true,
    first: () => mockRow,
    locator: () => mockPillBtn
  };

  const mockPage = {
    locator: () => mockRow
  };

  const group = {
    label: 'Statements',
    type: 'multi-checkbox',
    format: 'pills',
    options: ['Option A']
  };

  // 1. Toggle ON: currently false -> should click once
  const resOn = await adapter._toggleMultiOptionForTest(mockPage, group, 'Option A', true);
  assert.equal(resOn, true);
  assert.equal(isSelected, true);
  assert.equal(clickCount, 1);

  // 2. Toggle ON again: already true -> should NOT click
  await adapter._toggleMultiOptionForTest(mockPage, group, 'Option A', true);
  assert.equal(clickCount, 1);

  // 3. Toggle OFF: currently true -> should click once
  const resOff = await adapter._toggleMultiOptionForTest(mockPage, group, 'Option A', false);
  assert.equal(resOff, true);
  assert.equal(isSelected, false);
  assert.equal(clickCount, 2);
});


