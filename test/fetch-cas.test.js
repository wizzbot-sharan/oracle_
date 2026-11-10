import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvField, formatCasAsCsv } from '../scripts/fetch_cas.mjs';

test('escapeCsvField properly escapes commas, quotes, and newlines', () => {
  assert.equal(escapeCsvField('John Doe'), 'John Doe');
  assert.equal(escapeCsvField('Doe, Jane'), '"Doe, Jane"');
  assert.equal(escapeCsvField('Quote "Test"'), '"Quote ""Test"""');
  assert.equal(escapeCsvField('Line\nBreak'), '"Line\nBreak"');
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
});

test('formatCasAsCsv generates valid CSV string with header and rows', () => {
  const users = [
    {
      id: 'ca-1',
      name: 'Sharanya Peddi',
      email: 'sharanyapeddi@applywizz.ai',
      role: 'Junior CA'
    },
    {
      id: 'ca-2',
      name: 'Gundi, Dayakar',
      email: 'dayakar@applywizz.com',
      role: 'CA'
    }
  ];

  const csv = formatCasAsCsv(users);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'id,name,email,role');
  assert.equal(lines[1], 'ca-1,Sharanya Peddi,sharanyapeddi@applywizz.ai,Junior CA');
  assert.equal(lines[2], 'ca-2,"Gundi, Dayakar",dayakar@applywizz.com,CA');
});
