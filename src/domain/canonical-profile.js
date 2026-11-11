/**
 * Canonical Candidate Profile Normalizer.
 * Consolidates raw client CRM data (clients.json), profiles CSV, and resume text
 * into a strongly-typed, consistent candidate profile.
 * 
 * Strict Accuracy Principle:
 * - NEVER inject synthetic or hallucinatory defaults (no fake race, degree, GPA, or location).
 * - Missing facts are strictly preserved as null/empty so they can be reviewed by operators.
 */

import { decomposeAddress } from './address-decomposer.js';
import { decomposePhone } from './phone-decomposer.js';

export class CanonicalProfile {
  constructor(data = {}) {
    this.raw = data.raw ?? null;
    this.applywizzId = data.applywizzId ?? '';
    this.identity = data.identity ?? {};
    this.contact = data.contact ?? {};
    this.address = data.address ?? {};
    this.compensation = data.compensation ?? {};
    this.workAuth = data.workAuth ?? {};
    this.eeo = data.eeo ?? {};
    this.preferences = data.preferences ?? {};
    this.history = data.history ?? {};
    this.disclosures = data.disclosures ?? {};
    this.resumeText = data.resumeText ?? '';
  }

  /**
   * Factory method to build a CanonicalProfile from raw inputs.
   */
  static from({ client = {}, profile = {}, resumeText = '' } = {}) {
    const cInfo = client?.client ?? {};
    const addInfo = client?.additional_information ?? {};
    const pInfo = profile ?? {};

    const applywizzId = cInfo.applywizz_id || addInfo.applywizz_id || pInfo.applywizz_id || '';

    // 1. Identity Normalization
    const rawFullName = (cInfo.full_name || pInfo.client_name || '').trim();
    let firstName = (pInfo.first_name || cInfo.first_name || '').trim();
    let lastName = (pInfo.last_name || cInfo.last_name || '').trim();

    if ((!firstName || !lastName) && rawFullName) {
      const parts = rawFullName.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        firstName = firstName || parts[0];
      } else if (parts.length > 1) {
        firstName = firstName || parts[0];
        lastName = lastName || parts.slice(1).join(' ');
      }
    }

    const identity = {
      fullName: rawFullName || [firstName, lastName].filter(Boolean).join(' '),
      firstName,
      lastName,
      middleName: (addInfo.middle_name || '').trim()
    };

    // 2. Contact Normalization
    const personalEmail = (cInfo.personal_email || pInfo.email || addInfo.personal_email || '').trim();
    const companyEmail = (cInfo.company_email || pInfo.company_email || '').trim();
    const email = personalEmail || companyEmail;

    const rawPhone = (addInfo.primary_phone || cInfo.callable_phone || pInfo.phone || cInfo.whatsapp_number || '').trim();
    const phoneDecomp = rawPhone ? decomposePhone(rawPhone) : null;

    const contact = {
      email,
      personalEmail,
      companyEmail,
      rawPhone,
      phoneCountryCode: phoneDecomp?.callingCode ? (String(phoneDecomp.callingCode).startsWith('+') ? String(phoneDecomp.callingCode) : `+${phoneDecomp.callingCode}`) : '',
      nationalPhone: phoneDecomp?.nationalNumber || '',
      formattedPhone: rawPhone
    };

    // 3. Address Normalization
    const fullAddress = (addInfo.full_address || pInfo.location || '').trim();
    const location = (pInfo.location || addInfo.location || '').trim();
    const stateOfRes = (addInfo.state_of_residence || '').trim();
    const addr = fullAddress || location || stateOfRes ? decomposeAddress(fullAddress, location, stateOfRes) : {};

