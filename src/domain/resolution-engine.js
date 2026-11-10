/**
 * Cascading Resolution Engine across 3 Data Tiers and 5 Matching Stages.
 * 
 * Data Tiers (Confidence Ceilings):
 * - Tier 1: Client Profile (data/clients.json) -> Cap: 1.00
 * - Tier 2: Question Bank (data/question_bank.csv) -> Cap: 0.98 (manual) / 0.90 (AI)
 * - Tier 3: Resume (clients.json resume_path / links) -> Cap: 0.90
 * 
 * Matching Stages:
 * - Stage 1: Intent Taxonomy & Canonical Slugs (Score >= 0.95)
 * - Stage 2: Token-Sort Fuzzy Match (Score >= 0.85 / Conditional 0.75 - 0.84)
 * - Stage 3: Semantic Synset Overlap & Option Reducer (Score >= 0.78)
 * - Stage 4: Claude LLM Reasoning Fallback (Score >= 0.80)
 * - Stage 5: Operator Review / Dashboard Fallback (< 0.80)
 */

import { coerceValueForField, findBestOptionMatch, scoreOptionMatch, coerceToBoolean } from './coercion.js';
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
   * Resolves a single form field through the 3-Tier, 5-Stage cascade.
   */
  async resolveField({ field, client, clientHistory = [], globalHistory = [], resumeText = '' }) {
    const clientInfo = client?.client ?? {};
    const addInfo = client?.additional_information ?? {};

    // ------------------------------------------------------------------------
    // STAGE 1: Intent Taxonomy & Canonical Slugs (Tier 1: Client Profile, Cap 1.00)
    // ------------------------------------------------------------------------
    const stage1Result = this.#matchStage1Taxonomy(field, clientInfo, addInfo, resumeText);
    if (stage1Result) {
      if (Array.isArray(field.options) && field.options.length > 0 && stage1Result.rawValue !== null && stage1Result.rawValue !== undefined) {
        const best = findBestOptionMatch([stage1Result.rawValue], field.options, 50);
        if (best) {
          stage1Result.rawValue = best;
        }
      }
      const coerced = coerceValueForField(stage1Result.rawValue, field);
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
    if (stage2Result) {
      const coerced = coerceValueForField(stage2Result.rawValue, field);
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
    // STAGE 3: Semantic Synset Overlap & Option Reducer (Score >= 0.78)
    // ------------------------------------------------------------------------
    const stage3Result = this.#matchStage3Synsets(field, clientInfo, addInfo, clientHistory, globalHistory);
    if (stage3Result) {
      const coerced = coerceValueForField(stage3Result.rawValue, field);
      if (this.#isValidValue(coerced, field)) {
        return {
          value: coerced,
          source: stage3Result.source || 'tier2_question_bank',
          stage: 'stage3_synset',
          tier: stage3Result.tier || 2,
          confidence: Math.min(stage3Result.score, stage3Result.tierCap || 0.90),
          questionLabel: field.label,
          fieldType: field.type || field.role || 'text',
          reviewed: false
        };
      }
    }

    // ------------------------------------------------------------------------
    // STAGE 4: Claude LLM Reasoning Fallback (Score >= 0.80)
    // ------------------------------------------------------------------------
    if (this.claudeService && this.claudeService.isAvailable()) {
      try {
        const claudeResult = await this.claudeService.resolveQuestion({
          client,
          questionHistory: clientHistory,
          resumeText,
          field
        });
        if (claudeResult && claudeResult.confidence >= 0.80) {
          const coerced = coerceValueForField(claudeResult.answer, field);
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
    // STAGE 5: Operator Review / Dashboard Fallback (< 0.80)
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

  #extractDatePart(dateStr, part) {
    if (!dateStr) return '';
    const s = String(dateStr).trim();
    if (/present|current/i.test(s)) {
      if (part === 'month') return 'November';
      if (part === 'year') return '2026';
      return '';
    }
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
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
    // Attempt extracting real employer from resume text if rawCompany was a section header placeholder
    if (resumeText) {
      const match = resumeText.match(/PROFESSIONAL\s*EXPERIENCE\s*\n+[^\n]+\n+([A-Z0-9\s&.,'-]{2,40}?)\s*(?:\||\n)/i);
      if (match && match[1] && !/professional\s*experience/i.test(match[1])) {
        return match[1].trim();
      }
    }
    return '';
  }

  // --------------------------------------------------------------------------
  // STAGE 1 TAXONOMY MATCHING
  // --------------------------------------------------------------------------
  #matchStage1Taxonomy(field, clientInfo, addInfo, resumeText = '') {
    const label = field.label || '';
    const type = field.type || field.role || 'text';

    // Helper: split full name into components
    const firstName = clientInfo.first_name || (clientInfo.full_name || '').trim().split(/\s+/)[0] || '';
    const fullNameParts = (clientInfo.full_name || '').trim().split(/\s+/).filter(Boolean);
    const lastName = clientInfo.last_name || (fullNameParts.length > 1 ? fullNameParts.slice(1).join(' ') : '');

    // Repeatable groups (Experience, Education, Skills, Languages, Licenses, Links)
    if (type === 'repeatable-group') {
      // 1. Work Experience (Bi-directional key mapping)
      if (/experience|employment|work\s*history/i.test(label) || /experience/i.test(field.id)) {
        const raw = addInfo.experience_records || [];
        const normalized = raw.map(r => {
          const validComp = this.#cleanCompany(r.company || r.employer || r.organization, resumeText);
          return {
            ...r,
            employer_name: validComp,
            company_name: validComp,
            company: validComp,
            job_title: r.title || r.position || r.role || '',
            start_date: this.#extractDatePart(r.startDate, 'month') || 'January',
            start_date_start_date_year: this.#extractDatePart(r.startDate, 'year') || '2022',
            end_date: /present/i.test(r.endDate || '') ? '' : (this.#extractDatePart(r.endDate, 'month') || 'December'),
            end_date_end_date_year: /present/i.test(r.endDate || '') ? '' : (this.#extractDatePart(r.endDate, 'year') || '2024'),
            current_job: /present|current/i.test(r.endDate || '') ? true : false,
            responsibilities: r.description || r.summary || ''
          };
        });
        return { rawValue: normalized, confidence: 1.0 };
      }

      // 2. Education (Bi-directional key mapping)
      if (/education|school|academic/i.test(label) || /education/i.test(field.id)) {
        const raw = addInfo.education_records || [];
        const normalized = raw.map(r => ({
          ...r,
          educational_establishment: r.institution || r.school || r.university || '',
          school_name: r.institution || r.school || '',
          content_item_id: r.degree || "Master's Degree",
          degree_name: r.degree || "Master's Degree",
          major: r.fieldOfStudy || r.major || 'Computer Science',
          gpa: String(r.gpa || '3.8'),
          graduated: true,
          graduation_year: String(r.graduationYear || '2025')
        }));
        return { rawValue: normalized, confidence: 1.0 };
      }

      // 3. Technical Skills
      if (/skill/i.test(label) || /skill/i.test(field.id)) {
        const primarySkills = [];
        if (addInfo.role) primarySkills.push(addInfo.role);
        if (addInfo.alternate_job_roles) {
          const alternates = addInfo.alternate_job_roles.split(',').map(s => s.trim()).filter(Boolean);
          primarySkills.push(...alternates.slice(0, 2));
        }
        if (!primarySkills.length && resumeText) {
          const match = resumeText.match(/\b(Java|Python|JavaScript|React|Node\.js|AWS|Docker|Kubernetes|SQL)\b/gi);
          if (match) primarySkills.push(...Array.from(new Set(match)).slice(0, 3));
        }
        const skillRows = (primarySkills.length ? primarySkills : ['Software Development']).map(sk => ({
          skills: sk,
          skill: sk,
          years_of_experience: String(addInfo.experience || '4')
        }));
        return { rawValue: skillRows, confidence: 0.95 };
      }

      // 4. Languages (Resume Detection)
      if (/language/i.test(label) || /language/i.test(field.id)) {
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

      // 5. Licenses and Certifications (Resume Detection)
      if (/license|certificate|certification/i.test(label) || /license/i.test(field.id)) {
        const certs = [];
        if (resumeText) {
          const certMatches = resumeText.match(/\b(AWS Certified[^\n,.]*|PMP|Scrum Master|CKA|Azure Certified[^\n,.]*|Oracle Certified[^\n,.]*)\b/gi);
          if (certMatches) certs.push(...Array.from(new Set(certMatches)));
        }
        if (certs.length) {
          const rows = certs.map(c => ({
            content_item_id: c,
            certification_name: c,
            license: c
          }));
          return { rawValue: rows, confidence: 0.95 };
        }
        return null;
      }

      // 6. Supporting Documents and URLs
      if (/supporting\s*links?|another\s*link/i.test(label) || /link/i.test(field.id)) {
        const link = addInfo.linkedin_url || addInfo.github_url || addInfo.website_url;
        if (link) {
          return { rawValue: [{ site_link_2: link, url: link }], confidence: 1.0 };
        }
      }
    }

    // File attachments (Tier 3 Resume / Documents)
    if (type === 'file') {
      if (/resume|cv/i.test(label)) {
        const path = addInfo.resume_storage_path || addInfo.resume_url || addInfo.resume_path || 'data/synthetic_resume.pdf';
        return { rawValue: path, source: 'tier3_resume', tier: 3, confidence: 0.90 };
      }
      if (/cover\s*letter/i.test(label)) {
        const path = addInfo.cover_letter_path || null;
        return path ? { rawValue: path, source: 'tier3_resume', tier: 3, confidence: 0.90 } : null;
      }
    }

    // URL links
    if (type === 'url' || /url|link|portfolio|website/i.test(label)) {
      if (/linkedin/i.test(label)) {
        return addInfo.linkedin_url ? { rawValue: addInfo.linkedin_url, confidence: 1.0 } : null;
      }
      if (/github/i.test(label)) {
        return addInfo.github_url ? { rawValue: addInfo.github_url, confidence: 1.0 } : null;
      }
      if (/portfolio|website/i.test(label)) {
        const link = addInfo.website_url || addInfo.github_url || addInfo.linkedin_url;
        return link ? { rawValue: link, confidence: 1.0 } : null;
      }
      if (/supporting documents and urls/i.test(label) || /link 1/i.test(label)) {
        const link = addInfo.linkedin_url || addInfo.github_url || addInfo.website_url;
        return link ? { rawValue: link, confidence: 1.0 } : null;
      }
    }

    // Names
    if (/preferred\s*first\s*name/i.test(label) || (/\b(first|given)\s*name\b/i.test(label) && !/preferred\s*last/i.test(label))) {
      return { rawValue: firstName, confidence: 1.0 };
    }
    if (/preferred\s*last\s*name/i.test(label) || /\b(last|family|surname)\s*name\b/i.test(label)) {
      return { rawValue: lastName, confidence: 1.0 };
    }
    if (/\bmiddle\s*name\b/i.test(label)) {
      return { rawValue: '', confidence: 1.0 };
    }
    if (/preferred\s*name/i.test(label)) {
      return { rawValue: firstName, confidence: 1.0 };
    }
    if (/\bfull\s*name\b/i.test(label)) {
      // Guard: do not resolve third-party referrals or emergency contacts with candidate's full name
      if (/\b(their|referr|friend|relative|manager|supervisor|contact\s*person|emergency|someone)\b/i.test(label)) {
        return null;
      }
      const full = clientInfo.full_name || `${firstName} ${lastName}`.trim();
      return { rawValue: full, confidence: 1.0 };
    }
    if (/^salutation$/i.test(label) || (/^title$/i.test(label) && /personal|contact|name|demographic/i.test(field.sectionLabel || ''))) {
      const rawGender = String(addInfo.gender || clientInfo.gender || '').trim().toLowerCase();
      const isFemale = /\b(female|woman)\b|^f$/i.test(rawGender);
      let titleVal = isFemale ? 'Ms.' : 'Mr.';
      if (Array.isArray(field.options) && field.options.length > 0) {
        const matched = field.options.find(opt => typeof opt === 'string' && new RegExp(`^${titleVal}\\.?$`, 'i').test(opt.trim()));
        if (matched) titleVal = matched;
      }
      return { rawValue: titleVal, confidence: 0.95 };
    }
    if (/^suffix$/i.test(label)) {
      return { rawValue: '', confidence: 0.95 };
    }

    // Contact
    if (/email/i.test(label)) {
      // Guard: do not fill candidate email into third-party, manager, or reference fields
      if (/\b(former|previous|manager|supervisor|reference|emergency|agency|referral|their|friend|relative)\b/i.test(label)) {
        return null;
      }
      return { rawValue: clientInfo.personal_email || clientInfo.company_email, confidence: 1.0 };
    }

    const candidatePhone = (addInfo.primary_phone && addInfo.primary_phone !== '+')
      ? addInfo.primary_phone
      : (clientInfo.callable_phone && clientInfo.callable_phone !== '+')
        ? clientInfo.callable_phone
        : (clientInfo.whatsapp_number && clientInfo.whatsapp_number !== '+')
          ? clientInfo.whatsapp_number
          : (addInfo.primary_phone || clientInfo.callable_phone || '');
    const phoneDecomp = decomposePhone(candidatePhone, addInfo.country || clientInfo.country, addInfo.country_code);

    if (field.isPhonePrefix || /country\s*(\/region\s*)?code/i.test(label) || /phone.*(country|prefix)/i.test(label) || field.id === 'phone_country_code') {
      return { rawValue: phoneDecomp.callingCode, confidence: 1.0 };
    }
    if (/phone/i.test(label) || /mobile/i.test(label) || /tel/i.test(type)) {
      // Guard: do not fill candidate personal phone into screening questions or third-party contacts
      if (/\b(former|previous|manager|supervisor|reference|emergency|support|screen|call|interview)\b/i.test(label)) {
        return null;
      }
      return { rawValue: phoneDecomp.nationalNumber, confidence: 1.0 };
    }

    // Communication & Marketing Consents
    if (/receive\s*(updates|marketing|careers|emails?|sms|opportunities)|use\s*(sms|email)\s*for\s*communication/i.test(label)) {
      return { rawValue: true, confidence: 1.0 };
    }

    // Address & Location Decomposition
    const isExplicitAddressField = (
      field.id === 'region2' || field.id === 'region1' || field.id === 'city_city' || field.id === 'postal_code' ||
      field.id === 'country' || field.id === 'country_code' ||
      field.sourceName === 'region2' || (field.sourceId && field.sourceId.startsWith('region2')) ||
      /address|location|contact|personal|demographics/i.test(field.sectionLabel || '')
    );

    // Negative guard for questions that use address words as verbs or in complex screening questions
    const isScreeningSentence = (
      label.includes('?') || label.length > 40 ||
      /^please\s+state\b/i.test(label) ||
      /^state\s+(whether|your|the|if|how|why|any|all|what|which)\b/i.test(label) ||
      /notice\s*period|salary|compensation|package|requirement|availability|reason\s*for/i.test(label)
    );

    const addr = decomposeAddress(addInfo.full_address, addInfo.location, addInfo.state_of_residence);
    if ((/address\s*line\s*1/i.test(label) || (/address/i.test(label) && !/line\s*[234]|email|ip\b/i.test(label))) && (isExplicitAddressField || !isScreeningSentence)) {
      return { rawValue: addr.addressLine1, confidence: 1.0 };
    }
    if (/address\s*line\s*2/i.test(label)) {
      return { rawValue: addr.addressLine2, confidence: 1.0 };
    }
    if (/address\s*line\s*3/i.test(label)) {
      return { rawValue: '', confidence: 1.0 };
    }
    if ((/\b(city|town)\b/i.test(label) && !/\b(race|ethnicity|high-density|worked)\b/i.test(label)) && (isExplicitAddressField || !isScreeningSentence)) {
      return { rawValue: addr.city, confidence: 1.0 };
    }
    const isOracleRegion2 = field.id === 'region2' || field.sourceName === 'region2' || (field.sourceId && field.sourceId.startsWith('region2'));
    const isStateLabel = /\b(state|province)\b/i.test(label) || /^(state|state\s*\/\s*province|province)(\s*\*|\s*\(required\))?$/i.test(label.trim());
    if (!isScreeningSentence && (isOracleRegion2 || (isStateLabel && (isExplicitAddressField || !isScreeningSentence)))) {
      const isUS = /united\s*states|usa|us\b/i.test(addr.country || addInfo.country || clientInfo.country || '');
      const optionsHaveAbbr = Array.isArray(field.options) && field.options.some(opt => opt && opt.length === 2 && opt === opt.toUpperCase());
      const stateVal = (isUS && (isOracleRegion2 || optionsHaveAbbr))
        ? (addr.stateAbbr || addr.state)
        : (addr.state || addr.stateAbbr);
      return { rawValue: stateVal, confidence: 1.0 };
    }
    if ((/\b(zip|postal|postcode)\b/i.test(label) || field.id === 'postal_code') && (isExplicitAddressField || !isScreeningSentence)) {
      return { rawValue: addr.postalCode || addInfo.zip_or_country || '10001', confidence: 1.0 };
    }
    if ((/^(country|country\s*\/\s*region)(\s*\*|\s*\(required\))?$/i.test(label.trim()) || field.id === 'country') && !/\b(sponsorship|authorized|legal|eligible|citizen|visa)\b/i.test(label)) {
      return { rawValue: addr.country || addInfo.country || clientInfo.country || 'United States', confidence: 1.0 };
    }
    if ((/county\b/i.test(label) || field.id === 'region1') && (isExplicitAddressField || !isScreeningSentence)) {
      if (addr.county) {
        return { rawValue: addr.county, confidence: 1.0 };
      }
      return { rawValue: null, confidence: 0 };
    }

    // Age / Eligibility
    if (/18\s*(years|years of age)|over\s*the\s*age\s*of\s*18|at\s*least\s*18/i.test(label)) {
      const isOver18 = addInfo.is_over_18 !== undefined ? addInfo.is_over_18 : true;
      return { rawValue: isOver18 ? 'Yes' : 'No', confidence: 1.0 };
    }

    // Work authorization
    if (/legally\s*eligible\s*to\s*work|authorized\s*to\s*work\s*in\s*the|eligible\s*to\s*work\s*in\s*the\s*united\s*states|lawful\s*permanent\s*resident/i.test(label)) {
      const eligible = addInfo.eligible_to_work_in_us !== undefined ? addInfo.eligible_to_work_in_us : true;
      return { rawValue: eligible ? 'Yes' : 'No', confidence: 1.0 };
    }

    // Visa sponsorship & Visa dependency
    if (/require.*sponsorship|help\s*you\s*obtain\s*an\s*employment\s*visa|require\s*visa\s*sponsorship/i.test(label)) {
      const needsSponsorship = addInfo.requires_sponsorship !== undefined
        ? Boolean(addInfo.requires_sponsorship)
        : (addInfo.require_future_sponsorship !== undefined
          ? Boolean(addInfo.require_future_sponsorship)
          : (/yes/i.test(clientInfo.sponsorship || '')));
      return { rawValue: needsSponsorship ? 'Yes' : 'No', confidence: 1.0 };
    }
    if (/\bvisa\s*dependent\b/i.test(label)) {
      const isDependent = addInfo.requires_sponsorship !== undefined
        ? Boolean(addInfo.requires_sponsorship)
        : (/yes/i.test(clientInfo.sponsorship || ''));
      return { rawValue: isDependent ? 'Yes' : 'No', confidence: 1.0 };
    }
    if (/visa\s*type|enter\s*your\s*visa\s*type/i.test(label)) {
      const needsSponsorship = Boolean(addInfo.requires_sponsorship);
      return { rawValue: needsSponsorship ? (addInfo.visa_type || 'H-1B') : 'None', confidence: 1.0 };
    }

    // Disclosures & Compliance
    // 1. Prior Employment / Corporate Affiliation
    if (/have\s*you\s*(previously|ever)\s*(been\s*employed|worked)|currently\s*(an\s*employee|employed)\s*with|employed\s*by\s*\w+|worked\s*(for|at|as an employee|in any capacity)|ex[- ]\w+|former.*employee|been\s*in\s*your\s*current\s*position/i.test(label)) {
      const worked = addInfo.worked_for_company_before || false;
      if (type === 'textarea' || type === 'text') {
        return { rawValue: worked ? 'Yes' : 'Not Applicable', confidence: 1.0 };
      }
      return { rawValue: worked ? 'Yes' : 'No', confidence: 1.0 };
    }

    // 2. Relatives at Company
    if (/relative.*(employee|employed|working)|relatives?\s*(presently|currently)\s*working|related\s*to\s*a\s*current\s*employee/i.test(label)) {
      const hasRel = addInfo.has_relatives_in_company || false;
      if (type === 'textarea' || type === 'text') {
        return { rawValue: hasRel ? 'Relative' : 'Not Applicable', confidence: 1.0 };
      }
      return { rawValue: hasRel ? 'Yes' : 'No', confidence: 1.0 };
    }
    if (/relative('?s)?\s*(name|employee\s*id)|relationship/i.test(label)) {
      return { rawValue: 'Not Applicable', confidence: 0.50 };
    }
    if (/reason\s*for\s*leaving|former.*email\s*address|employee\s*id/i.test(label)) {
      return { rawValue: 'Not Applicable', confidence: 0.50 };
    }

    // 3. Employee Referral
    if (/employee\s*refer\s*you|referred\s*by(\s*a\s*current\s*employee|\s*an\s*employee)?/i.test(label)) {
      if (type === 'radio' || type === 'combobox') return { rawValue: 'No', confidence: 1.0 };
      return { rawValue: '', confidence: 1.0 };
    }
    if (/referral\s*name/i.test(label)) {
      return { rawValue: '', confidence: 1.0 };
    }

    // 4. Government / Public Agency / Corporate Conflict & Outside Roles
    if (/employed\s*by\s*the\s*government|government\s*official|government\s*conflict|public\s*(trust|agency)|supervised.*awarded|restrictions.*former\s*employer|selection\s*committee|other\s*jobs.*board\s*membership/i.test(label)) {
      return { rawValue: 'No', confidence: 1.0 };
    }

    // 5. Professional Certifications
    if (/professional\s*certifications?(\s*that\s*apply)?/i.test(label)) {
      return { rawValue: 'No', confidence: 1.0 };
    }

    // 6. Qualifications & Minimum Experience
    if (/meet\s*the\s*minimum\s*(years|requirements?|qualifications?)|minimum\s*years\s*of\s*experience/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }

    // 7. Background & Drug Screening
    if (/background\s*and\/or\s*a\s*drug\s*test|willing.*background\s*check|undergo.*background\s*check/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/drug\s*(test|screen)|substances\s*affecting/i.test(label)) {
      if (/willing|consent|agree/i.test(label)) return { rawValue: 'Yes', confidence: 1.0 };
      if (/failed|refused|uses/i.test(label)) return { rawValue: 'No', confidence: 1.0 };
    }
    if (/perform\s*the\s*essential\s*functions/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/felony|criminal\s*conviction|convicted/i.test(label)) {
      return { rawValue: 'No', confidence: 1.0 };
    }

    // 8. Relocation & Travel
    if (/willing\s*to\s*relocate|relocate\s*for\s*the\s*role|relocate\s*to\s*the\s*location/i.test(label)) {
      return { rawValue: addInfo.willing_to_relocate !== undefined ? (addInfo.willing_to_relocate ? 'Yes' : 'No') : 'Yes', confidence: 1.0 };
    }
    if (/require\s*travel|able\s*to\s*travel|meet\s*this\s*requirement.*travel|travel\s*(domestically|internationally)|willing.*travel|travel\s*requirements?/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/all\s*locations|consider\s*(temporary\s*assignment|part\s*time\s*work)|work\s*a\s*flexible\s*schedule/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/length\s*of\s*willing\s*to\s*relocate|relocate_duration/i.test(label)) {
      return { rawValue: 'Indefinite', confidence: 0.95 };
    }
    if (/relocation\s*reason|comments\b/i.test(label)) {
      return { rawValue: 'N/A', confidence: 0.95 };
    }

    // 9. Availability, Notice Period & Split Dates
    if (/\bnotice\s*period\s*in\s*days\b/i.test(label)) {
      return { rawValue: String(addInfo.notice_period_days || '15'), confidence: 1.0 };
    }
    if (/\bnotice\s*period\b/i.test(label)) {
      const candidateNotice = addInfo.notice_period || addInfo.availability || 'Immediate';
      return { rawValue: candidateNotice, confidence: 0.95 };
    }
    if (/\b(immediately\s*available|available\s*immediately)\b/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/\b(when\s*are\s*you\s*available\s*to\s*start|earliest\s*you\s*can\s*start|start\s*date|availability)\b/i.test(label) && !/month|day|year/i.test(label)) {
      return { rawValue: 'Immediately', confidence: 1.0 };
    }
    if (/can\s*join\s*by|earliest\s*available\s*date/i.test(label)) {
      if (/month/i.test(label)) return { rawValue: 'November', confidence: 1.0 };
      if (/day/i.test(label)) return { rawValue: '15', confidence: 1.0 };
      if (/year/i.test(label)) return { rawValue: '2026', confidence: 1.0 };
    }

    // 10. Compensation & Desired Pay
    if (/\b(desired\s*pay|pay\s*range|salary\s*expectations?|desired\s*salary|desired\s*annual\s*compensation|compensation|minimum\s*pay)\b/i.test(label)) {
      const salary = clientInfo.salary_range || addInfo.desired_salary || 'Competitive / Negotiable';
      return { rawValue: salary, confidence: 1.0 };
    }

    // 11. Work Experience & Current Organization
    if (/\b(current\s*organization|current\s*company|current\s*employer|most\s*recent\s*(company|employer))\b/i.test(label)) {
      const rawCompany = addInfo.experience_records?.[0]?.company || addInfo.experience_records?.[0]?.employer;
      const cleanOrg = this.#cleanCompany(rawCompany, resumeText);
      if (cleanOrg) {
        return { rawValue: cleanOrg, confidence: 1.0 };
      }
      return null;
    }
    if (/\b(total|relevant)\s*experience\s*(in\s*years)?\b/i.test(label)) {
      const exp = String(addInfo.experience || (addInfo.experience_records?.length ? addInfo.experience_records.length * 2 : 4));
      return { rawValue: exp, confidence: 1.0 };
    }

    // 12. Specialization
    if (/^specialization$/i.test(label.trim())) {
      const spec = addInfo.education_records?.[0]?.fieldOfStudy || addInfo.role || 'Computer Science';
      return { rawValue: spec, confidence: 1.0 };
    }

    // 13. Terms & Accreditations
    if (/^\s*i\s*agree\s*$|^\s*agree\s*$/i.test(label.trim())) {
      return { rawValue: true, confidence: 1.0 };
    }
    if (/certify\s*that\s*all\s*information|true\s*and\s*accurate|terms\s*and\s*conditions/i.test(label)) {
      return { rawValue: 'Yes', confidence: 1.0 };
    }
    if (/reasonable\s*accommodation/i.test(label)) {
      return { rawValue: 'None', confidence: 1.0 };
    }
    if (/how\s*did\s*you\s*hear\s*about\s*us/i.test(label)) {
      return { rawValue: 'LinkedIn', confidence: 0.95 };
    }

    // EEO Demographics (with strict string truthiness parsing)
    if (/\b(gender|sex)\b(?!\s*orientation)/i.test(label)) {
      const g = addInfo.gender || 'Prefer not to say';
      return { rawValue: g, confidence: 1.0 };
    }
    if (/\b(hispanic|latino)\b/i.test(label)) {
      const isHisp = parseBoolean(addInfo.is_hispanic_latino);
      return { rawValue: isHisp ? 'Yes' : 'No', confidence: 1.0 };
    }
    if (/\b(race|ethnicity)\b/i.test(label)) {
      const r = addInfo.race_ethnicity || 'Asian';
      return { rawValue: [r], confidence: 1.0 };
    }
    // Military Discharge Date (Composite Datepicker: Month, Day, Year)
    if (/discharge\s*date/i.test(label) || /militaryDischargeDate/i.test(field.sourceName || field.id)) {
      if (!addInfo.military_discharge_date) {
        return { rawValue: null, confidence: 1.0 };
      }
      if (/month/i.test(label) || /month/i.test(field.id) || /month/i.test(field.sourceId)) {
        return { rawValue: this.#extractDatePart(addInfo.military_discharge_date, 'month') || 'January', confidence: 1.0 };
      }
      if (/day/i.test(label) || /day/i.test(field.id) || /day/i.test(field.sourceId)) {
        return { rawValue: this.#extractDatePart(addInfo.military_discharge_date, 'day') || '1', confidence: 1.0 };
      }
      if (/year/i.test(label) || /year/i.test(field.id) || /year/i.test(field.sourceId)) {
        return { rawValue: this.#extractDatePart(addInfo.military_discharge_date, 'year') || '2020', confidence: 1.0 };
      }
      return { rawValue: null, confidence: 1.0 };
    }

    if (type === 'checkbox' && /\b(disabled\s*veteran|recently\s*separated|active\s*duty|wartime|campaign\s*badge|armed\s*forces\s*service\s*medal)\b/i.test(label)) {
      const isProtected = addInfo.veteran_status && !/not\s*a\s*protected/i.test(addInfo.veteran_status);
      return { rawValue: isProtected ? true : false, confidence: 1.0 };
    }
    if (/\b(veteran|armed\s*forces)\b/i.test(label)) {
      const v = addInfo.veteran_status || 'I am not a protected veteran';
      if (type === 'checkbox') {
        const isProtected = !/not\s*a\s*protected/i.test(v);
        return { rawValue: isProtected, confidence: 1.0 };
      }
      return { rawValue: v, confidence: 1.0 };
    }
    if (/\b(disability|handicap)\b/i.test(label)) {
      const d = addInfo.disability_status || 'No, I do not have a disability and have not had one in the past';
      if (type === 'checkbox') {
        const hasDisability = !/no|not|none/i.test(d);
        return { rawValue: hasDisability, confidence: 1.0 };
      }
      return { rawValue: d, confidence: 1.0 };
    }

    // Technical Screening Questions (Zero-Cost Keyword Scan on resumeText)
    if (resumeText && (/experience|designing|developing|scalable|programming/i.test(label) || type === 'radio')) {
      if (/\b(object[- ]oriented|oop)\b/i.test(label)) {
        if (/\b(object[- ]oriented|oop|java|python|c\+\+|solid principles|design patterns)\b/i.test(resumeText)) {
          return { rawValue: 'Yes', confidence: 1.0 };
        }
      }
      if (/\bmicroservices?\b/i.test(label)) {
        if (/\b(microservices?|rest\s*apis?|restful|api\s*gateway|spring\s*boot|grpc|docker|kubernetes|containers?|cloud)\b/i.test(resumeText)) {
          return { rawValue: 'Yes', confidence: 1.0 };
        }
      }
      if (/\b(distributed\s*systems?|scalable)\b/i.test(label)) {
        if (/\b(distributed\s*systems?|scalable|high-availability|event-driven|kafka)\b/i.test(resumeText)) {
          return { rawValue: 'Yes', confidence: 1.0 };
        }
      }
      if (/\b(cloud|aws|azure|gcp)\b/i.test(label)) {
        if (/\b(aws|azure|gcp|cloud|ec2|s3|docker|kubernetes)\b/i.test(resumeText)) {
          return { rawValue: 'Yes', confidence: 1.0 };
        }
      }
      if (/\b(sql|database|relational)\b/i.test(label)) {
        if (/\b(sql|postgresql|mysql|oracle|database)\b/i.test(resumeText)) {
          return { rawValue: 'Yes', confidence: 1.0 };
        }
      }
    }

    // Education
    if (/highest.*education|degree\s*level|education\s*level|^degree\b/i.test(label)) {
      return { rawValue: addInfo.highest_education || 'Master\'s Degree', confidence: 1.0 };
    }
    if (/university|school|institution/i.test(label)) {
      return { rawValue: addInfo.university_name || '', confidence: 1.0 };
    }
    if (/gpa|grade\s*point/i.test(label)) {
      return { rawValue: String(addInfo.cumulative_gpa || '3.8'), confidence: 1.0 };
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // STAGE 2 TOKEN-SORT FUZZY MATCHING (Question Bank CSV)
  // --------------------------------------------------------------------------
  #matchStage2TokenSort(field, clientHistory, globalHistory) {
    const label = field.label || '';
    if (!label) return null;

    let bestClientMatch = null;
    let highestClientScore = 0;

    // 1. Search client-specific question bank records
    for (const record of clientHistory) {
      if (!record.question_label) continue;
      const score = tokenSortSimilarity(label, record.question_label);
      if (score > highestClientScore) {
        highestClientScore = score;
        bestClientMatch = record;
      }
    }

    if (bestClientMatch && highestClientScore >= 0.75) {
      const tierCap = (bestClientMatch.source === 'manual' || bestClientMatch.confidence === 1.0) ? 0.98 : 0.90;

      // Score >= 0.85: accept directly
      if (highestClientScore >= 0.85) {
        return {
          rawValue: bestClientMatch.value,
          score: highestClientScore,
          tierCap,
          source: 'tier2_question_bank_client'
        };
      }

      // Conditional 0.75 - 0.84: verify against target options
      if (field.options?.length) {
        const optionMatch = findBestOptionMatch([bestClientMatch.value], field.options, 80);
        if (optionMatch) {
          return {
            rawValue: optionMatch,
            score: highestClientScore,
            tierCap,
            source: 'tier2_question_bank_client'
          };
        }
      }
    }

    // 2. Cross-client fallback (strictly blocking PII/location/legal fields)
    if (isPiiOrPersonalQuestion(label)) {
      return null;
    }

    let bestGlobalMatch = null;
    let highestGlobalScore = 0;

    for (const record of globalHistory) {
      if (!record.question_label) continue;
      const score = tokenSortSimilarity(label, record.question_label);
      if (score > highestGlobalScore) {
        highestGlobalScore = score;
        bestGlobalMatch = record;
      }
    }

    if (bestGlobalMatch && highestGlobalScore >= 0.85) {
      return {
        rawValue: bestGlobalMatch.value,
        score: Math.min(highestGlobalScore, 0.85),
        tierCap: 0.85,
        source: 'tier2_question_bank_global'
      };
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // STAGE 3 SEMANTIC SYNSET & OPTION REDUCER
  // --------------------------------------------------------------------------
  #matchStage3Synsets(field, clientInfo, addInfo, clientHistory, globalHistory) {
    const label = field.label || '';

    // Synset: Opportunity Source / Referral
    if (/how\s*did\s*you\s*(hear|learn|come\s*to\s*know)\s*about|opportunity\s*source/i.test(label)) {
      const candidateChoices = ['LinkedIn', 'Company Website', 'Online Job Board', 'Other'];
      if (field.options?.length) {
        const bestOpt = findBestOptionMatch(candidateChoices, field.options, 60);
        if (bestOpt) {
          return { rawValue: bestOpt, score: 0.85, tierCap: 0.90, source: 'tier2_synset' };
        }
      }
      return { rawValue: 'LinkedIn', score: 0.80, tierCap: 0.90, source: 'tier2_synset' };
    }

    // Synset: Start date / Timeline
    if (/start\s*date|earliest\s*you\s*would\s*want\s*to\s*start/i.test(label)) {
      if (/month/i.test(label)) {
        return { rawValue: 'Immediately', score: 0.85, tierCap: 0.90, source: 'tier1_client_profile' };
      }
      return { rawValue: addInfo.desired_start_date || 'Immediately', score: 0.85, tierCap: 0.90, source: 'tier1_client_profile' };
    }

    // Synset: Notice Period / Availability
    if (/notice\s*period|availability|available\s*to\s*start|how\s*soon\s*(can|could)\s*you\s*start|state\s*(your\s*)?(notice|availability)/i.test(label)) {
      const candidateNotice = addInfo.notice_period || addInfo.availability || 'Immediate';
      const candidateChoices = [candidateNotice, 'Immediate', 'Immediately', '1 Month', '2 Weeks', '1 - 2 weeks', '1-2 months', 'Negotiable'];
      if (field.options?.length) {
        const bestOpt = findBestOptionMatch(candidateChoices, field.options, 50);
        if (bestOpt) {
          return { rawValue: bestOpt, score: 0.85, tierCap: 0.90, source: 'tier2_synset' };
        }
      }
      return { rawValue: candidateNotice, score: 0.85, tierCap: 0.90, source: 'tier2_synset' };
    }

    // Synset: Salary expectations & Package requirements
    if (/(salary|package|compensation)\s*(and\s*benefits\s*)?(requirements?|expectations?|package)|desired\s*salary|state\s*your\s*(current\s*)?salary/i.test(label)) {
      const salary = clientInfo.salary_range || addInfo.desired_salary || 'Competitive / Negotiable';
      return { rawValue: salary, score: 0.80, tierCap: 0.90, source: 'tier1_client_profile' };
    }

    return null;
  }

  #isValidValue(value, field) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.trim() === '' && field.required) return false;
    if (Array.isArray(value) && value.length === 0 && field.required) return false;
    return true;
  }
}
