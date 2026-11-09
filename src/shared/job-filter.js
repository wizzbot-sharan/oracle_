/**
 * Shared utility for parsing and applying job and assignment selection filters.
 * Supports:
 *  - Range syntax: --range 50-100 or --range job_50-job_100 or --from 50 --to 100
 *  - Comma-separated job keys: --jobs job_1,job_2,job_3 or --job job_1
 *  - Client filter: --client AWL-32411 or --user AWL-32411
 *  - Company filter: --company "FirstEnergy"
 */

function extractNumericIndex(jobKey) {
  if (!jobKey) return null;
  const match = String(jobKey).trim().match(/(?:^|\b)(?:job_)?(\d+)(?:\b|$)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function parseJobSelector(options = {}) {
  let range = null;
  const explicitJobKeys = new Set();
  let client = null;
  let company = null;

  // 1. Parse Range (--range 50-100 or --range job_50-job_100)
  if (options.range) {
    const parts = String(options.range).split('-').map(s => s.trim());
    if (parts.length === 2) {
      const startNum = extractNumericIndex(parts[0]);
      const endNum = extractNumericIndex(parts[1]);
      if (startNum !== null && endNum !== null) {
        range = {
          start: Math.min(startNum, endNum),
          end: Math.max(startNum, endNum),
          raw: options.range
        };
      }
    }
  }

  // Also support --from <N> --to <N>
  if (!range && (options.from !== undefined || options.to !== undefined)) {
    const startNum = options.from !== undefined ? extractNumericIndex(options.from) : 1;
    const endNum = options.to !== undefined ? extractNumericIndex(options.to) : Infinity;
    if (startNum !== null && endNum !== null) {
      range = {
        start: Math.min(startNum, endNum),
        end: Math.max(startNum, endNum),
        raw: `${startNum}-${endNum}`
      };
    }
  }

  // 2. Parse Explicit Job Keys (--job, --jobs, --jobKey)
  const rawJobKeys = options.jobs ?? options.job ?? options.jobKey;
  if (rawJobKeys) {
    const keys = Array.isArray(rawJobKeys)
      ? rawJobKeys
      : String(rawJobKeys).split(',').map(s => s.trim()).filter(Boolean);
    for (const k of keys) {
      explicitJobKeys.add(k);
    }
  }

  // 3. Parse Client (--client, --applywizzId, --user)
  const rawClient = options.client ?? options.applywizzId ?? options.user;
  if (rawClient) {
    client = String(rawClient).trim().toUpperCase();
  }

  // 4. Parse Company (--company)
  if (options.company) {
    company = String(options.company).trim().toLowerCase();
  }

  const hasFilter = Boolean(range || explicitJobKeys.size > 0 || client || company);

  let description = 'All Jobs (unrestricted)';
  if (hasFilter) {
    const parts = [];
    if (range) parts.push(`Range [job_${range.start} - job_${range.end}]`);
    if (explicitJobKeys.size > 0) parts.push(`Jobs: ${Array.from(explicitJobKeys).join(', ')}`);
    if (client) parts.push(`Client: ${client}`);
    if (company) parts.push(`Company: "${options.company}"`);
    description = parts.join(' | ');
  }

  return {
    hasFilter,
    range,
    explicitJobKeys,
    client,
    company,
    description
  };
}

export function isJobSelected(jobKey, selector) {
  if (!selector || !selector.hasFilter) return true;
  if (!jobKey) return false;

  const keyStr = String(jobKey).trim();

  // If explicit job keys specified, must match one
  if (selector.explicitJobKeys.size > 0 && selector.explicitJobKeys.has(keyStr)) {
    return true;
  }

  // If range specified, numeric index must be inside [start, end]
  if (selector.range) {
    const num = extractNumericIndex(keyStr);
    if (num !== null && num >= selector.range.start && num <= selector.range.end) {
      return true;
    }
  }

  // If only explicit keys or range were specified and didn't match:
  if (selector.explicitJobKeys.size > 0 || selector.range) {
    return false;
  }

  // If no job/range criteria were specified, this job passes to other filters
  return true;
}

export function isAssignmentSelected(assignment, selector) {
  if (!selector || !selector.hasFilter) return true;
  if (!assignment) return false;

  // 1. Check Job Selection (by jobKey or jobId)
  if (selector.range || selector.explicitJobKeys.size > 0) {
    const jobKeyMatched = assignment.jobKey ? isJobSelected(assignment.jobKey, selector) : false;
    const jobIdMatched = assignment.jobId ? isJobSelected(assignment.jobId, selector) : false;
    if (!jobKeyMatched && !jobIdMatched) {
      return false;
    }
  }

  // 2. Check Client Filter
  if (selector.client) {
    const candidateId = String(assignment.applywizzId || assignment.userId || '').trim().toUpperCase();
    if (candidateId !== selector.client) {
      return false;
    }
  }

  // 3. Check Company Filter
  if (selector.company) {
    const companyName = String(assignment.companyName || '').trim().toLowerCase();
    if (!companyName.includes(selector.company)) {
      return false;
    }
  }

  return true;
}