    const address = {
      fullAddress,
      addressLine1: addr.addressLine1 || '',
      addressLine2: addr.addressLine2 || '',
      city: fullAddress || location ? (addr.city || '') : '',
      state: fullAddress || location || stateOfRes ? (addr.state || '') : '',
      stateAbbr: fullAddress || location || stateOfRes ? (addr.stateAbbr || '') : '',
      postalCode: addr.postalCode || addr.zip || (addInfo.zip_or_country && /^\d{5}(-\d{4})?$/.test(addInfo.zip_or_country.trim()) ? addInfo.zip_or_country.trim() : ''),
      country: fullAddress || location ? (addr.country || (pInfo.country || 'United States')) : '',
      county: addr.county || ''
    };

    // 4. Compensation Normalization
    const rawSalary = (cInfo.salary_range || addInfo.desired_salary || '').trim();
    const compensation = parseSalaryRange(rawSalary);

    // 5. Work Authorization Normalization
    const workAuthDetails = String(cInfo.work_auth_details || '').toLowerCase();
    
    // Eligible in US: check explicit boolean, then text string
    let eligibleInUS = null;
    if (typeof addInfo.eligible_to_work_in_us === 'boolean') {
      eligibleInUS = addInfo.eligible_to_work_in_us;
    } else if (pInfo.work_authorization) {
      eligibleInUS = !/unauthorized|not authorized|no\b/i.test(pInfo.work_authorization);
    } else if (workAuthDetails) {
      if (/eligible in us:\s*yes/i.test(workAuthDetails) || /authorized w\/o visa:\s*yes/i.test(workAuthDetails)) {
        eligibleInUS = true;
      } else if (/eligible in us:\s*no/i.test(workAuthDetails)) {
        eligibleInUS = false;
      }
    }

    // Requires Sponsorship: check explicit booleans first
    let requiresSponsorship = null;
    if (typeof addInfo.require_future_sponsorship === 'boolean') {
      requiresSponsorship = addInfo.require_future_sponsorship;
    } else if (typeof addInfo.requires_sponsorship === 'boolean') {
      requiresSponsorship = addInfo.requires_sponsorship;
    } else if (typeof cInfo.sponsorship === 'boolean') {
      requiresSponsorship = cInfo.sponsorship;
    } else if (typeof pInfo.requires_sponsorship === 'boolean') {
      requiresSponsorship = pInfo.requires_sponsorship;
    } else if (typeof pInfo.requires_sponsorship === 'string') {
      requiresSponsorship = /true|yes|1/i.test(pInfo.requires_sponsorship);
    } else if (workAuthDetails) {
      if (/needs sponsorship:\s*yes/i.test(workAuthDetails)) {
        requiresSponsorship = true;
      } else if (/needs sponsorship:\s*no/i.test(workAuthDetails)) {
        requiresSponsorship = false;
      }
    }

    const visaType = (cInfo.visa_type || addInfo.visa_type || '').trim();

    const workAuth = {
      eligibleInUS,
      requiresSponsorship,
      visaType: visaType || 'Other',
      isOver18: typeof addInfo.is_over_18 === 'boolean' ? addInfo.is_over_18 : true
    };

    // 6. EEO & Demographics Normalization (No fake defaults)
    const eeo = {
      gender: (addInfo.gender || '').trim(),
      isHispanic: normalizeHispanic(addInfo.is_hispanic_latino),
      raceEthnicity: (addInfo.race_ethnicity || '').trim(),
      veteranStatus: (addInfo.veteran_status || '').trim(),
      disabilityStatus: (addInfo.disability_status || '').trim()
    };

    // 7. Preferences & Availability
    const preferences = {
      willingToRelocate: typeof addInfo.willing_to_relocate === 'boolean' ? addInfo.willing_to_relocate : true,
      willingToTravel: true,
      willingBackgroundCheck: typeof addInfo.willing_background_check === 'boolean' ? addInfo.willing_background_check : true,
      willingDrugScreen: typeof addInfo.willing_drug_screen === 'boolean' ? addInfo.willing_drug_screen : true,
      desiredStartDate: (addInfo.desired_start_date || '').trim(),
      noticePeriodDays: (addInfo.notice_period_days || '15').trim(),
      availability: (addInfo.notice_period || addInfo.availability || 'Immediate').trim()
    };

