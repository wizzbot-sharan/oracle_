/**
 * Dynamic value coercion and best-match option selection module.
 * Bridges differences between question-bank answer formats and target form field types.
 */

/**
 * Tokenize a string into alphanumeric lower-case words.
 */
function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Scores how well a candidate's answer matches a target option.
 * Returns a score between 0 and 100.
 * - 100: Exact case-insensitive match
 * - 80: Substring containment (either candidate in option, or option in candidate)
 * - 60 * ratio: Token overlap (word-level similarity)
 */
export function scoreOptionMatch(candidateItem, targetOption) {
  const c = String(candidateItem ?? '').trim().toLowerCase();
  const o = String(targetOption ?? '').trim().toLowerCase();

  if (!c || !o) return 0;
  if (c === o) return 100;

  // Substring match: e.g. "Chicago" in "Chicago, IL" or "Full-time" in "Full-time Employee"
  if (o.includes(c) || c.includes(o)) {
    return 80;
  }

  // Token overlap match
  const cTokens = tokenize(c);
  const oTokens = tokenize(o);
  if (!cTokens.length || !oTokens.length) return 0;

  const oSet = new Set(oTokens);
  let overlapCount = 0;
  for (const token of cTokens) {
    if (oSet.has(token)) overlapCount++;
  }

  if (overlapCount > 0) {
    const ratio = overlapCount / Math.max(cTokens.length, oTokens.length);
    return Math.round(60 * ratio);
  }

  return 0;
}

/**
 * Given a list of candidate choices and available target options,
 * finds the target option that best matches any of the candidate choices.
 * Returns the matched target option string, or null if no match >= minScore.
 */
export function findBestOptionMatch(candidateChoices, targetOptions, minScore = 60) {
  const choices = Array.isArray(candidateChoices) ? candidateChoices : [candidateChoices];
  const options = Array.isArray(targetOptions) ? targetOptions : [];

  if (!choices.length || !options.length) return null;

  let bestOption = null;
  let highestScore = 0;

  for (const choice of choices) {
    if (choice === null || choice === undefined) continue;
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

/**
 * Coerces any value (string, boolean, number, array) to a safe boolean.
 * Strictly prevents truthy evaluation of "No", "false", 0, etc.
 */
export function coerceToBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  if (Array.isArray(value)) {
    if (!value.length) return false;
    return coerceToBoolean(value[0]);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (/^(true|yes|y|1|agree|accept|confirmed|on)$/i.test(trimmed)) return true;
    if (/^(false|no|n|0|disagree|decline|off|none)$/i.test(trimmed)) return false;
  }

  return Boolean(value);
}

/**
 * Coerces an answer for a single-choice Radio button.
 * Uses Best-Match dynamic selection if multiple choices exist.
 */
export function coerceToRadio(value, availableOptions = []) {
  if (value === null || value === undefined) return '';

  // Boolean answers -> "Yes" / "No"
  if (typeof value === 'boolean') {
    if (availableOptions.length > 0) {
      const truthyOption = availableOptions.find(opt => /^(yes|agree|true)$/i.test(String(opt).trim()));
      const falsyOption = availableOptions.find(opt => /^(no|disagree|false)$/i.test(String(opt).trim()));
      if (value && truthyOption) return truthyOption;
      if (!value && falsyOption) return falsyOption;
    }
    return value ? 'Yes' : 'No';
  }

  // Array of choices -> Best-match against available options
  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (availableOptions.length > 0) {
      const match = findBestOptionMatch(value, availableOptions);
      if (match) return match;
    }
    return String(value[0]);
  }

  // String with commas -> check if it represents multiple choices
  if (typeof value === 'string' && value.includes(',') && availableOptions.length > 0) {
    const splitChoices = value.split(',').map(s => s.trim()).filter(Boolean);
    const match = findBestOptionMatch(splitChoices, availableOptions);
    if (match) return match;
  }

  // Single string -> align with available options if present (e.g. case sensitivity)
  const str = String(value).trim();
  if (availableOptions.length > 0) {
    const exactCaseInsensitive = availableOptions.find(opt => String(opt).trim().toLowerCase() === str.toLowerCase());
    if (exactCaseInsensitive) return exactCaseInsensitive;
    const match = findBestOptionMatch([str], availableOptions);
    if (match) return match;
  }

  return str;
}

/**
 * Coerces an answer for a Multi-Select (checkbox group or pill section).
 * Returns Array of strings.
 */
export function coerceToMultiSelect(value, availableOptions = []) {
  if (value === null || value === undefined) return [];

  let items = [];

  if (Array.isArray(value)) {
    items = value.map(v => String(v).trim()).filter(Boolean);
  } else if (typeof value === 'boolean') {
    items = [value ? 'Yes' : 'No'];
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // Support JSON array string e.g. "[\"Option A\", \"Option B\"]"
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          items = parsed.map(v => String(v).trim()).filter(Boolean);
        }
      } catch {
        items = [trimmed];
      }
    } else if (trimmed.includes(',')) {
      items = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    } else if (trimmed) {
      items = [trimmed];
    }
  } else {
    items = [String(value).trim()];
  }

  // If available options exist, map each item to the closest matching option text
  if (availableOptions.length > 0 && items.length > 0) {
    const resolved = [];
    for (const item of items) {
      const match = findBestOptionMatch([item], availableOptions);
      resolved.push(match || item);
    }
    return [...new Set(resolved)];
  }

  return items;
}

/**
 * Coerces an answer for Combobox, Text, or Textarea inputs.
 */
export function coerceToString(value, availableOptions = []) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (availableOptions.length > 0) {
      const match = findBestOptionMatch(value, availableOptions);
      if (match) return match;
    }
    return String(value[0]);
  }

  return String(value);
}

/**
 * Master dispatcher: coerces an answer based on the target field's specification.
 */
export function coerceValueForField(value, field, liveOptions = []) {
  const options = (liveOptions && liveOptions.length > 0) ? liveOptions : (field?.options ?? []);
  const type = field?.type ?? 'text';

  if (type === 'checkbox') {
    return coerceToBoolean(value);
  }

  if (type === 'radio') {
    return coerceToRadio(value, options);
  }

  if (type === 'multi-checkbox') {
    return coerceToMultiSelect(value, options);
  }

  if (type === 'combobox' || type === 'text' || type === 'textarea' || type === 'tel') {
    return coerceToString(value, options);
  }

  return value;
}
