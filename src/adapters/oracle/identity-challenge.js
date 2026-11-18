export function lastNameChallengeInput(page) {
  return page.getByRole('textbox', { name: /^last name\s*\*?$/i }).or(
    page.locator('input[name="lastName" i], input[name="last_name" i], input[id*="lastName" i]')
  ).first();
}

export function otpChallengeInput(page) {
  return page.locator([
    'input[aria-label*="digit" i]',
    'input[name*="verificationCode" i]',
    'input[aria-label*="verification code" i]',
    'input[autocomplete="one-time-code"]'
  ].join(', ')).first();
}

export async function detectIdentityChallenge(page) {
  const shown = async locator => {
    if (typeof locator.isVisible === 'function') return locator.isVisible().catch(() => false);
    return locator.count().then(count => count > 0).catch(() => false);
  };
  if (await shown(lastNameChallengeInput(page))) return 'last_name';
  if (await shown(otpChallengeInput(page))) return 'otp';
  return null;
}

export function isApplicationFlowUrl(url) {
  try {
    return /\/apply\/(?:section|flow|application)(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
