import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeAddress } from '../src/domain/address-decomposer.js';

test('decomposeAddress accurately decomposes address with apartment', () => {
  const fullAddress = '4867 Ashford Dunwoody rd, Apt 12311, Atlanta, Georgia, 30338, United States';
  const location = 'Atlanta, GA, United States';
  const state = 'Georgia';

  const res = decomposeAddress(fullAddress, location, state);

  assert.equal(res.addressLine1, '4867 Ashford Dunwoody rd');
  assert.equal(res.addressLine2, 'Apt 12311');
  assert.equal(res.city, 'Atlanta');
  assert.equal(res.state, 'Georgia');
  assert.equal(res.postalCode, '30338');
  assert.equal(res.country, 'United States');
});

test('decomposeAddress decomposes address with subdivision and location', () => {
  const fullAddress = '15295 Salano Creek Drive, Stonelake Estates West, Frisco, Texas, 75035, United States';
  const location = 'buffalo, New York, United States';
  const state = 'Texas';

  const res = decomposeAddress(fullAddress, location, state);

  assert.equal(res.addressLine1, '15295 Salano Creek Drive');
  assert.equal(res.city, 'Buffalo'); // derived from location
  assert.equal(res.state, 'Texas');
  assert.equal(res.postalCode, '75035');
  assert.equal(res.country, 'United States');
});

test('decomposeAddress handles standard street address without apartment', () => {
  const fullAddress = '2201 Strawberry Court, Edison, New Jersey, 08817, United States';
  const location = 'Edison, New Jersey, United States';
  const state = 'New Jersey';

  const res = decomposeAddress(fullAddress, location, state);

  assert.equal(res.addressLine1, '2201 Strawberry Court');
  assert.equal(res.addressLine2, '');
  assert.equal(res.city, 'Edison');
  assert.equal(res.state, 'New Jersey');
  assert.equal(res.stateAbbr, 'NJ');
  assert.equal(res.postalCode, '08817');
  assert.equal(res.country, 'United States');
});

test('decomposeAddress extracts explicit county and generates Oracle gridcell options', () => {
  const fullAddress = '13900, Marty Street, Overland Park, Johnson County, Kansas, 66223, United States';
  const location = 'Overland Park, Kansas, United States';
  const state = 'KANSAS';

  const res = decomposeAddress(fullAddress, location, state);

  assert.equal(res.addressLine1, '13900');
  assert.equal(res.addressLine2, 'Marty Street');
  assert.equal(res.city, 'Overland Park');
  assert.equal(res.stateAbbr, 'KS');
  assert.equal(res.postalCode, '66223');
  assert.equal(res.county, 'Johnson');
  assert.equal(res.gridcell.city, 'Overland Park, Johnson, KS');
  assert.equal(res.gridcell.postalCode, '66223, Overland Park, Johnson, KS');
  assert.equal(res.gridcell.county, 'Johnson, KS');
});
