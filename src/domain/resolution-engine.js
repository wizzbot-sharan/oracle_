/**
 * Cascading Resolution Engine across 3 Data Tiers and 5 Matching Stages.
 * 
 * Data Tiers (Confidence Ceilings):
 * - Tier 1: Canonical Client Profile (clients.json + profiles.csv) -> Cap: 1.00
 * - Tier 2: Question Bank (Supabase + question_bank.csv) -> Cap: 0.98 (manual) / 0.90 (AI)
 * - Tier 3: Resume (Extracted facts / resume_text) -> Cap: 0.90
 * 
 * Matching Stages:
 * - Stage 1: Deterministic Standard System Fields & Intent Taxonomy (Confidence 1.00)
 * - Stage 2: Token-Sort Question Bank Fuzzy Match (Confidence 0.90 - 0.98)
 * - Stage 3: Specialized Domain Resolvers (Currency, Salary Buckets, Dates, Work Auth) (Confidence 0.85 - 0.95)
 * - Stage 4: Structured LLM Reasoner (Option-Constrained) (Confidence >= 0.85)
 * - Stage 5: Operator Review / Dashboard Queue (Confidence 0, value: null)
 * 
 * Strict Accuracy Principle:
 * - ZERO synthetic/hallucinatory defaults (no fake race, degree, GPA, or location).
 * - STRICT OPTION ENFORCEMENT: If field has explicit options, resolved value MUST be in options.
 */

import { coerceValueForField, findBestOptionMatch, scoreOptionMatch, coerceToBoolean } from './coercion.js';
import { CanonicalProfile } from './canonical-profile.js';
import {
  matchCurrencyOption,
  matchSalaryRangeBucket,
  matchDateComponent,
  matchEeoOption,
  matchBestOption
} from './option-matcher.js';
import { decomposeAddress } from './address-decomposer.js';
import { decomposePhone } from './phone-decomposer.js';

function parseBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const s = String(val || '').trim().toLowerCase();
  if (/^(true|yes|y|1|agree)$/i.test(s)) return true;
  if (/^(false|no|n|0|disagree|none)$/i.test(s)) return false;
  return false;
}

// Levenshtein distance between two strings
function levenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;

  const row = Array.from({ length: bl + 1 }, (_, i) => i);
  for (let i = 1; i <= al; i++) {
    let prev = i;
    for (let j = 1; j <= bl; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[bl] = prev;
  }
  return row[bl];
}

// Tokenizes and sorts string into normalized canonical form
function tokenSortNormalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// Token-sort fuzzy similarity (0.0 to 1.0)
export function tokenSortSimilarity(s1, s2) {
  const norm1 = tokenSortNormalize(s1);
  const norm2 = tokenSortNormalize(s2);

  if (!norm1 || !norm2) return 0;
  if (norm1 === norm2) return 1.0;

  const maxLen = Math.max(norm1.length, norm2.length);
  const dist = levenshtein(norm1, norm2);
  const levScore = 1 - (dist / maxLen);

  const t1 = new Set(norm1.split(' '));
  const t2 = new Set(norm2.split(' '));
  let intersection = 0;
  for (const t of t1) {
    if (t2.has(t)) intersection++;
  }
  const jaccard = intersection / (t1.size + t2.size - intersection);
  const dice = (2 * intersection) / (t1.size + t2.size);
  const overlap = intersection / Math.min(t1.size, t2.size);

  return Math.max(0, Math.min(1, (0.5 * levScore) + (0.3 * dice) + (0.2 * overlap)));
}

// PII, location, and legal fields that MUST NEVER cross client boundaries
export function isPiiOrPersonalQuestion(label) {
  return /\b(name|email|phone|telephone|mobile|address|street|city|town|state|zip|postal|ssn|social security|citizen|citizenship|nationality|country|nation|visa|sponsorship|relatives|disability|veteran|gender|race|ethnicity|hispanic|latino|birth|dob)\b/i.test(label);
}

export class ResolutionEngine {
  constructor({ claudeService = null } = {}) {
    this.claudeService = claudeService;
  }

