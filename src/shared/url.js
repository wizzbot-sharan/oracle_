import { invariant } from './errors.js';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'source', 'sourceType', 'src'
]);

export function parseOracleJobUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    invariant(false, 'INVALID_JOB_URL', `Invalid job URL: ${rawUrl}`);
  }

  invariant(url.protocol === 'https:', 'UNSAFE_JOB_URL', 'Oracle job URL must use HTTPS');
  invariant(url.hostname.endsWith('.oraclecloud.com'), 'UNSUPPORTED_JOB_HOST', `Not an Oracle Cloud host: ${url.hostname}`);

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) url.searchParams.delete(key);
  }
  url.hash = '';
  url.pathname = url.pathname
    .replace('/CandidateExperience/en/job/', '/CandidateExperience/en/sites/CX/job/')
    .replace(/\/+$/, '');

  const match = url.pathname.match(/\/(?:job|requisitions(?:\/preview)?|requisition)\/([a-zA-Z0-9_-]+)/i);
  invariant(match, 'MISSING_JOB_ID', `Could not find job ID in URL: ${rawUrl}`);

  return {
    canonicalUrl: url.toString().replace(/\?$/, ''),
    tenantHost: url.hostname.toLowerCase(),
    tenantKey: url.hostname.split('.')[0].toLowerCase(),
    sourceJobId: match[1]
  };
}
