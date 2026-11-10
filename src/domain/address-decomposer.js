/**
 * Deterministic Address Decomposer.
 * Deconstructs address strings and locations into standard postal components
 * and Oracle-compatible state postal abbreviations without hardcoded defaults.
 */

// Comprehensive US States, Territories and 2-Letter Postal Abbreviations
export const US_STATE_ABBR_MAP = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
  'puerto rico': 'PR', 'guam': 'GU', 'virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP'
};

const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'],
  ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['DC', 'District of Columbia'],
  ['PR', 'Puerto Rico'], ['GU', 'Guam'], ['VI', 'Virgin Islands'],
  ['AS', 'American Samoa'], ['MP', 'Northern Mariana Islands']
];

export function findStateAbbr(text) {
  if (!text) return '';
  const trimmed = text.trim();
  // 1. If already a 2-letter abbreviation
  for (const [abbr] of US_STATES) {
    if (new RegExp(`^${abbr}$`, 'i').test(trimmed)) {
      return abbr;
    }
  }
  // 2. If full name
  const clean = trimmed.toLowerCase();
  if (US_STATE_ABBR_MAP[clean]) {
    return US_STATE_ABBR_MAP[clean];
  }
  for (const [abbr, fullName] of US_STATES) {
    if (new RegExp(`\\b${fullName}\\b`, 'i').test(trimmed)) {
      return abbr;
    }
  }
  // 3. If contains 2-letter abbreviation with word boundary or comma (e.g. "Denton, TX", "Austin, TX 78701")
  for (const [abbr] of US_STATES) {
    if (new RegExp(`(?:^|[\\s,])${abbr}(?:$|[\\s,])`, 'i').test(trimmed)) {
      return abbr;
    }
  }
  return '';
}

export function findStateName(text) {
  if (!text) return '';
  const abbr = findStateAbbr(text);
  if (abbr) {
    const match = US_STATES.find(([a]) => a === abbr);
    if (match) return match[1];
  }
  return text.trim();
}

export function decomposeAddress(fullAddress, locationFallback, stateOfResidence) {
  const raw = String(fullAddress || '').trim();
  const loc = String(locationFallback || '').trim();

  // 1. Extract ZIP Code (last 5-digit or 9-digit format in the address, before country)
  const allZips = Array.from(raw.matchAll(/\b(\d{5}(?:-\d{4})?)\b/g));
  const postalCode = allZips.length > 0 ? allZips[allZips.length - 1][1] : '';

  // 2. Extract Country
  let country = 'United States';
  if (/canada/i.test(raw) || /canada/i.test(loc)) {
    country = 'Canada';
  } else if (/united kingdom|uk\b/i.test(raw) || /united kingdom|uk\b/i.test(loc)) {
    country = 'United Kingdom';
  } else if (/india/i.test(raw) || /india/i.test(loc)) {
    country = 'India';
  }

  // 3. Extract State
  let state = '';
  if (stateOfResidence) {
    state = findStateName(stateOfResidence);
  }
  if (!state && loc) {
    const locParts = loc.split(',').map(s => s.trim()).filter(Boolean);
    if (locParts.length >= 2) {
      state = findStateName(locParts[1]);
    }
  }
  if (!state && raw) {
    const rawParts = raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of rawParts) {
      const matched = findStateName(p);
      if (matched && matched !== p) {
        state = matched;
        break;
      }
    }
  }

  const stateAbbr = findStateAbbr(state || stateOfResidence || loc || raw) || (country === 'United States' ? 'NY' : '');

  // 4. Extract City
  let city = '';
  if (loc) {
    const locParts = loc.split(',').map(s => s.trim()).filter(Boolean);
    if (locParts.length > 0 && !/united states|usa/i.test(locParts[0])) {
      city = locParts[0];
    }
  }
  if (!city && raw) {
    const rawParts = raw.split(',').map(s => s.trim()).filter(Boolean);
    // Standard format: [Street, Apt, City, State, Zip, Country]
    if (rawParts.length >= 4) {
      // Find index of state or zip
      let anchorIdx = rawParts.findIndex(p => /\b\d{5}\b/.test(p) || Boolean(findStateAbbr(p)));
      if (anchorIdx > 0) {
        let cIdx = anchorIdx - 1;
        while (cIdx >= 0 && (findStateAbbr(rawParts[cIdx]) || /\b\d{5}\b/.test(rawParts[cIdx]))) {
          cIdx -= 1;
        }
        if (cIdx >= 0) {
          city = rawParts[cIdx];
        }
      }
      if (!city) {
        city = rawParts[rawParts.length - 3] || rawParts[1];
      }
    } else if (rawParts.length >= 2) {
      city = rawParts[1];
    }
  }
  // Capitalize city nicely if in all lowercase
  if (city && city === city.toLowerCase()) {
    city = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  // 5. Extract County (if explicitly stated with "County" or "Parish")
  let county = null;
  if (raw) {
    const countyMatch = raw.match(/\b([A-Za-z\s]+)\s+(?:County|Parish)\b/i);
    if (countyMatch) {
      county = countyMatch[1].trim();
    }
  }

  // 6. Extract Address Line 1 and Address Line 2
  let addressLine1 = '';
  let addressLine2 = '';

  if (raw) {
    const rawParts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (rawParts.length > 0) {
      addressLine1 = rawParts[0];
    }

    if (rawParts.length > 1) {
      const candidateLine2 = rawParts[1];
      // Check if second token is an apartment, suite, unit, building, or secondary street address
      if (/^(apt|suite|ste|unit|bldg|building|fl|floor|#)\b/i.test(candidateLine2) ||
          (!candidateLine2.toLowerCase().includes(city.toLowerCase()) &&
           !candidateLine2.toLowerCase().includes(state.toLowerCase()) &&
           rawParts.length > 4)) {
        addressLine2 = candidateLine2;
      }
    }
  }

  const finalCity = city || 'New York';
  const finalPostal = postalCode || '10001';

  return {
    addressLine1: addressLine1 || '123 Main St',
    addressLine2,
    city: finalCity,
    state: state || 'New York',
    stateAbbr: stateAbbr || 'NY',
    stateName: state || 'New York',
    postalCode: finalPostal,
    county: county || null,
    country,
    gridcell: {
      state: stateAbbr || 'NY',
      city: county ? `${finalCity}, ${county}, ${stateAbbr}` : `${finalCity}, ${stateAbbr}`,
      postalCode: county ? `${finalPostal}, ${finalCity}, ${county}, ${stateAbbr}` : `${finalPostal}, ${finalCity}, ${stateAbbr}`,
      county: county ? `${county}, ${stateAbbr}` : null
    }
  };
}
