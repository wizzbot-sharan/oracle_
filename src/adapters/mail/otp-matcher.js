const SUBJECT_PATTERNS = [
  /confirm your identity/i,
  /verify your identity/i,
  /verification code/i,
  /verify your e-?mail/i,
  /confirm your e-?mail/i,
  /one[ -]time pass(?:word|code)/i,
  /security code/i,
  /access code/i
];

const BODY_PATTERNS = [
  /one[ -]time pass(?:word|\s*code)/i,
  /verification code/i,
  /security code/i,
  /confirm your identity/i,
  /verify your identity/i,
  /code will expire/i
];

const ORACLE_SENDERS = [
  /@oracle\.com$/i,
  /@[^@]*\.oraclecloud\.com$/i,
  /@workflow\.email\.[^.]+\.ocs\.oraclecloud\.com$/i
];

export function decodeEntities(value = '') {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

export function htmlToText(html = '') {
  return decodeEntities(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tenantHostFound(html, tenantHost) {
  const urls = html.match(/https:\/\/[^\s"'<>]+/gi) ?? [];
  return urls.some(raw => {
    try {
      return new URL(decodeEntities(raw)).hostname.toLowerCase() === tenantHost.toLowerCase();
    } catch {
      return false;
    }
  });
}

export function extractOtp(text) {
  const normalized = text.replace(/\s+/g, ' ');
  const intent = /(one[ -]time pass(?:word|\s*code)|verification code|security code|confirm your identity|verify your identity|code will expire)/ig;
  const nearbyCodes = [];
  for (const match of normalized.matchAll(intent)) {
    const nearby = normalized.slice(match.index, match.index + 180);
    nearbyCodes.push(...[...nearby.matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map(code => code[1]));
  }
  const nearbyUnique = [...new Set(nearbyCodes)];
  if (nearbyUnique.length === 1) return nearbyUnique[0];
  if (nearbyUnique.length > 1) return null;
  const all = [...normalized.matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map(match => match[1]);
  const unique = [...new Set(all)];
  return unique.length === 1 ? unique[0] : null;
}

export function scoreOtpMessage({ summary, body, candidateEmail, requestedAt, tenantHost, tenantKey, companyDomains = [], consumedIds = new Set() }) {
  const receivedTime = Number(summary.receivedTime);
  const recipient = decodeEntities(summary.to ?? '').toLowerCase();
  const sender = decodeEntities(summary.from ?? '').toLowerCase();
  const subject = decodeEntities(summary.subject ?? '');
  const html = body.htmlContent ?? '';
  const text = `${body.textContent ?? ''} ${htmlToText(html)}`;
  const code = extractOtp(text);

  const rejected = [];
  if (!recipient.includes(candidateEmail.toLowerCase())) rejected.push('recipient-mismatch');
  if (!Number.isFinite(receivedTime) || receivedTime < requestedAt - 15_000) rejected.push('too-old');
  if (!code) rejected.push('missing-or-ambiguous-code');
  if (consumedIds.has(String(summary.messageId))) rejected.push('already-consumed');
  if (rejected.length) return { accepted: false, score: 0, code: null, rejected };

  let score = 35;
  if (receivedTime >= requestedAt) score += 30;
  if (SUBJECT_PATTERNS.some(pattern => pattern.test(subject))) score += 20;
  if (BODY_PATTERNS.some(pattern => pattern.test(text))) score += 25;
  if (ORACLE_SENDERS.some(pattern => pattern.test(sender))) score += 15;
  if (companyDomains.some(domain => sender.endsWith(`@${domain.toLowerCase()}`))) score += 10;
  if (tenantHostFound(html, tenantHost)) score += 25;
  if (new RegExp(`(^|[^a-z0-9])${tenantKey}([^a-z0-9]|$)`, 'i').test(`${sender} ${text}`)) score += 5;

  return { accepted: score >= 80, score, code, rejected: [] };
}

export function chooseOtpCandidate(candidates) {
  const accepted = candidates.filter(item => item.match.accepted)
    .sort((a, b) => b.match.score - a.match.score || Number(b.summary.receivedTime) - Number(a.summary.receivedTime));
  if (!accepted.length) return null;
  if (accepted.length > 1 && accepted[0].match.code !== accepted[1].match.code && accepted[0].match.score - accepted[1].match.score <= 10) {
    return { ambiguous: true, candidates: accepted.slice(0, 2) };
  }
  return { ambiguous: false, candidate: accepted[0] };
}

export const otpIntentPatterns = { subject: SUBJECT_PATTERNS, body: BODY_PATTERNS };
