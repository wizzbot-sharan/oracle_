/**
 * Specialized Option Matcher.
 * Provides high-precision matching against explicit dropdown/radio choices:
 * 1. Currency options (ISO codes & symbols -> Oracle currency dropdowns)
 * 2. Salary range buckets (numeric interval overlap matching)
 * 3. Composite date components (Month, Day, Year pickers)
 * 4. EEO & demographic options (with strict decline/identification mapping)
 * 5. General best option matcher with 80% confidence floor
 */

import { scoreOptionMatch } from './coercion.js';

// Currency ISO Code to Common Phrasings & Names
const CURRENCY_DICTIONARY = {
  USD: ['US Dollar', 'United States Dollar', 'USD', 'Dollar', 'US $', '$'],
  EUR: ['Euro', 'EUR', '€'],
  GBP: ['Pound Sterling', 'British Pound', 'Pound', 'GBP', '£'],
  INR: ['Indian Rupee', 'Rupee', 'INR', '₹'],
  CAD: ['Canadian Dollar', 'CAD', 'C$'],
  AUD: ['Australian Dollar', 'AUD', 'A$'],
  BRL: ['Brazilian Real', 'BRL', 'R$'],
  PLN: ['Polish Zloty', 'PLN', 'zł'],
  MXN: ['Mexican Peso', 'MXN'],
  JPY: ['Japanese Yen', 'JPY', '¥'],
  CHF: ['Swiss Franc', 'CHF'],
  SGD: ['Singapore Dollar', 'SGD', 'S$'],
  AED: ['UAE Dirham', 'AED', 'Dirham']
};

/**
 * Matches a currency code (e.g. "USD") to an available dropdown option.
 * Returns the exact target option string, or null if no valid match.
 */
export function matchCurrencyOption(currencyCode, targetOptions) {
  if (!currencyCode || !Array.isArray(targetOptions) || !targetOptions.length) {
    return null;
  }

  const cleanCode = String(currencyCode).toUpperCase().trim();
  const candidateAliases = CURRENCY_DICTIONARY[cleanCode] || [cleanCode];

  // 1. Exact or case-insensitive match against aliases
  for (const alias of candidateAliases) {
    const aliasLower = alias.toLowerCase();
    for (const opt of targetOptions) {
      const optStr = String(opt).trim();
      const optLower = optStr.toLowerCase();
      if (optLower === aliasLower) {
        return optStr;
      }
    }
  }

  // 2. Token-containment match (e.g. "US Dollar" matches option "US Dollar ($)")
  for (const alias of candidateAliases) {
    const aliasLower = alias.toLowerCase();
    for (const opt of targetOptions) {
      const optStr = String(opt).trim();
      const optLower = optStr.toLowerCase();
      if (optLower.includes(aliasLower) || aliasLower.includes(optLower)) {
        return optStr;
      }
    }
  }

  return null;
}

/**
 * Parses numeric salary range buckets from dropdown options and matches
 * the candidate's min and max annual salary.
 * 
 * Options format examples:
 * - "0 - 10,000"
 * - "60,001 - 70,000"
 * - "70,001 - 100,000"
 * - "150,000+"
 * - "Under $30,000"
 * - "More than $100,000"
 */
export function matchSalaryRangeBucket(minAnnual, maxAnnual, targetOptions) {
  if ((minAnnual === null && maxAnnual === null) || !Array.isArray(targetOptions) || !targetOptions.length) {
    return null;
  }

  const candidateMin = minAnnual ?? maxAnnual;
  const candidateMax = maxAnnual ?? minAnnual;
  const candidateMid = Math.round((candidateMin + candidateMax) / 2);

  const parsedBuckets = [];

  for (const opt of targetOptions) {
    const str = String(opt).trim();
    const cleanNumbers = str.replace(/[$,]/g, '');

    // Pattern A: "60001 - 70000"
    const rangeMatch = cleanNumbers.match(/(\d+)\s*[-–—to]+\s*(\d+)/i);
    if (rangeMatch) {
      parsedBuckets.push({
        option: opt,
        low: parseInt(rangeMatch[1], 10),
        high: parseInt(rangeMatch[2], 10)
      });
      continue;
    }

    // Pattern B: "150000+" or "More than 150000" or "Over 150000"
    const overMatch = cleanNumbers.match(/(?:over|more than|>|\+)\s*(\d+)|(\d+)\s*\+/i);
    if (overMatch) {
      const val = parseInt(overMatch[1] || overMatch[2], 10);
      parsedBuckets.push({
        option: opt,
        low: val,
        high: Infinity
      });
      continue;
    }

    // Pattern C: "Under 30000" or "Less than 30000" or "< 30000"
    const underMatch = cleanNumbers.match(/(?:under|less than|<)\s*(\d+)/i);
    if (underMatch) {
      const val = parseInt(underMatch[1], 10);
      parsedBuckets.push({
        option: opt,
        low: 0,
        high: val
      });
      continue;
    }
  }

  if (!parsedBuckets.length) {
    return null;
  }

  // 1. Check if midpoint falls cleanly into a bucket
  for (const b of parsedBuckets) {
    if (candidateMid >= b.low && candidateMid <= b.high) {
      return b.option;
    }
  }

  // 2. Calculate maximum numeric overlap
  let bestBucket = null;
  let maxOverlap = 0;

  for (const b of parsedBuckets) {
    const overlapLow = Math.max(candidateMin, b.low);
    const overlapHigh = Math.min(candidateMax, b.high === Infinity ? candidateMax : b.high);
    const overlap = Math.max(0, overlapHigh - overlapLow);

    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestBucket = b.option;
    }
  }

  return bestBucket;
}

