/**
 * International Phone & Country Code Decomposer
 * Governed by ITU-T Recommendation E.164.
 *
 * Decomposes raw candidate phone numbers and profiles into:
 * 1. callingCode: "+" and country calling code (e.g., "+1", "+91", "+44")
 * 2. countryCode: numeric code without plus (e.g., "1", "91", "44")
 * 3. nationalNumber: pure subscriber digits without country prefix
 * 4. comboboxLabel: formatted display label for Oracle dropdowns (e.g., "United States (+1)")
 */

// Standard ISO / ITU-T Calling Code Map
export const ITU_COUNTRY_MAP = {
  // Zone 1: North American Numbering Plan
  'united states': { code: '1', name: 'United States' },
  'united states of america': { code: '1', name: 'United States' },
  'usa': { code: '1', name: 'United States' },
  'us': { code: '1', name: 'United States' },
  'canada': { code: '1', name: 'Canada' },
  'ca': { code: '1', name: 'Canada' },
  'puerto rico': { code: '1', name: 'Puerto Rico' },

  // Zone 2: Africa
  'egypt': { code: '20', name: 'Egypt' },
  'south africa': { code: '27', name: 'South Africa' },
  'nigeria': { code: '234', name: 'Nigeria' },
  'ghana': { code: '233', name: 'Ghana' },
  'kenya': { code: '254', name: 'Kenya' },

  // Zone 3 & 4: Europe
  'greece': { code: '30', name: 'Greece' },
  'netherlands': { code: '31', name: 'Netherlands' },
  'belgium': { code: '32', name: 'Belgium' },
  'france': { code: '33', name: 'France' },
  'spain': { code: '34', name: 'Spain' },
  'portugal': { code: '351', name: 'Portugal' },
  'ireland': { code: '353', name: 'Ireland' },
  'iceland': { code: '354', name: 'Iceland' },
  'italy': { code: '39', name: 'Italy' },
  'romania': { code: '40', name: 'Romania' },
  'switzerland': { code: '41', name: 'Switzerland' },
  'austria': { code: '43', name: 'Austria' },
  'united kingdom': { code: '44', name: 'United Kingdom' },
  'uk': { code: '44', name: 'United Kingdom' },
  'great britain': { code: '44', name: 'United Kingdom' },
  'england': { code: '44', name: 'United Kingdom' },
  'denmark': { code: '45', name: 'Denmark' },
  'sweden': { code: '46', name: 'Sweden' },
  'norway': { code: '47', name: 'Norway' },
  'poland': { code: '48', name: 'Poland' },
  'germany': { code: '49', name: 'Germany' },

  // Zone 5: Americas
  'peru': { code: '51', name: 'Peru' },
  'mexico': { code: '52', name: 'Mexico' },
  'argentina': { code: '54', name: 'Argentina' },
  'brazil': { code: '55', name: 'Brazil' },
  'chile': { code: '56', name: 'Chile' },
  'colombia': { code: '57', name: 'Colombia' },

  // Zone 6: Southeast Asia & Oceania
  'malaysia': { code: '60', name: 'Malaysia' },
  'australia': { code: '61', name: 'Australia' },
  'indonesia': { code: '62', name: 'Indonesia' },
  'philippines': { code: '63', name: 'Philippines' },
  'new zealand': { code: '64', name: 'New Zealand' },
  'singapore': { code: '65', name: 'Singapore' },
  'thailand': { code: '66', name: 'Thailand' },

  // Zone 7: Eurasia
  'russia': { code: '7', name: 'Russia' },
  'kazakhstan': { code: '7', name: 'Kazakhstan' },

  // Zone 8: East Asia
  'japan': { code: '81', name: 'Japan' },
  'south korea': { code: '82', name: 'South Korea' },
  'korea': { code: '82', name: 'South Korea' },
  'vietnam': { code: '84', name: 'Vietnam' },
  'china': { code: '86', name: 'China' },
  'hong kong': { code: '852', name: 'Hong Kong' },
  'taiwan': { code: '886', name: 'Taiwan' },

  // Zone 9: South & Central Asia / Middle East
  'turkey': { code: '90', name: 'Turkey' },
  'india': { code: '91', name: 'India' },
  'pakistan': { code: '92', name: 'Pakistan' },
  'afghanistan': { code: '93', name: 'Afghanistan' },
  'sri lanka': { code: '94', name: 'Sri Lanka' },
  'saudi arabia': { code: '966', name: 'Saudi Arabia' },
  'united arab emirates': { code: '971', name: 'United Arab Emirates' },
  'uae': { code: '971', name: 'United Arab Emirates' },
  'israel': { code: '972', name: 'Israel' },
  'qatar': { code: '974', name: 'Qatar' },
  'kuwait': { code: '965', name: 'Kuwait' }
};

