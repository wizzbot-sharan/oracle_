import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchCurrencyOption,
  matchSalaryRangeBucket,
  matchDateComponent,
  matchEeoOption,
  matchBestOption
} from '../src/domain/option-matcher.js';

test('matchCurrencyOption aligns currency codes with employer dropdowns', () => {
  const oracleCurrencyOptions = [
    'Euro',
    'Pound Sterling',
    'Irish Pound',
    'Indian Rupee',
    'UAE Dirham',
    'Australian Dollar',
    'Brazilian Real',
    'Canadian Dollar',
    'US Dollar',
    'Polish Zloty'
  ];

  assert.equal(matchCurrencyOption('USD', oracleCurrencyOptions), 'US Dollar');
  assert.equal(matchCurrencyOption('EUR', oracleCurrencyOptions), 'Euro');
  assert.equal(matchCurrencyOption('GBP', oracleCurrencyOptions), 'Pound Sterling');
  assert.equal(matchCurrencyOption('INR', oracleCurrencyOptions), 'Indian Rupee');
  assert.equal(matchCurrencyOption('CAD', oracleCurrencyOptions), 'Canadian Dollar');
  assert.equal(matchCurrencyOption('AUD', oracleCurrencyOptions), 'Australian Dollar');
  assert.equal(matchCurrencyOption('XYZ', oracleCurrencyOptions), null);
});

test('matchSalaryRangeBucket matches candidate range against numeric buckets', () => {
  const oracleRangeBuckets = [
    '0 - 10,000',
    '10,001 - 20,000',
    '20,001 - 30,000',
    '30,001 - 40,000',
    '40,001 - 50,000',
    '50,001 - 60,000',
    '60,001 - 70,000',
    '70,001 - 100,000',
    '100,001 - 125,000',
    '125,001 - 150,000',
    '150,000+'
  ];

  // Candidate with 60k - 80k (midpoint 70k)
  const b1 = matchSalaryRangeBucket(60000, 80000, oracleRangeBuckets);
  assert.equal(b1, '60,001 - 70,000');

  // Candidate with 100k - 130k (midpoint 115k)
  const b2 = matchSalaryRangeBucket(100000, 130000, oracleRangeBuckets);
  assert.equal(b2, '100,001 - 125,000');

  // Candidate with 160k (150,000+)
  const b3 = matchSalaryRangeBucket(160000, 180000, oracleRangeBuckets);
  assert.equal(b3, '150,000+');

  // Candidate with 5,000
  const b4 = matchSalaryRangeBucket(5000, 5000, oracleRangeBuckets);
  assert.equal(b4, '0 - 10,000');
});

test('matchDateComponent resolves Month, Day, Year pickers', () => {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
  const years = ['2024', '2025', '2026', '2027'];

  // Test explicit date "2026-11-15"
  assert.equal(matchDateComponent('2026-11-15', 'month', months), 'November');
  assert.equal(matchDateComponent('2026-11-15', 'day', days), '15');
  assert.equal(matchDateComponent('2026-11-15', 'year', years), '2026');

  // Test abbreviation options
  const abbrMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  assert.equal(matchDateComponent('2026-11-15', 'month', abbrMonths), 'Nov');
});

test('matchEeoOption maps decline and identification phrasing', () => {
  const veteranOptions = [
    'I AM NOT A PROTECTED VETERAN',
    'I CHOOSE NOT TO SELF-IDENTIFY',
    'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS ABOVE'
  ];

  // Candidate declined
  assert.equal(matchEeoOption('veteran', 'I don’t wish to answer', veteranOptions), 'I CHOOSE NOT TO SELF-IDENTIFY');

  // Candidate not a veteran
  assert.equal(matchEeoOption('veteran', 'I am not a protected veteran', veteranOptions), 'I AM NOT A PROTECTED VETERAN');

  // Yes/No disability dropdown when candidate declined
  const yesNoOptions = ['Yes', 'No'];
  assert.equal(matchEeoOption('disability', 'I don’t wish to answer', yesNoOptions), 'No');

  // Candidate has no disability
  assert.equal(matchEeoOption('disability', 'No, I do not have a disability', yesNoOptions), 'No');
});

test('matchBestOption enforces score threshold and returns null on mismatch', () => {
  const options = ['Software Engineer', 'Data Scientist', 'Product Manager'];

  assert.equal(matchBestOption('Software Engineer', options, 80), 'Software Engineer');
  assert.equal(matchBestOption('Doctor of Medicine', options, 80), null);
});