/**
 * Matches a composite date component (Month, Day, Year) to an available dropdown option.
 */
export function matchDateComponent(dateStr, component, targetOptions) {
  if (!Array.isArray(targetOptions) || !targetOptions.length) {
    return null;
  }

  const monthsFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthsAbbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Default to today if dateStr is "Immediately" or "present" or empty
  let targetDate = new Date();
  if (dateStr && typeof dateStr === 'string' && !/immediately|present|current|asap/i.test(dateStr)) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      targetDate = parsed;
    }
  }

  if (component === 'month') {
    const mIdx = targetDate.getMonth(); // 0-11
    const full = monthsFull[mIdx];
    const abbr = monthsAbbr[mIdx];
    const num = String(mIdx + 1);
    const numPad = String(mIdx + 1).padStart(2, '0');

    // Priority 1: Full month name ("November")
    const matchFull = targetOptions.find(opt => String(opt).trim().toLowerCase() === full.toLowerCase());
    if (matchFull) return matchFull;

    // Priority 2: Abbreviation ("Nov")
    const matchAbbr = targetOptions.find(opt => String(opt).trim().toLowerCase() === abbr.toLowerCase());
    if (matchAbbr) return matchAbbr;

    // Priority 3: Numeric ("11")
    const matchNum = targetOptions.find(opt => String(opt).trim() === num || String(opt).trim() === numPad);
    if (matchNum) return matchNum;

    return null;
  }

  if (component === 'day') {
    const d = targetDate.getDate(); // 1-31
    const dayStr = String(d);
    const dayPad = String(d).padStart(2, '0');

    const match = targetOptions.find(opt => {
      const s = String(opt).trim();
      return s === dayStr || s === dayPad;
    });
    return match || null;
  }

  if (component === 'year') {
    const y = String(targetDate.getFullYear());
    const match = targetOptions.find(opt => String(opt).trim() === y);
    return match || null;
  }

  return null;
}

/**
 * Matches EEO categories (Gender, Race, Veteran, Disability) against form options,
 * with first-class support for decline / non-identification phrasing.
 */
export function matchEeoOption(category, candidateValue, targetOptions) {
  if (!Array.isArray(targetOptions) || !targetOptions.length) {
    return null;
  }

  const raw = String(candidateValue || '').trim();
  if (!raw) return null;

  const isDecline = /decline|choose not|don['’]t wish|prefer not|not wish|do not wish/i.test(raw);

  // 1. If candidate chose to decline/not answer:
  if (isDecline) {
    // Look for explicit decline options
    const declineOption = targetOptions.find(opt =>
      /decline|choose not|prefer not|not self-identify|don['’]t wish/i.test(String(opt).trim())
    );
    if (declineOption) return declineOption;

    // If options are only Yes/No:
    const hasOnlyYesNo = targetOptions.length === 2 &&
      targetOptions.some(o => /^yes$/i.test(String(o).trim())) &&
      targetOptions.some(o => /^no$/i.test(String(o).trim()));

    if (hasOnlyYesNo) {
      // For protected classes (Disability, Veteran), declining maps safely to "No"
      return targetOptions.find(o => /^no$/i.test(String(o).trim())) || null;
    }

    return null;
  }

  // 2. Non-decline: Veteran Status
  if (category === 'veteran') {
    const isNotVeteran = /not\s*(a\s*)?protected|i\s*am\s*not\s*a\s*veteran|no\b/i.test(raw);
    if (isNotVeteran) {
      const match = targetOptions.find(opt =>
        /not\s*(a\s*)?protected|not\s*a\s*veteran|^no$/i.test(String(opt).trim())
      );
      if (match) return match;
    }
  }

  // 3. Non-decline: Disability Status
  if (category === 'disability') {
    const hasNoDisability = /no[,\s]+i\s*do\s*not|do\s*not\s*have\s*a\s*disability|^no$/i.test(raw);
    if (hasNoDisability) {
      const match = targetOptions.find(opt =>
        /no[,\s]+i\s*do\s*not|do\s*not\s*have|^no$/i.test(String(opt).trim())
      );
      if (match) return match;
    }
    const hasDisability = /yes[,\s]+i\s*have|have\s*a\s*disability|^yes$/i.test(raw);
    if (hasDisability) {
      const match = targetOptions.find(opt =>
        /yes[,\s]+i\s*have|^yes$/i.test(String(opt).trim())
      );
      if (match) return match;
    }
  }

  // 4. Standard option fuzzy match (Score >= 80)
  return matchBestOption([raw], targetOptions, 80);
}

/**
 * Strict Best Option Matcher.
 * Requires match score >= minScore (default 80).
 * Returns null if no option satisfies the threshold.
 */
export function matchBestOption(candidateChoices, targetOptions, minScore = 80) {
  const choices = Array.isArray(candidateChoices) ? candidateChoices : [candidateChoices];
  const options = Array.isArray(targetOptions) ? targetOptions : [];

  if (!choices.length || !options.length) return null;

  let bestOption = null;
  let highestScore = 0;

  for (const choice of choices) {
    if (choice === null || choice === undefined || String(choice).trim() === '') continue;
    for (const option of options) {
      if (option === null || option === undefined) continue;
      const score = scoreOptionMatch(choice, option);
      if (score > highestScore) {
        highestScore = score;
        bestOption = option;
      }
    }
  }

  return highestScore >= minScore ? bestOption : null;
}
