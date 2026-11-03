import { delay } from '../../shared/time.js';
import { WorkflowError } from '../../shared/errors.js';
import { chooseOtpCandidate, otpIntentPatterns, scoreOtpMessage } from './otp-matcher.js';

async function getJson(url, signal) {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new WorkflowError('MAIL_READER_ERROR', `Mail reader returned HTTP ${response.status}`);
  return response.json();
}

export class ZohoMailReader {
  constructor({ baseUrl, pollIntervalMs = 3000, timeoutMs = 120000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.consumedIds = new Set();
  }

  async listInbox(email, limit = 20) {
    const url = new URL(`${this.baseUrl}/inbox`);
    url.searchParams.set('email', email);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('start', '1');
    return getJson(url);
  }

  async getMessage({ email, accountId, folderId, messageId }) {
    const url = new URL(`${this.baseUrl}/message`);
    url.searchParams.set('email', email);
    url.searchParams.set('accountId', accountId);
    url.searchParams.set('folderId', folderId);
    url.searchParams.set('messageId', messageId);
    const result = await getJson(url);
    return result.message;
  }

  async waitForOtp({ candidateEmail, requestedAt, tenantHost, tenantKey, companyDomains = [] }) {
    const deadline = Date.now() + this.timeoutMs;
    let lastAmbiguous = null;

    while (Date.now() < deadline) {
      const inbox = await this.listInbox(candidateEmail);
      const recent = (inbox.messages ?? []).filter(message => {
        if (Number(message.receivedTime) < requestedAt - 15_000) return false;
        return otpIntentPatterns.subject.some(pattern => pattern.test(message.subject ?? '')) ||
          /oracle|workflow\.email|oraclecloud/i.test(message.from ?? '');
      });

      const candidates = [];
      for (const summary of recent.slice(0, 8)) {
        const body = await this.getMessage({
          email: candidateEmail,
          accountId: inbox.accountId,
          folderId: summary.folderId,
          messageId: summary.messageId
        });
        const match = scoreOtpMessage({
          summary,
          body,
          candidateEmail,
          requestedAt,
          tenantHost,
          tenantKey,
          companyDomains,
          consumedIds: this.consumedIds
        });
        candidates.push({ summary, match });
      }

      const selected = chooseOtpCandidate(candidates);
      if (selected && !selected.ambiguous) {
        this.consumedIds.add(String(selected.candidate.summary.messageId));
        return selected.candidate.match.code;
      }
      if (selected?.ambiguous) lastAmbiguous = selected;
      await delay(this.pollIntervalMs);
    }

    throw new WorkflowError(
      lastAmbiguous ? 'AMBIGUOUS_OTP_EMAIL' : 'OTP_EMAIL_TIMEOUT',
      lastAmbiguous ? 'Multiple OTP emails matched this login request' : 'No matching OTP email arrived before timeout'
    );
  }
}