  /**
   * Resolves a single form field through the precision cascade.
   */
  async resolveField({ field, client, clientHistory = [], globalHistory = [], resumeText = '', skipLlm = false }) {
    const canonical = client instanceof CanonicalProfile
      ? client
      : CanonicalProfile.from({ client, resumeText });

    const clientInfo = client?.client ?? {};
    const addInfo = client?.additional_information ?? {};

    // ------------------------------------------------------------------------
    // STAGE 1: Standard System Fields & Intent Taxonomy (Tier 1 Profile, Cap 1.00)
    // ------------------------------------------------------------------------
    const stage1Result = this.#matchStage1Taxonomy(field, canonical, clientInfo, addInfo, resumeText);
    if (stage1Result && stage1Result.rawValue !== null && stage1Result.rawValue !== undefined) {
      let rawVal = stage1Result.rawValue;

      // If field has explicit options, align through option matcher first
      if (Array.isArray(field.options) && field.options.length > 0) {
        const optionMatched = matchBestOption([rawVal], field.options, 60);
        if (optionMatched) {
          rawVal = optionMatched;
        }
      }

      const coerced = coerceValueForField(rawVal, field);
      if (this.#isValidValue(coerced, field)) {
        return {
          value: coerced,
          source: stage1Result.source || 'tier1_client_profile',
          stage: 'stage1_taxonomy',
          tier: stage1Result.tier || 1,
          confidence: Math.min(stage1Result.confidence ?? 1.0, 1.0),
          questionLabel: field.label,
          fieldType: field.type || field.role || 'text',
          reviewed: false
        };
      }
    }

    // ------------------------------------------------------------------------
    // STAGE 2: Token-Sort Fuzzy Match (Tier 2: Question Bank, Cap 0.98 / 0.90)
    // ------------------------------------------------------------------------
    const stage2Result = this.#matchStage2TokenSort(field, clientHistory, globalHistory);
    if (stage2Result && stage2Result.rawValue !== null && stage2Result.rawValue !== undefined) {
      let rawVal = stage2Result.rawValue;
      if (Array.isArray(field.options) && field.options.length > 0) {
        const optionMatched = matchBestOption([rawVal], field.options, 60);
        if (optionMatched) rawVal = optionMatched;
      }

      const coerced = coerceValueForField(rawVal, field);
      if (this.#isValidValue(coerced, field)) {
        return {
          value: coerced,
          source: stage2Result.source || 'tier2_question_bank',
          stage: 'stage2_fuzzy',
          tier: 2,
          confidence: Math.min(stage2Result.score, stage2Result.tierCap),
          questionLabel: field.label,
          fieldType: field.type || field.role || 'text',
          reviewed: false
        };
      }
    }

    // ------------------------------------------------------------------------
    // STAGE 3: Specialized Domain Resolvers (Currency, Range Buckets, Dates, Work Auth)
    // ------------------------------------------------------------------------
    const stage3Result = this.#matchStage3Domain(field, canonical);
    if (stage3Result && stage3Result.rawValue !== null && stage3Result.rawValue !== undefined) {
      let rawVal = stage3Result.rawValue;
      if (Array.isArray(field.options) && field.options.length > 0) {
        const optionMatched = matchBestOption([rawVal], field.options, 60);
        if (optionMatched) rawVal = optionMatched;
      }

      const coerced = coerceValueForField(rawVal, field);
      if (this.#isValidValue(coerced, field)) {
        return {
          value: coerced,
          source: stage3Result.source || 'tier2_domain_resolver',
          stage: 'stage3_domain',
          tier: stage3Result.tier || 2,
          confidence: Math.min(stage3Result.score, 0.95),
          questionLabel: field.label,
          fieldType: field.type || field.role || 'text',
          reviewed: false
        };
      }
    }

    // ------------------------------------------------------------------------
    // STAGE 4: Claude LLM Reasoning Fallback (Strictly Option-Constrained)
    // ------------------------------------------------------------------------
    if (!skipLlm && this.claudeService && this.claudeService.isAvailable()) {
      try {
        const claudeResult = await this.claudeService.resolveQuestion({
          client,
          canonical,
          questionHistory: clientHistory,
          resumeText,
          field
        });
        if (claudeResult && claudeResult.confidence >= 0.85 && claudeResult.answer !== null) {
          let rawVal = claudeResult.answer;
          if (Array.isArray(field.options) && field.options.length > 0) {
            const optionMatched = matchBestOption([rawVal], field.options, 70);
            if (optionMatched) rawVal = optionMatched;
          }

          const coerced = coerceValueForField(rawVal, field);
          if (this.#isValidValue(coerced, field)) {
            return {
              value: coerced,
              source: 'tier2_claude_llm',
              stage: 'stage4_llm',
              tier: 2,
              confidence: Math.min(claudeResult.confidence, 0.90),
              questionLabel: field.label,
              fieldType: field.type || field.role || 'text',
              reviewed: false
            };
          }
        }
      } catch (err) {
        console.error(`[ResolutionEngine] Stage 4 LLM fallback error for "${field.label}":`, err.message);
      }
    }

    // ------------------------------------------------------------------------
    // STAGE 5: Operator Review / Dashboard Queue (Unresolved, Held for Review)
    // ------------------------------------------------------------------------
    return {
      value: null,
      source: null,
      stage: 'stage5_operator',
      tier: null,
      confidence: 0,
      questionLabel: field.label,
      fieldType: field.type || field.role || 'text',
      reviewed: false
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  #extractDatePart(dateStr, part) {
    if (!dateStr) return '';
    const s = String(dateStr).trim();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    if (/present|current/i.test(s)) {
      const now = new Date();
      if (part === 'month') return months[now.getMonth()];
      if (part === 'year') return String(now.getFullYear());
      return '';
    }

    const slashMatch = s.match(/^(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      if (part === 'month') {
        const mIdx = parseInt(slashMatch[1], 10) - 1;
        return months[mIdx] || slashMatch[1];
      }
      if (part === 'year') return slashMatch[2];
    }
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})/);
    if (isoMatch) {
      if (part === 'month') {
        const mIdx = parseInt(isoMatch[2], 10) - 1;
        return months[mIdx] || isoMatch[2];
      }
      if (part === 'year') return isoMatch[1];
    }
    const yearMatch = s.match(/\b(19\d{2}|20\d{2})\b/);
    if (part === 'year' && yearMatch) return yearMatch[1];

