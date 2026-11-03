import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTemplateFields, isFieldVisible } from '../src/domain/form-template.js';

test('flattens simple, compound and repeatable fields', () => {
  const fields = flattenTemplateFields({ sections: [{
    id: 'profile',
    fields: [{ id: 'name', type: 'text' }, { id: 'phone', type: 'compound-phone', children: [{ id: 'number', type: 'tel' }] }],
    groups: [{ id: 'experience', addButton: 'Add Experience', fields: [{ id: 'employer', type: 'text' }] }]
  }] });
  assert.deepEqual(fields.map(field => field.id), ['name', 'number', 'experience', 'employer']);
  assert.equal(fields.find(field => field.id === 'experience').type, 'repeatable-group');
  assert.equal(fields.find(field => field.id === 'employer').repeatableGroupId, 'experience');
});

test('evaluates nested visibility conditions', () => {
  const field = { visibleWhen: { all: [{ field: 'source', equals: 'Employee Referral' }, { field: 'referred', equals: 'Yes' }] } };
  assert.equal(isFieldVisible(field, { source: { value: 'Employee Referral' }, referred: { value: 'Yes' } }), true);
  assert.equal(isFieldVisible(field, { source: { value: 'Other' }, referred: { value: 'Yes' } }), false);
});