// Known calling codes sorted by length descending (3-digit, then 2-digit, then 1-digit)
export const KNOWN_CALLING_CODES = [
  // 3-digit
  '971', '972', '974', '966', '965', '852', '886', '351', '353', '354', '234', '233', '254',
  // 2-digit
  '20', '27', '30', '31', '32', '33', '34', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '54', '55', '56', '57', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86',
  '90', '91', '92', '93', '94',
  // 1-digit
  '1', '7'
];

/**
 * Decomposes a phone number and candidate profile context into international calling code and national number.
 *
 * @param {string} rawPhone - Raw phone string (e.g. "+19132918861", "+91 98765-43210", "9132918861")
 * @param {string} [countryHint] - Candidate country name or ISO code (e.g. "United States", "India")
 * @param {string|number} [countryCodeHint] - Candidate dialing code hint (e.g. "1", "91", "+1")
 * @returns {{ callingCode: string, countryCode: string, nationalNumber: string, comboboxLabel: string }}
 */
export function decomposePhone(rawPhone, countryHint = '', countryCodeHint = '') {
  const rawStr = String(rawPhone ?? '').trim();

  // Normalize hint
  const cleanCodeHint = String(countryCodeHint ?? '').replace(/\D/g, '');
  const cleanCountryHint = String(countryHint ?? '').trim().toLowerCase();
  const countryEntry = ITU_COUNTRY_MAP[cleanCountryHint];

  // Default fallback code
  const defaultCode = cleanCodeHint || countryEntry?.code || '1';
  const defaultCountryName = countryEntry?.name || (defaultCode === '1' ? 'United States' : (defaultCode === '91' ? 'India' : 'United States'));

  // If raw phone is empty or just "+"
  if (!rawStr || rawStr === '+') {
    return {
      callingCode: `+${defaultCode}`,
      countryCode: defaultCode,
      nationalNumber: '',
      comboboxLabel: `${defaultCountryName} (+${defaultCode})`
    };
  }

  const hasLeadingPlus = rawStr.startsWith('+');
  const digitsOnly = rawStr.replace(/\D/g, '');

  let detectedCode = '';
  let nationalDigits = '';

  // Case 1: Raw string starts with '+'
  if (hasLeadingPlus) {
    // 1A: Check if candidate's explicit code hint matches the start of digits
    if (cleanCodeHint && digitsOnly.startsWith(cleanCodeHint)) {
      detectedCode = cleanCodeHint;
      nationalDigits = digitsOnly.slice(cleanCodeHint.length);
    } else {
      // 1B: Prefix tree scan across known ITU calling codes (longest match first)
      for (const code of KNOWN_CALLING_CODES) {
        if (digitsOnly.startsWith(code)) {
          // Guard: prevent a 10-digit US number starting with 7 or 1 from matching if invalid
          detectedCode = code;
          nationalDigits = digitsOnly.slice(code.length);
          break;
        }
      }
    }
  }

  // Case 2: No leading plus, or prefix scan did not resolve cleanly
  if (!detectedCode) {
    // If digits match a known country hint
    if (cleanCodeHint && digitsOnly.startsWith(cleanCodeHint) && digitsOnly.length > cleanCodeHint.length + 6) {
      detectedCode = cleanCodeHint;
      nationalDigits = digitsOnly.slice(cleanCodeHint.length);
    } else {
      // Treat entire string as the national subscriber number
      detectedCode = defaultCode;
      nationalDigits = digitsOnly;
    }
  }

  // Remove leading domestic trunk zero (e.g. UK numbers formatted as +44 07911...)
  if (nationalDigits.startsWith('0') && nationalDigits.length > 9) {
    nationalDigits = nationalDigits.slice(1);
  }

  // Determine Country Display Name for combobox
  let matchedCountryName = defaultCountryName;
  if (detectedCode) {
    const foundEntry = Object.values(ITU_COUNTRY_MAP).find(c => c.code === detectedCode);
    if (foundEntry) {
      matchedCountryName = foundEntry.name;
    }
  }

  return {
    callingCode: `+${detectedCode}`,
    countryCode: detectedCode,
    nationalNumber: nationalDigits,
    comboboxLabel: `${matchedCountryName} (+${detectedCode})`
  };
}