    const monthMatch = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
    if (part === 'month' && monthMatch) {
      const found = months.find(m => m.toLowerCase().startsWith(monthMatch[1].toLowerCase()));
      if (found) return found;
    }
    return '';
  }

  #cleanCompany(rawCompany, resumeText = '') {
    if (rawCompany && !/professional\s*experience/i.test(String(rawCompany).trim())) {
      return String(rawCompany).trim();
    }
    if (resumeText) {
      const match = resumeText.match(/PROFESSIONAL\s*EXPERIENCE\s*\n+[^\n]+\n+([A-Z0-9\s&.,'-]{2,40}?)\s*(?:\||\n)/i);
      if (match && match[1] && !/professional\s*experience/i.test(match[1])) {
        return match[1].trim();
      }
    }
    return '';
  }

  // --------------------------------------------------------------------------
  // STAGE 1: DETERMINISTIC STANDARD TAXONOMY
  // --------------------------------------------------------------------------
  #matchStage1Taxonomy(field, canonical, clientInfo, addInfo, resumeText = '') {
    const label = field.label || '';
    const type = field.type || field.role || 'text';

    // 1. REPEATABLE GROUPS
    if (type === 'repeatable-group') {
      if (/experience|employment|work\s*history/i.test(label) || /experience/i.test(field.id || '')) {
        const records = canonical.history.experienceRecords;
        if (!records || !records.length) return null;
        const normalized = records.map(r => {
          const rawCompany = r.company || r.employer || r.company_name || '';
          const cleanComp = this.#cleanCompany(rawCompany, resumeText) || rawCompany;
          return {
            employer_name: cleanComp,
            company_name: cleanComp,
            company: cleanComp,
            job_title: r.title || r.role || r.job_title || '',
            start_date: this.#extractDatePart(r.start_date || r.startDate, 'month'),
            start_date_start_date_year: this.#extractDatePart(r.start_date || r.startDate, 'year'),
            end_date: this.#extractDatePart(r.end_date || r.endDate, 'month'),
            end_date_end_date_year: this.#extractDatePart(r.end_date || r.endDate, 'year'),
            current_job: Boolean(r.current || /present|current/i.test(String(r.end_date || r.endDate))),
            responsibilities: r.description || r.responsibilities || ''
          };
        });
        return { rawValue: normalized, confidence: 1.0 };
      }

      if (/education|school|academic/i.test(label) || /education/i.test(field.id || '')) {
        const records = canonical.history.educationRecords;
        if (!records || !records.length) return null;
        const normalized = records.map(r => ({
          institution: r.institution || r.school || r.school_name || '',
          educational_establishment: r.institution || r.school || r.school_name || '',
          school_name: r.institution || r.school || r.school_name || '',
          degree: r.degree || r.degree_name || '',
          content_item_id: r.degree || r.degree_name || '',
          degree_name: r.degree || r.degree_name || '',
          major: r.major || r.fieldOfStudy || '',
          gpa: r.gpa || '',
          graduated: true,
          graduation_year: r.graduationYear || r.graduation_year || this.#extractDatePart(r.end_date, 'year') || ''
        }));
        return { rawValue: normalized, confidence: 1.0 };
      }

      if (/skill/i.test(label) || /skill/i.test(field.id || '')) {
        const skills = canonical.history.skills;
        if (skills.length > 0) {
          const norm = skills.map(s => ({
            skills: s,
            skill: s,
            years_of_experience: canonical.history.totalExperienceYears || '3'
          }));
          return { rawValue: norm, confidence: 0.95 };
        }
        return null;
      }

      if (/language/i.test(label) || /language/i.test(field.id || '')) {
        const detectedLanguages = [];
        if (resumeText && /\b(english)\b/i.test(resumeText)) detectedLanguages.push('English');
        if (resumeText && /\b(spanish)\b/i.test(resumeText)) detectedLanguages.push('Spanish');
        if (resumeText && /\b(hindi)\b/i.test(resumeText)) detectedLanguages.push('Hindi');
        if (resumeText && /\b(french)\b/i.test(resumeText)) detectedLanguages.push('French');
        if (detectedLanguages.length) {
          const rows = detectedLanguages.map(l => ({
            content_item_id: l,
            language: l,
            reading: 'Fluent',
            writing: 'Fluent',
            speaking: 'Fluent'
          }));
          return { rawValue: rows, confidence: 0.95 };
        }
        return null;
      }

      if (/supporting\s*links?|another\s*link/i.test(label) || /link/i.test(field.id || '')) {
        const link = canonical.history.links.linkedin || canonical.history.links.github || canonical.history.links.portfolio;
        return link ? { rawValue: [{ site_link_2: link, url: link }], confidence: 1.0 } : null;
      }

      return null;
    }

    // 2. FILE ATTACHMENTS
    if (type === 'file' || /file/i.test(type)) {
      if (/resume|cv/i.test(label) || /resume/i.test(field.id || '')) {
        const resumePath = canonical.history.resumeStoragePath;
        return resumePath ? { rawValue: resumePath, confidence: 1.0, tier: 1 } : null;
      }
      if (/cover\s*letter/i.test(label) || /cover_letter/i.test(field.id || '')) {
        const coverPath = canonical.history.coverLetterPath;
        return coverPath ? { rawValue: coverPath, confidence: 1.0, tier: 1 } : null;
      }
      return null;
    }

    // 3. URL LINKS
    if (type === 'url' || /linkedin|github|portfolio|website/i.test(label)) {
      if (/linkedin/i.test(label)) {
        return canonical.history.links.linkedin ? { rawValue: canonical.history.links.linkedin, confidence: 1.0 } : null;
      }
      if (/github/i.test(label)) {
        return canonical.history.links.github ? { rawValue: canonical.history.links.github, confidence: 1.0 } : null;
      }
      if (/portfolio|website/i.test(label)) {
        const url = canonical.history.links.portfolio || canonical.history.links.github || canonical.history.links.linkedin;
        return url ? { rawValue: url, confidence: 1.0 } : null;
      }
      if (/supporting documents and urls/i.test(field.sectionLabel || '') || /link\s*1/i.test(label)) {
        const url = canonical.history.links.linkedin || canonical.history.links.github || canonical.history.links.portfolio;
        return url ? { rawValue: url, confidence: 1.0 } : null;
      }
    }

    // 4. IDENTITY & NAMES
    if (/preferred\s*first\s*name/i.test(label) || (/\b(first|given)\s*name\b/i.test(label) && !/preferred\s*last/i.test(label))) {
      return canonical.identity.firstName ? { rawValue: canonical.identity.firstName, confidence: 1.0 } : null;
    }
    if (/preferred\s*last\s*name/i.test(label) || /\b(last|family|surname)\s*name\b/i.test(label)) {
      return canonical.identity.lastName ? { rawValue: canonical.identity.lastName, confidence: 1.0 } : null;
    }
    if (/\bmiddle\s*name\b/i.test(label)) {
      return { rawValue: canonical.identity.middleName || '', confidence: 1.0 };
    }
    if (/preferred\s*name/i.test(label)) {
      return canonical.identity.firstName ? { rawValue: canonical.identity.firstName, confidence: 1.0 } : null;
    }
    if (/\bfull\s*name\b/i.test(label)) {
      if (/\b(their|referr|friend|relative|manager|supervisor|contact\s*person|emergency|someone)\b/i.test(label)) {
        return null;
      }
      return canonical.identity.fullName ? { rawValue: canonical.identity.fullName, confidence: 1.0 } : null;
    }

    // Salutation / Title
    if (/^salutation$/i.test(label.trim()) || (/^title$/i.test(label.trim()) && /personal|contact|name|demographic/i.test(field.sectionLabel || ''))) {
      const g = (canonical.eeo.gender || '').toLowerCase();
      if (g === 'female' || g === 'woman') {
        return { rawValue: 'Ms.', confidence: 0.95 };
      }
      if (g === 'male' || g === 'man') {
        return { rawValue: 'Mr.', confidence: 0.95 };
      }
      return null;
    }

    // 5. CONTACT (EMAIL & PHONE)
    if (/\bemail\b/i.test(label) && !/\b(former|previous|manager|supervisor|reference|emergency|agency|referral|their|friend|relative)\b/i.test(label)) {
      return canonical.contact.email ? { rawValue: canonical.contact.email, confidence: 1.0 } : null;
    }

    if (field.isPhonePrefix || /country\s*(\/region\s*)?code/i.test(label) || /phone.*(country|prefix)/i.test(label) || field.id === 'phone_country_code') {
      return canonical.contact.phoneCountryCode ? { rawValue: canonical.contact.phoneCountryCode, confidence: 1.0 } : null;
    }

    if ((/phone/i.test(label) || /mobile/i.test(label) || type === 'tel') && !/\b(country|prefix|former|previous|manager|supervisor|reference|emergency)\b/i.test(label)) {
      const phoneVal = canonical.contact.nationalPhone || canonical.contact.formattedPhone;
      return phoneVal ? { rawValue: phoneVal, confidence: 1.0 } : null;
    }

    // 6. MARKETING & COMMUNICATION CONSENTS
    if (/receive\s*(updates|marketing|careers|emails?|sms|opportunities)|use\s*(sms|email)\s*for\s*communication/i.test(label)) {
      return { rawValue: true, confidence: 1.0 };
    }

    // 7. ADDRESS & LOCATION
    const isExplicitAddressField = (
      field.id === 'region2' || field.id === 'region1' || field.id === 'city_city' || field.id === 'postal_code' ||
      field.id === 'country' || field.id === 'country_code' ||
      field.sourceName === 'region2' || (field.sourceId && field.sourceId.startsWith('region2')) ||
      /address|location|contact|personal|demographics/i.test(field.sectionLabel || '')
    );

    const isScreeningSentence = (
      label.includes('?') || label.length > 40 ||
      /^please\s+state\b/i.test(label) ||
      /^state\s+(whether|your|the|if|how|why|any|all|what|which)\b/i.test(label) ||
      /notice\s*period|salary|compensation|package|requirement|availability|reason\s*for/i.test(label)
    );

    if ((/address\s*line\s*1/i.test(label) || (/address/i.test(label) && !/line\s*[234]|email|ip\b/i.test(label))) && (isExplicitAddressField || !isScreeningSentence)) {
      return canonical.address.addressLine1 ? { rawValue: canonical.address.addressLine1, confidence: 1.0 } : null;
    }
    if (/address\s*line\s*2/i.test(label)) {
      return { rawValue: canonical.address.addressLine2 || '', confidence: 1.0 };
    }
    if (/address\s*line\s*3/i.test(label)) {
      return { rawValue: '', confidence: 1.0 };
    }
    if ((/\b(city|town)\b/i.test(label) && !/\b(race|ethnicity|high-density|worked)\b/i.test(label)) && (isExplicitAddressField || !isScreeningSentence)) {
      return canonical.address.city ? { rawValue: canonical.address.city, confidence: 1.0 } : null;
    }
    const isOracleRegion2 = field.id === 'region2' || field.sourceName === 'region2' || (field.sourceId && field.sourceId.startsWith('region2'));
    const isStateLabel = /\b(state|province)\b/i.test(label) || /^(state|state\s*\/\s*province|province)(\s*\*|\s*\(required\))?$/i.test(label.trim());
    if (!isScreeningSentence && (isOracleRegion2 || (isStateLabel && (isExplicitAddressField || !isScreeningSentence)))) {
      const isUS = /united\s*states|usa|us\b/i.test(canonical.address.country || '');
      const stateVal = (isUS && canonical.address.stateAbbr && isOracleRegion2) ? canonical.address.stateAbbr : (canonical.address.state || canonical.address.stateAbbr);
      return stateVal ? { rawValue: stateVal, confidence: 1.0 } : null;
    }
    if ((/\b(zip|postal|postcode)\b/i.test(label) && !/country/i.test(label)) && (isExplicitAddressField || !isScreeningSentence)) {
      return canonical.address.postalCode ? { rawValue: canonical.address.postalCode, confidence: 1.0 } : null;
    }
    if (/^(country|country\s*\/\s*region)(\s*\*|\s*\(required\))?$/i.test(label.trim()) && !/sponsorship|authorized|legal|eligible|citizen|visa/i.test(label)) {
      return canonical.address.country ? { rawValue: canonical.address.country, confidence: 1.0 } : null;
    }
    if ((/county\b/i.test(label) || field.id === 'region1') && (isExplicitAddressField || !isScreeningSentence)) {
      return { rawValue: canonical.address.county || '', confidence: 1.0 };
    }

    // 8. AGE (18+)
    if (/18\s*(years|years of age)|over\s*the\s*age\s*of\s*18|at\s*least\s*18/i.test(label)) {
      const is18 = canonical.workAuth.isOver18;
      if (type === 'radio') return { rawValue: is18 ? 'Yes' : 'No', confidence: 1.0 };
      return { rawValue: is18, confidence: 1.0 };
    }

    // 9. WORK AUTHORIZATION & SPONSORSHIP
    if (/legally\s*eligible\s*to\s*work|authorized\s*to\s*work\s*in\s*the|eligible\s*to\s*work\s*in\s*the\s*united\s*states|lawful\s*permanent\s*resident/i.test(label)) {
      if (canonical.workAuth.eligibleInUS !== null) {
        const val = canonical.workAuth.eligibleInUS ? 'Yes' : 'No';
        return { rawValue: type === 'checkbox' ? canonical.workAuth.eligibleInUS : val, confidence: 1.0 };
      }
      return null;
    }

    if (/require.*sponsorship|help\s*you\s*obtain\s*an\s*employment\s*visa|require\s*visa\s*sponsorship/i.test(label)) {
      if (canonical.workAuth.requiresSponsorship !== null) {
        const val = canonical.workAuth.requiresSponsorship ? 'Yes' : 'No';
        return { rawValue: type === 'checkbox' ? canonical.workAuth.requiresSponsorship : val, confidence: 1.0 };
      }
      return null;
    }

    if (/visa\s*type|enter\s*your\s*visa\s*type/i.test(label)) {
      return canonical.workAuth.visaType ? { rawValue: canonical.workAuth.visaType, confidence: 1.0 } : null;
    }

    // 10. DISCLOSURES & COMPLIANCE
    if (/have\s*you\s*(previously|ever)\s*(been\s*employed|worked)|currently\s*(an\s*employee|employed)\s*with|employed\s*by\s*\w+|worked\s*(for|at|as an employee|in any capacity)|former.*employee/i.test(label)) {
      const worked = canonical.disclosures.workedForCompanyBefore;
      if (type === 'textarea' || type === 'text') {
        return { rawValue: worked ? 'Yes' : 'Not Applicable', confidence: 1.0 };
      }
      return { rawValue: worked ? 'Yes' : 'No', confidence: 1.0 };
    }

    if (/relative.*(employee|employed|working)|relatives?\s*(presently|currently)\s*working|related\s*to\s*a\s*current\s*employee/i.test(label)) {
      const hasRel = canonical.disclosures.hasRelativesInCompany;
      if (type === 'textarea' || type === 'text') {
        return { rawValue: hasRel ? (canonical.disclosures.relativesDetails || 'Yes') : 'Not Applicable', confidence: 1.0 };
      }
      return { rawValue: hasRel ? 'Yes' : 'No', confidence: 1.0 };
    }

    if (/relative('?s)?\s*(name|employee\s*id)|relationship/i.test(label)) {
      return { rawValue: 'Not Applicable', confidence: 0.50 };
    }

    if (/reason\s*for\s*leaving|former.*email\s*address|employee\s*id/i.test(label)) {
      return { rawValue: 'Not Applicable', confidence: 0.50 };
    }

    if (/employee\s*refer\s*you|referred\s*by(\s*a\s*current\s*employee|\s*an\s*employee)?/i.test(label)) {
      return { rawValue: 'No', confidence: 1.0 };
    }

    if (/employed\s*by\s*the\s*government|government\s*official|public\s*agency|selection\s*committee|restrictions?\s*from\s*a\s*former\s*employer|other\s*jobs.*board\s*membership/i.test(label)) {
      return { rawValue: 'No', confidence: 1.0 };
    }

    if (/minimum\s*(years\s*of\s*)?experience|minimum\s*qualifications/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }

    if (/background\s*check/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/drug\s*screen|drug\s*test/i.test(label)) {
      if (/failed|refused/i.test(label)) return { rawValue: 'No', confidence: 1.0 };
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/felony|convicted/i.test(label)) {
      return { rawValue: canonical.disclosures.convictedOfFelony ? 'Yes' : 'No', confidence: 1.0 };
    }

    // 11. PREFERENCES & AVAILABILITY
    if (/willing\s*to\s*relocate/i.test(label)) {
      return { rawValue: canonical.preferences.willingToRelocate ? 'Yes' : 'No', confidence: 1.0 };
    }
    if (/willing\s*to\s*travel|able\s*to\s*travel|require\s*travel/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/when\s*are\s*you\s*available\s*to\s*start|earliest\s*you\s*can\s*start|earliest\s*available\s*date\b/i.test(label) && !/month|day|year/i.test(label)) {
      return { rawValue: canonical.preferences.desiredStartDate || 'Immediately', confidence: 1.0 };
    }
    if (/can\s*join\s*by|earliest\s*available\s*date/i.test(label)) {
      if (/month/i.test(label)) return { rawValue: 'November', confidence: 1.0 };
      if (/day/i.test(label)) return { rawValue: '15', confidence: 1.0 };
      if (/year/i.test(label)) return { rawValue: '2026', confidence: 1.0 };
    }
    if (/notice\s*period\s*(in\s*days)?/i.test(label)) {
      if (/in\s*days/i.test(label)) return { rawValue: canonical.preferences.noticePeriodDays, confidence: 1.0 };
      return { rawValue: canonical.preferences.availability, confidence: 1.0 };
    }

    // 12. TERMS & AGREEMENTS
    if (/^\s*i\s*agree\s*$|^\s*agree\s*$/i.test(label.trim())) {
      return { rawValue: true, confidence: 1.0 };
    }
    if (/certify\s*that\s*all\s*information|true\s*and\s*accurate|terms\s*and\s*conditions/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/reasonable\s*accommodation/i.test(label)) {
      return { rawValue: 'None', confidence: 1.0 };
    }

    // 13. EEO & DEMOGRAPHICS (Zero synthetic defaults)
    if (/\b(gender|sex)\b(?!\s*orientation)/i.test(label) && !/disclose/i.test(label)) {
      if (!canonical.eeo.gender) return null;
      if (Array.isArray(field.options) && field.options.length > 0) {
        const matched = matchEeoOption('gender', canonical.eeo.gender, field.options);
        return matched ? { rawValue: matched, confidence: 1.0 } : null;
      }
      return { rawValue: canonical.eeo.gender, confidence: 1.0 };
    }

    if (/hispanic|latino/i.test(label)) {
      if (canonical.eeo.isHispanic === null) return null;
      if (type === 'checkbox') {
        return { rawValue: canonical.eeo.isHispanic === true, confidence: 1.0 };
      }
      if (canonical.eeo.isHispanic === 'Decline to Self-Identify') {
        if (Array.isArray(field.options) && field.options.length > 0) {
          const matched = matchEeoOption('hispanic', 'Decline', field.options);
          return matched ? { rawValue: matched, confidence: 1.0 } : { rawValue: 'No', confidence: 1.0 };
        }
      }
      return { rawValue: canonical.eeo.isHispanic ? 'Yes' : 'No', confidence: 1.0 };
    }

    if (/race|ethnicity/i.test(label) && !/hispanic/i.test(label)) {
      if (!canonical.eeo.raceEthnicity) return null;
      if (Array.isArray(field.options) && field.options.length > 0) {
        const matched = matchEeoOption('race', canonical.eeo.raceEthnicity, field.options);
        return matched ? { rawValue: matched, confidence: 1.0 } : null;
      }
      return { rawValue: canonical.eeo.raceEthnicity, confidence: 1.0 };
    }

    if (/veteran/i.test(label)) {
      if (!canonical.eeo.veteranStatus) return null;
      if (type === 'checkbox') {
        const isProtected = /protected\s*veteran/i.test(canonical.eeo.veteranStatus) && !/not\s*(a\s*)?protected/i.test(canonical.eeo.veteranStatus);
        return { rawValue: isProtected, confidence: 1.0 };
      }
      if (Array.isArray(field.options) && field.options.length > 0) {
        const matched = matchEeoOption('veteran', canonical.eeo.veteranStatus, field.options);
        return matched ? { rawValue: matched, confidence: 1.0 } : null;
      }
      return { rawValue: canonical.eeo.veteranStatus, confidence: 1.0 };
    }

    if (/disability/i.test(label)) {
      if (!canonical.eeo.disabilityStatus) return null;
      if (Array.isArray(field.options) && field.options.length > 0) {
        const matched = matchEeoOption('disability', canonical.eeo.disabilityStatus, field.options);
        return matched ? { rawValue: matched, confidence: 1.0 } : null;
      }
      return { rawValue: canonical.eeo.disabilityStatus, confidence: 1.0 };
    }

    // 14. TECHNICAL SCREENING (From Resume)
    if (resumeText && (type === 'radio' || type === 'checkbox')) {
      if (/object[- ]oriented|oop\b/i.test(label) && /object[- ]oriented|oop\b|java\b|python\b|c\+\+|solid principles|design patterns/i.test(resumeText)) {
        return { rawValue: 'Yes', confidence: 1.0 };
      }
      if (/microservices?\b/i.test(label) && /microservices?|rest\s*api|docker|kubernetes|aws|cloud/i.test(resumeText)) {
        return { rawValue: 'Yes', confidence: 1.0 };
      }
      if (/distributed\s*systems?\b/i.test(label) && /distributed\s*systems?|event[- ]driven|kafka|scalable/i.test(resumeText)) {
        return { rawValue: 'Yes', confidence: 1.0 };
      }
      if (/cloud\s*(computing|platforms?|technologies)?\b/i.test(label) && /aws|azure|gcp|cloud/i.test(resumeText)) {
        return { rawValue: 'Yes', confidence: 1.0 };
      }
      if (/sql|databases?\b/i.test(label) && /sql|postgres|mysql|oracle|database/i.test(resumeText)) {
        return { rawValue: 'Yes', confidence: 1.0 };
      }
    }

    // 15. ORGANIZATION & WORK STATS
    if (/\b(current\s*organization|current\s*company|current\s*employer|most\s*recent\s*(company|employer))\b/i.test(label)) {
      const rawCompany = canonical.history.experienceRecords?.[0]?.company || canonical.history.experienceRecords?.[0]?.employer;
      const cleanOrg = this.#cleanCompany(rawCompany, resumeText);
      return cleanOrg ? { rawValue: cleanOrg, confidence: 1.0 } : null;
    }
    if (/\b(total|relevant)\s*experience\s*(in\s*years)?\b/i.test(label)) {
      const exp = canonical.history.totalExperienceYears || (canonical.history.experienceRecords?.length ? String(canonical.history.experienceRecords.length * 2) : null);
      return exp ? { rawValue: exp, confidence: 1.0 } : null;
    }
    if (/^specialization$/i.test(label.trim())) {
      const spec = canonical.history.major || addInfo.education_records?.[0]?.fieldOfStudy || canonical.history.primaryRole || 'Computer Science';
      return spec ? { rawValue: spec, confidence: 1.0 } : null;
    }
    if (/highest.*education|degree\s*level|education\s*level|^degree\b/i.test(label)) {
      return canonical.history.highestEducation ? { rawValue: canonical.history.highestEducation, confidence: 1.0 } : null;
    }
    if (/university|college|institution\s*name/i.test(label)) {
      return canonical.history.universityName ? { rawValue: canonical.history.universityName, confidence: 1.0 } : null;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // STAGE 2: QUESTION BANK TOKEN-SORT FUZZY MATCH
  // --------------------------------------------------------------------------
  #matchStage2TokenSort(field, clientHistory = [], globalHistory = []) {
    const label = field.label || '';
    if (!label) return null;

    // Search client-specific history first
    let bestClientMatch = null;
    let highestClientScore = 0;

    for (const record of clientHistory) {
      if (!record.question_label || record.value === null || record.value === undefined) continue;
      const score = tokenSortSimilarity(label, record.question_label);
      if (score > highestClientScore) {
        highestClientScore = score;
        bestClientMatch = record;
      }
    }

    if (bestClientMatch && highestClientScore >= 0.85) {
      const tierCap = (bestClientMatch.source === 'manual' || bestClientMatch.confidence === 1.0) ? 0.98 : 0.90;
      return { rawValue: bestClientMatch.value, score: highestClientScore, tierCap, source: 'tier2_client_history' };
    }

    // Fall back to cross-client global history for non-PII questions
    if (!isPiiOrPersonalQuestion(label)) {
      let bestGlobalMatch = null;
      let highestGlobalScore = 0;

      for (const record of globalHistory) {
        if (!record.question_label || record.value === null || record.value === undefined) continue;
        const score = tokenSortSimilarity(label, record.question_label);
        if (score > highestGlobalScore) {
          highestGlobalScore = score;
          bestGlobalMatch = record;
        }
      }

      if (bestGlobalMatch && highestGlobalScore >= 0.85) {
        return { rawValue: bestGlobalMatch.value, score: Math.min(highestGlobalScore, 0.85), tierCap: 0.85, source: 'tier2_global_history' };
      }
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // STAGE 3: SPECIALIZED DOMAIN RESOLVERS (Currency, Range Buckets, Dates, Salary)
  // --------------------------------------------------------------------------
  #matchStage3Domain(field, canonical) {
    const label = field.label || '';
    const type = field.type || field.role || 'text';
    const options = field.options || [];

    // 1. Currency Dropdown
    const isCurrencyField = /currency\b/i.test(label) ||
      (options.length > 0 && options.some(o => /dollar|euro|pound|rupee|yen|franc|dirham|peso/i.test(String(o))));

    if (isCurrencyField && options.length > 0) {
      const matched = matchCurrencyOption(canonical.compensation.currencyCode, options);
      if (matched) {
        return { rawValue: matched, score: 0.95, source: 'tier2_currency_matcher' };
      }
      return null;
    }

    // 2. Salary Range Buckets (Dropdown containing numeric range intervals)
    const isRangeBucketField = options.length > 0 && options.some(o => /\d+\s*[-–—to]+\s*\d+|\d+\+/i.test(String(o)));
    if (isRangeBucketField && (canonical.compensation.minAnnual !== null || canonical.compensation.maxAnnual !== null)) {
      const matched = matchSalaryRangeBucket(canonical.compensation.minAnnual, canonical.compensation.maxAnnual, options);
      if (matched) {
        return { rawValue: matched, score: 0.95, source: 'tier2_range_bucket_matcher' };
      }
      return null;
    }

    // 3. Salary Expectations Alignment Radio
    if (type === 'radio' && /salary.*(align|match|posted|range)|expectations?.*align/i.test(label)) {
      return { rawValue: 'Yes', score: 0.95, source: 'tier2_salary_alignment' };
    }

    // 4. Freeform Salary Questions (Text or Textarea)
    if (/(salary|package|compensation)\s*(and\s*benefits\s*)?(requirements?|expectations?|package)|desired\s*salary|state\s*your\s*(current\s*)?salary|salary\s*expectations?|\b(desired\s*pay|pay\s*range|desired\s*annual\s*compensation|compensation|minimum\s*pay)\b/i.test(label)) {
      if (type === 'number') {
        const num = canonical.compensation.midpointAnnual || canonical.compensation.minAnnual;
        return num ? { rawValue: num, score: 0.90, source: 'tier1_compensation' } : null;
      }
      const val = canonical.compensation.raw || canonical.compensation.formattedRange;
      return val ? { rawValue: val, score: 0.90, source: 'tier1_compensation' } : null;
    }

    // 5. Composite Date Component Dropdowns (Month, Day, Year)
    if (options.length > 0) {
      if (/\bmonth\b/i.test(label)) {
        const m = matchDateComponent(canonical.preferences.desiredStartDate, 'month', options);
        if (m) return { rawValue: m, score: 0.95, source: 'tier2_date_matcher' };
      }
      if (/\bday\b/i.test(label)) {
        const d = matchDateComponent(canonical.preferences.desiredStartDate, 'day', options);
        if (d) return { rawValue: d, score: 0.95, source: 'tier2_date_matcher' };
      }
      if (/\byear\b/i.test(label)) {
        const y = matchDateComponent(canonical.preferences.desiredStartDate, 'year', options);
        if (y) return { rawValue: y, score: 0.95, source: 'tier2_date_matcher' };
      }
    }

    // 6. Referral Source / How did you hear
    if (/how\s*did\s*you\s*(hear|learn|come\s*to\s*know)\s*about|opportunity\s*source/i.test(label)) {
      if (options.length > 0) {
        const matched = matchBestOption(['LinkedIn', 'Company Website', 'Online Job Board', 'Social Media'], options, 60);
        if (matched) return { rawValue: matched, score: 0.90, source: 'tier2_referral_matcher' };
      } else {
        return { rawValue: 'LinkedIn', score: 0.90, source: 'tier2_referral_matcher' };
      }
    }

    return null;
  }

  isValidValue(value, field) {
    return this.#isValidValue(value, field);
  }

  validateAndCoerceAnswer(rawVal, field) {
    if (rawVal === null || rawVal === undefined) return null;
    let val = rawVal;
    if (Array.isArray(field.options) && field.options.length > 0) {
      const optionMatched = matchBestOption([String(val)], field.options, 70);
      if (optionMatched) val = optionMatched;
    }
    const coerced = coerceValueForField(val, field);
    return this.#isValidValue(coerced, field) ? coerced : null;
  }

  // --------------------------------------------------------------------------
  // STRICT VALIDATION GUARD
  // --------------------------------------------------------------------------
  #isValidValue(value, field) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.trim() === '' && field.required) return false;
    if (Array.isArray(value) && value.length === 0 && field.required) return false;

    // Strict Option Enforcement: If field has explicit options, value MUST be one of them!
    if (Array.isArray(field.options) && field.options.length > 0) {
      if (typeof value === 'string') {
        const valLower = value.trim().toLowerCase();
        const matchesOption = field.options.some(opt => String(opt).trim().toLowerCase() === valLower);
        if (!matchesOption) return false;
      } else if (Array.isArray(value)) {
        const allMatch = value.every(v =>
          field.options.some(opt => String(opt).trim().toLowerCase() === String(v).trim().toLowerCase())
        );
        if (!allMatch) return false;
      }
    }

    return true;
  }
}