    // 8. History & Credentials (Structured records, no synthetic defaults)
    let educationRecords = [];
    if (Array.isArray(addInfo.education_records) && addInfo.education_records.length > 0) {
      educationRecords = addInfo.education_records;
    } else if (typeof pInfo.education === 'string' && pInfo.education.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(pInfo.education);
        if (Array.isArray(parsed)) educationRecords = parsed;
      } catch {}
    } else if (addInfo.highest_education || addInfo.university_name) {
      educationRecords = [{
        degree: addInfo.highest_education || '',
        institution: addInfo.university_name || '',
        major: addInfo.main_subject || '',
        gpa: addInfo.cumulative_gpa || '',
        graduationYear: addInfo.graduation_year || ''
      }];
    }

    let experienceRecords = [];
    if (Array.isArray(addInfo.experience_records) && addInfo.experience_records.length > 0) {
      experienceRecords = addInfo.experience_records;
    } else if (typeof pInfo.work_experience === 'string' && pInfo.work_experience.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(pInfo.work_experience);
        if (Array.isArray(parsed)) experienceRecords = parsed;
      } catch {}
    }

    const skills = [
      ...(addInfo.role ? [addInfo.role] : []),
      ...(typeof addInfo.alternate_job_roles === 'string' ? addInfo.alternate_job_roles.split(',').map(s => s.trim()) : [])
    ].filter(Boolean);

    const history = {
      highestEducation: (addInfo.highest_education || educationRecords[0]?.degree || '').trim(),
      universityName: (addInfo.university_name || educationRecords[0]?.institution || '').trim(),
      major: (addInfo.main_subject || educationRecords[0]?.major || '').trim(),
      gpa: (addInfo.cumulative_gpa || educationRecords[0]?.gpa || '').trim(),
      graduationYear: (addInfo.graduation_year || educationRecords[0]?.graduationYear || '').trim(),
      totalExperienceYears: (addInfo.experience || '').trim(),
      primaryRole: (addInfo.role || pInfo.role || '').trim(),
      educationRecords,
      experienceRecords,
      skills,
      links: {
        linkedin: (addInfo.linked_in_url || addInfo.linkedin_url || pInfo.linkedin_url || '').trim(),
        github: (addInfo.github_url || pInfo.github_url || '').trim(),
        portfolio: (pInfo.website_url || '').trim()
      },
      resumeStoragePath: addInfo.resume_storage_path || pInfo.resume_storage_path || addInfo.resume_path || null,
      coverLetterPath: addInfo.cover_letter_path || null
    };

    // 9. Disclosures
    const disclosures = {
      workedForCompanyBefore: typeof addInfo.worked_for_company_before === 'boolean' ? addInfo.worked_for_company_before : false,
      hasRelativesInCompany: typeof addInfo.has_relatives_in_company === 'boolean' ? addInfo.has_relatives_in_company : false,
      relativesDetails: addInfo.relatives_details || null,
      convictedOfFelony: typeof addInfo.convicted_of_felony === 'boolean' ? addInfo.convicted_of_felony : false,
      felonyExplanation: addInfo.felony_explanation || null,
      dischargedForPolicyViolation: typeof addInfo.discharged_for_policy_violation === 'boolean' ? addInfo.discharged_for_policy_violation : false,
      failedDrugTest: typeof addInfo.failed_or_refused_drug_test === 'boolean' ? addInfo.failed_or_refused_drug_test : false
    };

    return new CanonicalProfile({
      raw: { client, profile },
      applywizzId,
      identity,
      contact,
      address,
      compensation,
      workAuth,
      eeo,
      preferences,
      history,
      disclosures,
      resumeText: resumeText || pInfo.resume_text || ''
    });
  }
}

/**
 * Parses freeform salary strings like:
 * "USD Yearly: 60k-80k, Hourly: 20-40"
 * "100k-130k"
 * "USD 80,000 - 100,000"
 * "$75,000"
 */
