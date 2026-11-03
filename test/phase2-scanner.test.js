import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTemplateFields } from '../src/domain/form-template.js';

test('flattenTemplateFields maps repeatable group children and fields properly', () => {
  const template = {
    fields: [
      { id: 'first_name', label: 'First Name', type: 'text' }
    ],
    repeatableGroups: [
      {
        id: 'experience',
        label: 'experience',
        addButton: 'ADD EXPERIENCE',
        type: 'repeatable-group',
        fields: [
          { id: 'employer_name', label: 'Employer Name', type: 'text', required: true },
          { id: 'job_title', label: 'Job Title', type: 'text', required: false }
        ]
      },
      {
        id: 'certifications',
        label: 'certifications',
        addButton: 'Add Certification',
        type: 'repeatable-group',
        fields: [
          { id: 'cert_name', label: 'Certification Name', type: 'text', required: true }
        ]
      }
    ]
  };

  const flattened = flattenTemplateFields(template);
  assert.equal(flattened.length, 6);

  const groupExp = flattened.find(f => f.id === 'experience');
  assert.ok(groupExp);
  assert.equal(groupExp.children.length, 2);
  assert.equal(groupExp.children[0].id, 'employer_name');

  const groupCert = flattened.find(f => f.id === 'certifications');
  assert.ok(groupCert);
  assert.equal(groupCert.children.length, 1);
  assert.equal(groupCert.children[0].id, 'cert_name');
});

test('Dynamic group id slugification handles arbitrary Add button labels', () => {
  const clean = text => text.replace(/^(\+?\s*add|\+)\s+/i, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 100);

  assert.equal(clean('Add Experience'), 'experience');
  assert.equal(clean('+ Add Education'), 'education');
  assert.equal(clean('Add Prior Employment'), 'prior_employment');
  assert.equal(clean('Add Certification'), 'certification');
  assert.equal(clean('+ Add Another Link'), 'another_link');
  assert.equal(clean('Add Professional References'), 'professional_references');
});
