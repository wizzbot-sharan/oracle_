import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreOptionMatch,
  findBestOptionMatch,
  coerceToBoolean,
  coerceToRadio,
  coerceToMultiSelect,
  coerceToString,
  coerceValueForField
} from '../src/domain/coercion.js';
import { isFieldVisible } from '../src/domain/form-template.js';

test('scoreOptionMatch handles exact, substring, and token overlap scoring', () => {
  // Exact match
  assert.equal(scoreOptionMatch('Chicago', 'chicago'), 100);
  assert.equal(scoreOptionMatch('Yes', 'yes'), 100);

  // Substring match
  assert.equal(scoreOptionMatch('Chicago', 'Chicago, IL'), 80);
  assert.equal(scoreOptionMatch('Full-time', 'Full-time Employee'), 80);

  // Token overlap match
  const tokenScore = scoreOptionMatch('Software Engineer', 'Software Engineer - Backend');
  assert.equal(tokenScore >= 40, true);

  // No match
  assert.equal(scoreOptionMatch('Atlanta', 'Dallas, TX'), 0);
  assert.equal(scoreOptionMatch('', 'Dallas, TX'), 0);
});

test('findBestOptionMatch finds the highest-scoring available option', () => {
  const targetOptions = ['New York, NY', 'Chicago, IL', 'Austin, TX'];

  // Candidate choices: ["Atlanta", "Chicago"] -> should pick "Chicago, IL"
  const match1 = findBestOptionMatch(['Atlanta', 'Chicago'], targetOptions);
  assert.equal(match1, 'Chicago, IL');

  // Candidate choices: ["Austin"] -> should pick "Austin, TX"
  const match2 = findBestOptionMatch(['Austin'], targetOptions);
  assert.equal(match2, 'Austin, TX');

  // Candidate choices: ["Miami", "Seattle"] (none match) -> returns null
  const match3 = findBestOptionMatch(['Miami', 'Seattle'], targetOptions);
  assert.equal(match3, null);
});

test('coerceToBoolean safely converts string representations without truthy false-positives', () => {
  // Falsy conversions
  assert.equal(coerceToBoolean('No'), false);
  assert.equal(coerceToBoolean('no'), false);
  assert.equal(coerceToBoolean('NO'), false);
  assert.equal(coerceToBoolean('false'), false);
  assert.equal(coerceToBoolean('FALSE'), false);
  assert.equal(coerceToBoolean('0'), false);
  assert.equal(coerceToBoolean(0), false);
  assert.equal(coerceToBoolean('disagree'), false);
  assert.equal(coerceToBoolean('decline'), false);
  assert.equal(coerceToBoolean(false), false);
  assert.equal(coerceToBoolean(null), false);
  assert.equal(coerceToBoolean(undefined), false);

  // Truthy conversions
  assert.equal(coerceToBoolean('Yes'), true);
  assert.equal(coerceToBoolean('yes'), true);
  assert.equal(coerceToBoolean('YES'), true);
  assert.equal(coerceToBoolean('true'), true);
  assert.equal(coerceToBoolean('TRUE'), true);
  assert.equal(coerceToBoolean('1'), true);
  assert.equal(coerceToBoolean(1), true);
  assert.equal(coerceToBoolean('agree'), true);
  assert.equal(coerceToBoolean('accept'), true);
  assert.equal(coerceToBoolean(true), true);
});

test('coerceToRadio converts booleans, multi-select arrays, and uses best-match selection', () => {
  const radioOptions = ['Chicago, IL', 'Austin, TX', 'New York, NY'];

  // Boolean conversions
  assert.equal(coerceToRadio(true, ['Yes', 'No']), 'Yes');
  assert.equal(coerceToRadio(false, ['Yes', 'No']), 'No');

  // Array conversion with Best-Match
  assert.equal(coerceToRadio(['Atlanta', 'Chicago'], radioOptions), 'Chicago, IL');
  assert.equal(coerceToRadio(['Austin'], radioOptions), 'Austin, TX');

  // Comma-delimited string conversion with Best-Match
  assert.equal(coerceToRadio('Atlanta, Chicago', radioOptions), 'Chicago, IL');

  // Fallback when no option matches
  assert.equal(coerceToRadio(['Atlanta', 'Denver'], radioOptions), 'Atlanta');
});

test('coerceToMultiSelect splits comma strings, parses JSON arrays, and maps to options', () => {
  // Comma string
  assert.deepEqual(coerceToMultiSelect('Atlanta, Chicago'), ['Atlanta', 'Chicago']);

  // JSON string
  assert.deepEqual(coerceToMultiSelect('["Data Analyst", "AML"]'), ['Data Analyst', 'AML']);

  // Boolean
  assert.deepEqual(coerceToMultiSelect(true), ['Yes']);
  assert.deepEqual(coerceToMultiSelect(false), ['No']);

  // Array mapping to available options
  const targetOptions = ['Atlanta, GA', 'Chicago, IL', 'Dallas, TX'];
  assert.deepEqual(
    coerceToMultiSelect(['Atlanta', 'Chicago'], targetOptions),
    ['Atlanta, GA', 'Chicago, IL']
  );
});

test('coerceValueForField dispatches dynamically based on field type', () => {
  assert.equal(coerceValueForField('No', { type: 'checkbox' }), false);
  assert.equal(coerceValueForField('Yes', { type: 'checkbox' }), true);
  assert.equal(coerceValueForField(true, { type: 'radio', options: ['Yes', 'No'] }), 'Yes');
  assert.deepEqual(coerceValueForField('A, B', { type: 'multi-checkbox' }), ['A', 'B']);
  assert.equal(coerceValueForField(['First Choice'], { type: 'text' }), 'First Choice');
});

test('isFieldVisible handles boolean and Yes/No equivalence', () => {
  // Condition expects "Yes", parent value is boolean true
  const field1 = { visibleWhen: { field: 'sponsorship', equals: 'Yes' } };
  assert.equal(isFieldVisible(field1, { sponsorship: { value: true } }), true);
  assert.equal(isFieldVisible(field1, { sponsorship: { value: false } }), false);

  // Condition expects "No", parent value is boolean false
  const field2 = { visibleWhen: { field: 'sponsorship', equals: 'No' } };
  assert.equal(isFieldVisible(field2, { sponsorship: { value: false } }), true);
  assert.equal(isFieldVisible(field2, { sponsorship: { value: true } }), false);

  // Condition expects true, parent value is string "Yes"
  const field3 = { visibleWhen: { field: 'sponsorship', equals: true } };
  assert.equal(isFieldVisible(field3, { sponsorship: { value: 'Yes' } }), true);
  assert.equal(isFieldVisible(field3, { sponsorship: { value: 'No' } }), false);
});