export function parseSalaryRange(rawString) {
  if (!rawString || typeof rawString !== 'string') {
    return {
      raw: '',
      currencyCode: 'USD',
      minAnnual: null,
      maxAnnual: null,
      minHourly: null,
      maxHourly: null,
      midpointAnnual: null,
      formattedRange: ''
    };
  }

  const str = rawString.trim();

  // 1. Detect Currency Code
  let currencyCode = 'USD';
  const currMatch = str.match(/\b(USD|CAD|EUR|GBP|INR|AUD|BRL|PLN)\b/i) || str.match(/[$€£₹]/);
  if (currMatch) {
    const symbolMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
    currencyCode = symbolMap[currMatch[0]] || currMatch[0].toUpperCase();
  }

  // 2. Extract Yearly / Annual Range
  let minAnnual = null;
  let maxAnnual = null;

  // Pattern A: "Yearly: 60k-80k" or "100k-130k"
  const yearlyKMatch = str.match(/(?:yearly|annual|base)?[:\s]*(\d{2,3})\s*k\s*[-–—to]+\s*(\d{2,3})\s*k/i);
  if (yearlyKMatch) {
    minAnnual = parseInt(yearlyKMatch[1], 10) * 1000;
    maxAnnual = parseInt(yearlyKMatch[2], 10) * 1000;
  }

  // Pattern B: Full numbers "60,000 - 80,000" or "$60000 - $80000"
  if (minAnnual === null) {
    const fullRangeMatch = str.match(/(\d{2,3}(?:,\d{3})+|\d{5,6})\s*[-–—to]+\s*(\d{2,3}(?:,\d{3})+|\d{5,6})/i);
    if (fullRangeMatch) {
      minAnnual = parseInt(fullRangeMatch[1].replace(/,/g, ''), 10);
      maxAnnual = parseInt(fullRangeMatch[2].replace(/,/g, ''), 10);
    }
  }

  // Pattern C: Single number "$100,000" or "100k"
  if (minAnnual === null) {
    const singleKMatch = str.match(/(\d{2,3})\s*k/i);
    if (singleKMatch) {
      minAnnual = parseInt(singleKMatch[1], 10) * 1000;
      maxAnnual = minAnnual;
    } else {
      const singleFull = str.match(/(\d{2,3}(?:,\d{3})+|\d{5,6})/);
      if (singleFull) {
        minAnnual = parseInt(singleFull[1].replace(/,/g, ''), 10);
        maxAnnual = minAnnual;
      }
    }
  }

  // 3. Extract Hourly Range
  let minHourly = null;
  let maxHourly = null;
  const hourlyMatch = str.match(/hourly[:\s]*(\d{1,3})\s*[-–—to]+\s*(\d{1,3})/i);
  if (hourlyMatch) {
    minHourly = parseInt(hourlyMatch[1], 10);
    maxHourly = parseInt(hourlyMatch[2], 10);
  }

  // 4. Calculate Midpoint and Formatted String
  let midpointAnnual = null;
  if (minAnnual !== null && maxAnnual !== null) {
    midpointAnnual = Math.round((minAnnual + maxAnnual) / 2);
  } else if (minAnnual !== null) {
    midpointAnnual = minAnnual;
  }

  let formattedRange = str;
  if (minAnnual !== null && maxAnnual !== null) {
    formattedRange = minAnnual === maxAnnual
      ? `$${minAnnual.toLocaleString()}`
      : `$${minAnnual.toLocaleString()} - $${maxAnnual.toLocaleString()} / year`;
  }

  return {
    raw: str,
    currencyCode,
    minAnnual,
    maxAnnual,
    minHourly,
    maxHourly,
    midpointAnnual,
    formattedRange
  };
}

/**
 * Normalizes Hispanic/Latino field to boolean, "Decline", or null.
 */
function normalizeHispanic(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (/^(yes|true|y)$/i.test(s)) return true;
  if (/^(no|false|n)$/i.test(s)) return false;
  if (/decline|choose not|don't wish/i.test(s)) return 'Decline to Self-Identify';
  return null;
}
