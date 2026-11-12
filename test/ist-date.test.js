import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTodayIstString,
  getYesterdayIstString,
  getIstDateString,
  formatIstTimestamp
} from '../src/utils/ist-date.js';

test('getIstDateString properly calculates IST date across UTC midnight boundary', () => {
  // 2026-11-12 18:29:59 UTC is 2026-11-12 23:59:59 IST (Same Day)
  const justBeforeMidnightIst = '2026-11-12T18:29:59.000Z';
  assert.equal(getIstDateString(justBeforeMidnightIst), '2026-11-12');

  // 2026-11-12 18:30:00 UTC is 2026-11-13 00:00:00 IST (Next Day in IST)
  const midnightIst = '2026-11-12T18:30:00.000Z';
  assert.equal(getIstDateString(midnightIst), '2026-11-13');
});

test('getTodayIstString and getYesterdayIstString return valid YYYY-MM-DD format', () => {
  const today = getTodayIstString();
  const yesterday = getYesterdayIstString();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(yesterday, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(today, yesterday);
});

test('formatIstTimestamp produces friendly IST representation', () => {
  // Mock current instant to test "Today" and "Yesterday"
  const now = new Date();
  const todayFormatted = formatIstTimestamp(now.toISOString());
  assert.ok(todayFormatted.startsWith('Today,'));
  assert.ok(todayFormatted.endsWith('IST'));

  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayFormatted = formatIstTimestamp(yesterdayDate.toISOString());
  assert.ok(yesterdayFormatted.startsWith('Yesterday,') || yesterdayFormatted.includes('IST'));

  // Test historical date
  const pastDate = '2025-01-15T10:00:00.000Z';
  const pastFormatted = formatIstTimestamp(pastDate);
  assert.ok(pastFormatted.includes('2025'));
  assert.ok(pastFormatted.endsWith('IST'));
});
