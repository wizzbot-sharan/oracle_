import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposePhone } from '../src/domain/phone-decomposer.js';

test('decomposePhone splits standard US E.164 number', () => {
  const result = decomposePhone('+19132918861');
  assert.equal(result.callingCode, '+1');
  assert.equal(result.countryCode, '1');
  assert.equal(result.nationalNumber, '9132918861');
  assert.equal(result.comboboxLabel, 'United States (+1)');
});

test('decomposePhone handles formatted US numbers with spaces and dashes', () => {
  const result = decomposePhone('+1 (913) 291-8861');
  assert.equal(result.callingCode, '+1');
  assert.equal(result.countryCode, '1');
  assert.equal(result.nationalNumber, '9132918861');
});

test('decomposePhone splits standard India E.164 number', () => {
  const result = decomposePhone('+919876543210', 'India', '91');
  assert.equal(result.callingCode, '+91');
  assert.equal(result.countryCode, '91');
  assert.equal(result.nationalNumber, '9876543210');
  assert.equal(result.comboboxLabel, 'India (+91)');
});

test('decomposePhone splits formatted India number without hints', () => {
  const result = decomposePhone('+91 98765-43210');
  assert.equal(result.callingCode, '+91');
  assert.equal(result.countryCode, '91');
  assert.equal(result.nationalNumber, '9876543210');
  assert.equal(result.comboboxLabel, 'India (+91)');
});

test('decomposePhone splits UK number and removes domestic trunk zero', () => {
  const result = decomposePhone('+44 07911 123456');
  assert.equal(result.callingCode, '+44');
  assert.equal(result.countryCode, '44');
  assert.equal(result.nationalNumber, '7911123456');
  assert.equal(result.comboboxLabel, 'United Kingdom (+44)');
});

test('decomposePhone handles 3-digit international calling code (UAE +971)', () => {
  const result = decomposePhone('+971 50 123 4567');
  assert.equal(result.callingCode, '+971');
  assert.equal(result.countryCode, '971');
  assert.equal(result.nationalNumber, '501234567');
  assert.equal(result.comboboxLabel, 'United Arab Emirates (+971)');
});

test('decomposePhone handles local 10-digit number without plus using country hint', () => {
  const result = decomposePhone('9132918861', 'United States', '1');
  assert.equal(result.callingCode, '+1');
  assert.equal(result.countryCode, '1');
  assert.equal(result.nationalNumber, '9132918861');
});

test('decomposePhone handles empty or plus-only input gracefully', () => {
  const result = decomposePhone('+', 'India', '91');
  assert.equal(result.callingCode, '+91');
  assert.equal(result.countryCode, '91');
  assert.equal(result.nationalNumber, '');
  assert.equal(result.comboboxLabel, 'India (+91)');
});
