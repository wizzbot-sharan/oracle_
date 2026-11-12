export const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Returns current date string in IST format: 'YYYY-MM-DD'
 * @param {Date} [referenceDate] Optional reference date (defaults to now)
 * @returns {string}
 */
export function getTodayIstString(referenceDate = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(referenceDate);
}

/**
 * Returns yesterday's date string in IST format: 'YYYY-MM-DD'
 * @param {Date} [referenceDate] Optional reference date (defaults to now)
 * @returns {string}
 */
export function getYesterdayIstString(referenceDate = new Date()) {
  const yesterday = new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000);
  return getTodayIstString(yesterday);
}

/**
 * Converts a UTC timestamp into an IST date string: 'YYYY-MM-DD'
 * @param {string|number|Date} utcTimestamp
 * @returns {string|null}
 */
export function getIstDateString(utcTimestamp) {
  if (!utcTimestamp) return null;
  const date = new Date(utcTimestamp);
  if (isNaN(date.getTime())) return null;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

/**
 * Formats a UTC timestamp into a human-friendly IST display string:
 * "Today, 6:45 PM IST" / "Yesterday, 11:20 AM IST" / "12 Nov 2026, 6:45 PM IST"
 * @param {string|number|Date} utcTimestamp
 * @returns {string}
 */
export function formatIstTimestamp(utcTimestamp) {
  if (!utcTimestamp) return 'N/A';
  const date = new Date(utcTimestamp);
  if (isNaN(date.getTime())) return 'N/A';

  const istDateStr = getIstDateString(utcTimestamp);
  const todayStr = getTodayIstString();
  const yesterdayStr = getYesterdayIstString();

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const timeStr = timeFormatter.format(date);

  if (istDateStr === todayStr) {
    return `Today, ${timeStr} IST`;
  }
  if (istDateStr === yesterdayStr) {
    return `Yesterday, ${timeStr} IST`;
  }

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  return `${dateFormatter.format(date)}, ${timeStr} IST`;
}
