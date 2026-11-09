import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium as vanillaChromium } from 'playwright';
import { chromium as extraChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { WorkflowError, invariant } from '../../shared/errors.js';
import { delay, humanPause, randomBetween } from '../../shared/time.js';
import {
  coerceToBoolean,
  coerceToRadio,
  coerceToMultiSelect,
  coerceToString,
  coerceValueForField
} from '../../domain/coercion.js';

let stealthConfiguredChromium = extraChromium;
try {
  const plugin = typeof stealthPlugin === 'function' ? stealthPlugin() : stealthPlugin?.default?.();
  if (plugin && typeof extraChromium?.use === 'function') {
    extraChromium.use(plugin);
  } else {
    stealthConfiguredChromium = vanillaChromium;
  }
} catch {
  stealthConfiguredChromium = vanillaChromium;
}

const SUBMIT_PATTERN = /^(submit|submit application)$/i;

async function visible(locator) {
  return locator.count().then(count => count > 0).catch(() => false);
}

async function humanType(locator, value, delayRange) {
  await locator.click();
  await locator.fill('');
  for (const character of String(value)) {
    await locator.pressSequentially(character, { delay: randomBetween(delayRange.min, delayRange.max) });
  }
}

function normalizeText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

async function controlDescriptor(locator) {
  return locator.evaluate(element => {
    const text = value => (value ?? '').replace(/\s+/g, ' ').trim();
    const byId = id => id ? document.getElementById(id) : null;
    const labelledBy = element.getAttribute('aria-labelledby')
      ?.split(/\s+/).map(byId).filter(Boolean).map(node => node.textContent).join(' ');
    const explicitLabel = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"] .apply-flow-input-checkbox__label, label[for="${CSS.escape(element.id)}"]`)?.textContent : '';
    const wrapper = element.parentElement?.closest('.input-row, .form-field, [role="group"], .legal-disclaimer-container') || element.closest('.input-row, .form-field, [role="group"], .legal-disclaimer-container');
    const wrapperLabel = wrapper?.querySelector('label, legend, [class*="label"], .apply-flow-input-checkbox__label')?.textContent;
    const region = element.closest('[role="region"][aria-label]');
    const isPhonePrefix = Boolean(element.closest('.phone-row__prefix'));
    const isPhoneNumber = Boolean(element.closest('.phone-row__number') || element.classList?.contains('phone-row__input') || element.getAttribute('type') === 'tel');
    let label = text(element.getAttribute('aria-label') || labelledBy || explicitLabel || wrapperLabel || element.name || element.id);
    if (isPhonePrefix && (!label || label.toLowerCase().includes('phone number'))) {
      label = 'Country/Region code';
    } else if (isPhoneNumber && (!label || label.toLowerCase().includes('country'))) {
      label = 'Phone Number';
    }
    const role = element.getAttribute('role');
    const isCustomCheckbox = element.classList?.contains('apply-flow-input-checkbox__button') || element.classList?.contains('apply-flow-input-checkbox') || element.type === 'checkbox' || role === 'checkbox';
    const type = isPhonePrefix || role === 'combobox' ? 'combobox' : isCustomCheckbox ? 'checkbox' : (isPhoneNumber ? 'tel' : (element.getAttribute('type') || (element.tagName.toLowerCase() === 'input' ? 'text' : element.tagName.toLowerCase())));
    const checkboxInput = isCustomCheckbox ? (element.tagName.toLowerCase() === 'input' ? element : wrapper?.querySelector('input[type="checkbox"]')) : null;

    const enclosingLabelId = element.closest('label')?.id || wrapper?.querySelector('label')?.id || wrapper?.id;
    const ariaLabelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).find(byId);
    const sourceId = element.id || checkboxInput?.id || enclosingLabelId || ariaLabelledBy || null;

    return {
      sourceId,
      sourceName: element.getAttribute('name') || checkboxInput?.getAttribute('name') || null,
      tag: element.tagName.toLowerCase(),
      role,
      type,
      label,
      isPhonePrefix,
      isPhoneNumber,
      sectionLabel: text(region?.getAttribute('aria-label')) || null,
      required: element.required || checkboxInput?.required || element.getAttribute('aria-required') === 'true' || Boolean(wrapper?.querySelector('.input-row__label--required, .input-row__label--required-star, .apply-flow-input-checkbox__label--required')),
      disabled: element.disabled || checkboxInput?.disabled || element.getAttribute('aria-disabled') === 'true'
    };
  });
}

export class OracleRecruitingAdapter {
  constructor({ headless, humanDelay, actionGap, postNextWait, pageSettle, initialWait, runtimeDir, browserChannel } = {}) {
    this.headless = headless;
    this.humanDelay = humanDelay ?? { min: 50, max: 200 };
    this.actionGap = actionGap ?? { min: 1000, max: 2000 };
    this.postNextWait = postNextWait ?? { min: 3000, max: 5000 };
    this.pageSettle = pageSettle;
    this.initialWait = initialWait ?? 10_000;
    this.runtimeDir = runtimeDir ?? 'data/runtime';
    this.browserChannel = browserChannel ?? 'chrome';
  }

  async createSession({ applicationId }) {
    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1440,1000'
    ];

    let browser;
    if (this.browserChannel) {
      try {
        browser = await stealthConfiguredChromium.launch({
          channel: this.browserChannel,
          headless: this.headless,
          args: launchArgs
        });
      } catch {
        browser = await stealthConfiguredChromium.launch({
          headless: this.headless,
          args: launchArgs
        });
      }
    } else {
      browser = await stealthConfiguredChromium.launch({
        headless: this.headless,
        args: launchArgs
      });
    }

    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    const page = await context.newPage();
    return { applicationId, browser, context, page, createdAt: Date.now() };
  }

  async closeSession(session) {
    await session?.browser?.close().catch(() => { });
  }

  async detectCaptcha(page) {
    try {
      const captchaLocators = page.locator([
        'iframe[src*="arkose" i]',
        'iframe[title*="verification" i]',
        '#fc-iframe-wrap',
        '[data-bind*="arkose" i]',
        'iframe[src*="recaptcha" i]',
        '.g-recaptcha',
        '.recaptcha-checkbox',
        'iframe[src*="hcaptcha" i]',
        '.h-captcha',
        'iframe[src*="challenges.cloudflare.com" i]',
        '.cf-turnstile',
        '.captcha',
        '.security-verification-container',
        'input[name*="captcha" i]',
        '[aria-label*="captcha" i]',
        'text=/please verify you are human/i',
        'text=/security verification/i'
      ].join(', '));

      const count = await captchaLocators.count().catch(() => 0);
      if (count === 0) return false;

      for (let i = 0; i < count; i += 1) {
        const loc = captchaLocators.nth(i);
        const isVis = await loc.isVisible().catch(() => false);
        if (isVis) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async #isAlreadyApplied(page) {
    try {
      if (/job-applied|already-applied|alreadySubmitted/i.test(page.url())) {
        return true;
      }

      const appliedTextLocator = page.locator([
        'text=/applied to this job/i',
        'text=/already applied/i',
        'text=/you have already applied/i',
        'text=/already submitted/i',
        'text=/application has already been submitted/i',
        'text=/you already applied/i',
        'text=/already submitted an application/i'
      ].join(', ')).first();

      if (await visible(appliedTextLocator)) {
        return true;
      }

      const alerts = page.locator('[role="alert"], .oj-message-detail, .alert-container, .quick-apply-flow-error');
      const alertCount = await alerts.count().catch(() => 0);
      for (let i = 0; i < alertCount; i++) {
        const alertText = (await alerts.nth(i).innerText().catch(() => '')) || '';
        if (/applied to this job|already applied|already submitted/i.test(alertText)) {
          return true;
        }
      }

      const appliedButton = page.locator('button:has-text("Applied"):visible, [aria-label*="Already applied" i]:visible, [data-qa*="applied"]:visible').first();
      if (await visible(appliedButton)) {
        return true;
      }
    } catch {
      // Ignore inspection errors and fall through
    }
    return false;
  }

  async #ensureStandardApplyFlow(page) {
    try {
      const isEasyApply = (page.url() || '').includes('/easy-apply');
      const manualLink = page.locator([
        'a.quick-apply-flow__manually--link',
        'a:has-text("manually")',
        'button:has-text("manually")',
        '[data-i18n-token="standard_flow_link"]',
        '.quick-apply-flow__manually a'
      ].join(', ')).first();

      const isVisible = await visible(manualLink);
      if (isEasyApply || isVisible) {
        console.error('[Oracle Adapter] Detected /easy-apply splash screen. Clicking "manually" to open application form...');
        await manualLink.click({ timeout: 5000 }).catch(() => {});
        await Promise.race([
          page.waitForURL(url => url.pathname.includes('/apply/section') || url.pathname.includes('/apply/application') || url.pathname.includes('/apply/flow'), { timeout: 15_000 }),
          page.locator('.apply-flow, main, [role="main"]').first().waitFor({ state: 'visible', timeout: 15_000 })
        ]).catch(() => {});
        await humanPause(this.actionGap);
        await delay(this.initialWait);
      }
    } catch {
      // Non-fatal if splash screen check encounters transient issue
    }
  }

  async authenticate({ session, job, email, mailReader, companyDomains = [] }) {
    const { page } = session;
    console.error(`[Phase 1] Navigating to: ${job.canonicalUrl}`);
    await page.goto(job.canonicalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    console.error(`[Phase 1] Waiting for initial page to load...`);
    await delay(this.initialWait);
    await humanPause(this.actionGap);

    const applyButton = page.locator([
      'button.apply-now-button:visible',
      'button:has-text("Apply Now"):visible',
      'a:has-text("Apply Now"):visible',
      'button:has-text("Apply"):not(#filter-apply-handler):visible',
      'a[role="button"]:has-text("Apply"):visible'
    ].join(', ')).first();

    const hasApplyButton = await applyButton.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    if (!hasApplyButton) {
      if (await this.#isAlreadyApplied(page)) {
        console.error(`[Phase 1] ⚠ Job already applied (indicated on job page). Skipping.`);
        return { status: 'skipped', reason: 'ALREADY_APPLIED', message: 'Candidate has already applied to this job' };
      }
      console.error(`[Phase 1] ⚠ No Apply button found after wait. Skipping.`);
      return { status: 'skipped', reason: 'NO_APPLY_BUTTON', message: 'No Apply button found on job page' };
    }

    console.error(`[Phase 1] Scrolling to Apply Now button...`);
    await applyButton.scrollIntoViewIfNeeded().catch(() => { });
    await humanPause(this.actionGap);
    console.error(`[Phase 1] Clicking Apply button (attempt 1)...`);
    await applyButton.click();
    await page.waitForLoadState('domcontentloaded').catch(() => { });

    const isEntryScreenOpen = async () => {
      const emailInput = page.locator([
        'input[name="primary-email"]:visible',
        'input[type="email"]:visible',
        'input[aria-label*="email" i]:visible'
      ].join(', ')).first();

      const phoneOrToggle = page.locator([
        '.quick-apply-flow-verify-method__button:has-text("email instead"):visible',
        'button:has-text("communicate by email"):visible',
        'button:has-text("use email instead"):visible',
        'button:has-text("email instead"):visible',
        'a:has-text("email instead"):visible',
        'input[type="tel"]:visible',
        '#country-codes-dropdownphone-number:visible',
        'input[name*="phone"]:visible'
      ].join(', ')).first();

      return (await visible(emailInput)) || (await visible(phoneOrToggle));
    };

    const waitForEntryScreen = async (timeoutMs = 10_000) => {
      const pollInterval = 500;
      const maxAttempts = Math.ceil(timeoutMs / pollInterval);
      for (let i = 0; i < maxAttempts; i++) {
        if (await isEntryScreenOpen()) {
          return true;
        }
        await delay(pollInterval);
      }
      return false;
    };

    let screenOpened = await waitForEntryScreen(10_000);
    if (!screenOpened) {
      console.error(`[Phase 1] ⚠ Email/entry page did not open within 10 seconds after first click. Scrolling and retrying Apply button click (attempt 2)...`);
      await applyButton.scrollIntoViewIfNeeded().catch(() => { });
      await humanPause(this.actionGap);
      await applyButton.click({ force: true }).catch(() => applyButton.click().catch(() => { }));
      await page.waitForLoadState('domcontentloaded').catch(() => { });

      screenOpened = await waitForEntryScreen(10_000);
      if (!screenOpened) {
        const errorMsg = `[Phase 1] ✖ Error: Email/entry page failed to open after clicking Apply button twice (waited 10s each time).`;
        console.error(errorMsg);
        throw new WorkflowError('APPLY_BUTTON_FAILED', errorMsg);
      }
      console.error(`[Phase 1] ✓ Email/entry page opened on attempt 2.`);
    } else {
      console.error(`[Phase 1] ✓ Email/entry page opened on attempt 1.`);
    }

    const switchToEmail = page.locator([
      '.quick-apply-flow-verify-method__button:has-text("email instead")',
      'button:has-text("communicate by email")',
      'button:has-text("use email instead")',
      'button:has-text("email instead")',
      'a:has-text("email instead")'
    ].join(', ')).first();

    const phoneIndicator = page.locator([
      'input[type="tel"]:visible',
      '#country-codes-dropdownphone-number:visible',
      'input[name*="phone"]:visible'
    ].join(', ')).first();

    if (await visible(switchToEmail) || await visible(phoneIndicator)) {
      if (await visible(switchToEmail)) {
        console.error(`[Phase 1] Detected phone screen; switching to email...`);
        await humanPause(this.actionGap);
        await switchToEmail.click();
        await page.locator('input[type="email"], input[name="primary-email"]').first().waitFor({ state: 'visible', timeout: 10_000 });
        await humanPause(this.actionGap);
      }
    }

    const emailField = page.locator([
      'input[name="primary-email"]:visible',
      'input[type="email"]:visible',
      'input[aria-label*="email" i]:visible'
    ].join(', ')).first();
    await emailField.waitFor({ state: 'visible', timeout: 10_000 });
    console.error(`[Phase 1] Entering email address: ${email}`);
    await humanPause(this.actionGap);
    await humanType(emailField, email, this.humanDelay);
    await humanPause(this.actionGap);

    // 4. Handle terms & conditions / legal disclaimer checkbox
    const disclaimerInput = page.locator('#legal-disclaimer-checkbox');
    if (await disclaimerInput.count() > 0) {
      const isChecked = await disclaimerInput.isChecked().catch(() => false);
      if (!isChecked) {
        console.error(`[Phase 1] Checking terms & conditions checkbox...`);
        await humanPause(this.actionGap);
        // In Oracle HCM, click specifically the square checkbox button inside label[for="legal-disclaimer-checkbox"].
        // Never click the label or text container, because <a id="legal-disclaimer-link"> opens the full-page terms modal.
        const visibleToggle = page.locator('label[for="legal-disclaimer-checkbox"] .apply-flow-input-checkbox__button:visible').first();
        if (await visible(visibleToggle)) {
          await visibleToggle.click();
        } else {
          await disclaimerInput.check({ force: true }).catch(() => { });
        }
        await humanPause(this.actionGap);
      }
    }

    // Check any other native visible required checkboxes
    const otherRequiredCheckboxes = page.locator('input[type="checkbox"][required]:visible:not(#legal-disclaimer-checkbox), [role="checkbox"][aria-required="true"]:visible');
    const otherCount = await otherRequiredCheckboxes.count();
    for (let index = 0; index < otherCount; index += 1) {
      const checkbox = otherRequiredCheckboxes.nth(index);
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (!isChecked) {
        console.error(`[Phase 1] Checking required checkbox ${index + 1}...`);
        await humanPause(this.actionGap);
        await checkbox.click();
        await humanPause(this.actionGap);
      }
    }

    const nextButton = page.locator([
      'button.apply-flow-pagination__button.theme-color-1:visible',
      'button[aria-label="Next" i]:not(.text-color-secondary):visible',
      'button[title="Next" i]:not(.text-color-secondary):visible',
      'button[aria-label="Continue" i]:not(.text-color-secondary):visible',
      'button.apply-flow-pagination__button:not(.text-color-secondary):not(:has-text("Cancel")):visible'
    ].join(', ')).first();

    await nextButton.waitFor({ state: 'visible', timeout: 10_000 });
    console.error(`[Phase 1] Clicking Next button...`);
    await humanPause(this.actionGap);

    const requestedAt = Date.now();
    await nextButton.click();

    // Configurable wait time after clicking Next before proceeding to OTP or next phase
    console.error(`[Phase 1] Pausing for post-Next settle...`);
    await humanPause(this.postNextWait);

    if (await this.detectCaptcha(page)) {
      console.error(`[Phase 1] ⚠ CAPTCHA challenge detected after email submission on ${job.tenantHost}.`);
      return {
        status: 'skipped',
        reason: 'captcha_required',
        message: 'CAPTCHA challenge presented after email submission'
      };
    }

    console.error(`[Phase 1] Waiting for OTP prompt or application flow...`);
    const otpMarker = page.getByRole('heading', { name: /confirm your identity|verify/i }).or(
      page.locator('input[aria-label*="digit" i], input[name*="verificationCode" i]')
    );
    await Promise.race([
      page.waitForURL(/\/apply\/(section|flow|application)/, { timeout: 20_000 }),
      otpMarker.first().waitFor({ state: 'visible', timeout: 20_000 })
    ]).catch(() => { });

    if (await this.detectCaptcha(page)) {
      console.error(`[Phase 1] ⚠ CAPTCHA challenge detected during verification flow on ${job.tenantHost}.`);
      return {
        status: 'skipped',
        reason: 'captcha_required',
        message: 'CAPTCHA challenge presented during verification flow'
      };
    }

    if (await visible(otpMarker.first())) {
      console.error(`[Phase 1] OTP screen presented. Polling mailbox for 6-digit code...`);
      const code = await mailReader.waitForOtp({
        candidateEmail: email,
        requestedAt,
        tenantHost: job.tenantHost,
        tenantKey: job.tenantKey,
        companyDomains
      });
      console.error(`[Phase 1] OTP received. Entering code...`);
      await humanPause(this.actionGap);
      await this.#fillOtp(page, code);
      await humanPause(this.actionGap);

      const verifyButton = page.locator([
        'button:has-text("Verify"):visible',
        'button[aria-label*="Verify" i]:visible',
        'button.theme-color-1:has-text("Verify"):visible'
      ].join(', ')).first();
      console.error(`[Phase 1] Clicking Verify button...`);
      await verifyButton.click();
      await humanPause(this.postNextWait);
    }

    console.error(`[Phase 1] Waiting for application flow or already applied notice...`);
    const alreadyAppliedIndicator = page.locator([
      'text=/applied to this job/i',
      'text=/already applied/i',
      'text=/you have already applied/i',
      'text=/already submitted/i',
      '[role="alert"]',
      '.alert-container',
      '.quick-apply-flow-error'
    ].join(', ')).first();

    console.error(`[Phase 1] Waiting for URL to exit /apply/email or already applied notice...`);
    await Promise.race([
      page.waitForURL(url => !url.pathname.endsWith('/apply/email'), { timeout: 30_000 }),
      alreadyAppliedIndicator.waitFor({ state: 'visible', timeout: 30_000 })
    ]).catch(() => { });

    console.error(`[Phase 1] Waiting for page to settle and checking application state...`);
    await delay(this.initialWait);

    if (await this.#isAlreadyApplied(page)) {
      console.error(`[Phase 1] ⚠ 'Already applied' message detected after login. Skipping.`);
      return { status: 'skipped', reason: 'ALREADY_APPLIED', message: 'Candidate has already applied to this job', url: page.url() };
    }

    await this.#ensureStandardApplyFlow(page);

    await page.waitForURL(/\/apply\/(section|flow|application)/, { timeout: 5_000 }).catch(() => { });
    return { status: 'authenticated', url: page.url(), authenticatedAt: new Date().toISOString() };
  }

  async #fillOtp(page, code) {
    invariant(/^\d{6}$/.test(code), 'INVALID_OTP', 'OTP must contain six digits');
    const digitFields = page.locator('input[aria-label*="Verification code digit" i], input[aria-label*="digit" i]');
    if (await digitFields.count() === 6) {
      for (let index = 0; index < 6; index += 1) {
        await humanType(digitFields.nth(index), code[index], this.humanDelay);
      }
      return;
    }
    const singleField = page.locator([
      'input[aria-label*="verification code" i]',
      'input[name*="verificationCode" i]',
      'input[type="text"][id*="verification" i]'
    ].join(', ')).or(page.getByRole('textbox', { name: /verification code|security code|passcode/i })).first();
    await humanType(singleField, code, this.humanDelay);
  }

  #nextButtonLocator(page) {
    return page.locator([
      'button.apply-flow-pagination__button.theme-color-1:visible',
      'button[aria-label="Next" i]:not(.text-color-secondary):visible',
      'button[title="Next" i]:not(.text-color-secondary):visible',
      'button[aria-label="Continue" i]:not(.text-color-secondary):visible',
      'button.apply-flow-pagination__button:not(.text-color-secondary):not(:has-text("Cancel")):visible'
    ].join(', ')).first();
  }

  async scanForm({ session, job }) {
    const { page } = session;
    invariant(!/submitted|confirmation/i.test(page.url()), 'UNSAFE_SCAN_STATE', 'Scanner reached a submitted page');

    await this.#ensureStandardApplyFlow(page);

    const allFields = [];
    const allBranches = [];
    const allGroups = [];
    const allSections = new Set();
    const seenFieldKeys = new Set();
    const seenGroupIds = new Set();

    let pageNumber = 1;
    const maxPages = 10;
    let submitPresent = false;
    let finalUrl = page.url();

    while (pageNumber <= maxPages) {
      console.error(`[Phase 2] Scanning application page/step ${pageNumber}...`);
      await page.waitForLoadState('domcontentloaded').catch(() => { });
      await humanPause(this.actionGap);

      const pageSections = await page.locator('h2, h3, [role="region"][aria-label]').evaluateAll(elements =>
        [...new Set(elements.map(element => (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))]
      );
      for (const section of pageSections) allSections.add(section);

      const baseline = await this.#extractControls(page);
      for (const field of baseline) {
        field.pageNumber = pageNumber;
        const key = this.#fieldIdentity(field);
        if (!seenFieldKeys.has(key)) {
          seenFieldKeys.add(key);
          allFields.push(field);
          console.error(`[Phase 2] [Job ${job.jobId}] Detected field: "${field.label}" (${field.type}${field.required ? ', required' : ''})`);
        }
      }

      const branches = await this.#scanDirectBranches(page, baseline);
      for (const branch of branches) {
        console.error(`[Phase 2] [Job ${job.jobId}] Discovered branch: when "${branch.triggerLabel}" = "${branch.triggerValue}" -> reveals ${branch.revealed.length} fields`);
        for (const rf of branch.revealed ?? []) {
          rf.pageNumber = pageNumber;
          const key = this.#fieldIdentity(rf);
          if (!seenFieldKeys.has(key)) {
            seenFieldKeys.add(key);
            allFields.push(rf);
          }
        }
      }
      allBranches.push(...branches);

      const groups = await this.#scanRepeatableGroups(page);
      for (const group of groups) {
        if (!seenGroupIds.has(group.id)) {
          seenGroupIds.add(group.id);
          allGroups.push(group);
          console.error(`[Phase 2] [Job ${job.jobId}] Discovered repeatable section: "${group.label}" (add button: "${group.addButton}")`);
        }
      }

      // Check if Submit is visible on this page
      const submitButton = page.getByRole('button', { name: SUBMIT_PATTERN }).first();
      const isSubmitVisible = (await visible(submitButton)) && (await submitButton.isVisible().catch(() => false));
      if (isSubmitVisible) {
        console.error(`[Phase 2] Submit button detected on page ${pageNumber}; stopping multi-page traversal.`);
        submitPresent = true;
        finalUrl = page.url();
        break;
      }

      // Check if a safe Next button is available to advance
      const nextButton = this.#nextButtonLocator(page);
      if (!(await visible(nextButton))) {
        console.error(`[Phase 2] No further Next button on page ${pageNumber}; scan complete.`);
        finalUrl = page.url();
        break;
      }

      const currentUrl = page.url();
      console.error(`[Phase 2] Advancing to next application page...`);
      await humanPause(this.actionGap);
      await nextButton.click();
      await humanPause(this.postNextWait);
      await page.waitForLoadState('domcontentloaded').catch(() => { });

      if (page.url() === currentUrl) {
        if (await visible(submitButton)) {
          submitPresent = true;
          finalUrl = page.url();
          break;
        }
      }
      pageNumber += 1;
    }

    const artifactDir = path.join(this.runtimeDir, 'scans', job.jobId);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'page.html'), await page.content(), 'utf8');
    await page.screenshot({ path: path.join(artifactDir, 'page.png'), fullPage: true });

    return {
      schemaVersion: '0.1.0',
      source: {
        platform: 'oracle-recruiting-cloud',
        tenantHost: job.tenantHost,
        jobId: job.jobId,
        canonicalUrl: job.canonicalUrl
      },
      scan: {
        scannedAt: new Date().toISOString(),
        applicationUrl: finalUrl,
        submitPresent,
        scannerPolicy: 'never-click-submit',
        artifactDir
      },
      sectionLabels: [...allSections],
      fields: allFields,
      conditionalBranches: allBranches,
      repeatableGroups: allGroups
    };
  }

  async #extractCheckboxGroups(page) {
    return page.evaluate(() => {
      const text = v => (v ?? '').replace(/\s+/g, ' ').trim();
      const allContainers = document.querySelectorAll('.input-row, .form-field, [role="group"]');
      const containers = Array.from(allContainers).filter(c => {
        if (typeof c.closest === 'function') {
          if (c.closest('.apply-flow-section[style*="display: none"]')) return false;
          if (c.closest('[style*="display: none"]')) return false;
        }
        return true;
      });
      const groups = [];
      const handledCheckboxIds = [];

      for (const container of containers) {
        const inputMap = new Map();
        for (const cb of container.querySelectorAll('input[type="checkbox"]')) {
          const id = cb.id || cb.name || cb.value;
          if (id) inputMap.set(id, cb);
        }
        if (inputMap.size > 1) {
          const groupLabelEl = container.querySelector('.input-row__label, legend, [class*="label"]:not(.apply-flow-input-checkbox__label)');
          const region = typeof container.closest === 'function' ? container.closest('[role="region"][aria-label]') : null;
          const groupLabel = text(groupLabelEl?.textContent || container.getAttribute('aria-label') || '');
          if (!groupLabel) continue;

          const options = [];
          for (const [key, input] of inputMap.entries()) {
            const optionLabelEl = container.querySelector(`label[for="${CSS.escape(input.id)}"] .apply-flow-input-checkbox__label, label[for="${CSS.escape(input.id)}"]`)
              || (typeof input.closest === 'function' ? input.closest('.input-row__control-item, label')?.querySelector('.apply-flow-input-checkbox__label, label') : null)
              || (typeof input.closest === 'function' ? input.closest('label') : null);
            const optText = text(optionLabelEl?.textContent || input.value || '');
            if (optText && !options.includes(optText)) {
              options.push(optText);
              if (input.id) handledCheckboxIds.push(input.id);
            }
          }
          if (options.length > 1) {
            groups.push({
              sourceId: null,
              sourceName: null,
              tag: 'div',
              role: 'group',
              type: 'multi-checkbox',
              label: groupLabel,
              sectionLabel: text(region?.getAttribute('aria-label')) || null,
              options,
              required: Boolean(container.querySelector('.input-row__label--required, .input-row__label--required-star')),
              disabled: false
            });
          }
        }
      }

      // Also discover Oracle cx-select-pills (multi-select pill button groups)
      const allPills = document.querySelectorAll('.cx-multi-select-pills, .input-row--multiselect, [data-bind*="cx-select-pills"], .cx-select-pills-container');
      const pillContainers = Array.from(allPills).filter(c => {
        if (typeof c.closest === 'function') {
          if (c.closest('.apply-flow-section[style*="display: none"]')) return false;
          if (c.closest('[style*="display: none"]')) return false;
        }
        return true;
      });
      const seenPills = new Set();
      for (const el of pillContainers) {
        const row = (typeof el.closest === 'function' ? el.closest('.input-row, .form-field, [role="group"]') : null) || el;
        if (seenPills.has(row)) continue;
        seenPills.add(row);

        // Filter out single-select radio pills (Yes/No, Title, etc.) so they are handled as role="radiogroup" / type: 'radio'
        const isRadio = Boolean(
          row.getAttribute('role') === 'radiogroup' ||
          row.querySelector('[role="radiogroup"], [role="radio"]') ||
          row.querySelector('[data-bind*="isMultiselect:false"], [data-bind*="isMultiselect: false"]') ||
          (typeof row.closest === 'function' && row.closest('[role="radiogroup"]'))
        );
        if (isRadio) continue;

        const buttons = Array.from(row.querySelectorAll('button.cx-select-pill-section, .cx-select-pill-section'));
        if (!buttons.length) continue;

        const groupLabelEl = row.querySelector('.input-row__label, legend, [class*="label"]') || row.querySelector('ul[aria-label]');
        const region = typeof row.closest === 'function' ? row.closest('[role="region"][aria-label]') : null;
        const groupLabel = text(groupLabelEl?.textContent || row.querySelector('ul')?.getAttribute('aria-label') || '');
        if (!groupLabel) continue;

        const options = [];
        for (const btn of buttons) {
          const nameEl = btn.querySelector('.cx-select-pill-name') || btn;
          const optText = text(nameEl?.textContent || '');
          if (optText && !options.includes(optText)) {
            options.push(optText);
          }
        }

        if (options.length > 0) {
          const containerDiv = row.querySelector('.cx-multi-select-pills, [data-qa]');
          const qaName = containerDiv?.getAttribute('data-qa') || containerDiv?.id || null;
          groups.push({
            sourceId: qaName,
            sourceName: qaName,
            tag: 'div',
            role: 'group',
            type: 'multi-checkbox',
            format: 'pills',
            label: groupLabel,
            sectionLabel: text(region?.getAttribute('aria-label')) || null,
            options,
            required: Boolean(row.querySelector('.input-row__label--required, .input-row__label--required-star')),
            disabled: false
          });
        }
      }

      return { groups, handledCheckboxIds };
    }).catch(() => ({ groups: [], handledCheckboxIds: [] }));
  }

  async #extractControls(page) {
    const { groups: multiCheckboxGroups, handledCheckboxIds } = await this.#extractCheckboxGroups(page);
    const handledSet = new Set(handledCheckboxIds);

    const hasSections = (await page.locator('.apply-flow-section').count().catch(() => 0)) > 0;
    const prefix = hasSections ? '.apply-flow-section:not([style*="display: none"]) ' : '';

    const candidates = page.locator([
      `${prefix}input:not([type="hidden"]):not([aria-hidden="true"]):visible`,
      `${prefix}textarea:not([aria-hidden="true"]):not(.input-row__control--helper):visible`,
      `${prefix}select:visible`,
      `${prefix}[role="combobox"]:visible`,
      `${prefix}[role="radiogroup"]:visible`,
      `${prefix}[role="checkbox"]:visible`,
      `${prefix}label:visible input[type="checkbox"]`,
      `${prefix}.input-row:visible input[type="checkbox"]`,
      `${prefix}.form-field:visible input[type="checkbox"]`,
      `${prefix}.apply-flow-block--file-upload input[type="file"]`,
      `${prefix}.file-form-element input[type="file"]`,
      `${prefix}input[type="file"][name="attachment-upload"]`,
      `${prefix}input[type="file"].apply-flow-profile-import-awli__file-upload`
    ].join(', '));
    const seen = new Set();
    const usedIds = new Set();
    const fields = [];

    for (const group of multiCheckboxGroups) {
      let id = this.#slug(group.label);
      if (usedIds.has(id)) id = `${id}_2`;
      usedIds.add(id);
      seen.add(group.label);
      fields.push({ id, ...group, value: null });
    }

    for (let index = 0; index < await candidates.count(); index += 1) {
      const field = await controlDescriptor(candidates.nth(index));
      if (field.sourceId && handledSet.has(field.sourceId)) continue;
      const key = this.#fieldIdentity(field);
      if (!field.label || /import your profile from resume/i.test(field.label) || seen.has(key)) continue;
      seen.add(key);
      if (field.role === 'radiogroup') {
        field.type = 'radio';
        field.options = await this.#radioOptionLabels(candidates.nth(index));
      }
      let id = this.#fieldId(field, fields.length);
      if (usedIds.has(id)) id = `${id}_${this.#slug(field.label)}`;
      let suffix = 2;
      const baseId = id;
      while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
      usedIds.add(id);
      fields.push({ id, ...field, value: null });
    }
    return fields;
  }

  #fieldId(field, index) {
    if (field.type === 'file' && /cover letter/i.test(field.label)) return 'cover_letter';
    if (field.type === 'file' && /resume/i.test(field.label)) return 'resume';
    if (field.isPhonePrefix || /country-codes-dropdown/i.test(field.sourceId ?? '') || /country.*code/i.test(field.label)) return 'phone_country_code';
    if (field.isPhoneNumber || (field.type === 'tel' && /phone/i.test(field.label))) return 'phone_number';
    const usableSourceName = field.sourceName && !/^\d+$/.test(field.sourceName) ? field.sourceName : null;
    const raw = usableSourceName || field.label || field.sourceId || `field-${index}`;
    return this.#slug(raw);
  }

  #slug(value) {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 100);
  }

  #fieldIdentity(field) {
    return `${field.sourceName ?? ''}|${field.role ?? field.type}|${normalizeText(field.label).toLowerCase()}`;
  }

  async #toggleMultiOption(page, group, option, enable) {
    const row = page.locator(`.input-row:has-text("${group.label}"), [role="group"]:has-text("${group.label}"), .form-field:has-text("${group.label}")`).first();
    if (!(await visible(row))) return false;

    if (group.format === 'pills') {
      const pillBtn = row.locator(`button.cx-select-pill-section:has-text("${option}")`).first();
      if (!(await visible(pillBtn))) return false;

      const isSelected = typeof pillBtn.evaluate === 'function' ? await pillBtn.evaluate(el =>
        el.classList?.contains('cx-select-pill-section--selected') ||
        el.classList?.contains('selected') ||
        el.getAttribute('aria-pressed') === 'true' ||
        Boolean(el.querySelector('.cx-select-pill__check-icon, .icon-close, .icon-check'))
      ).catch(() => false) : false;

      if (isSelected !== enable) {
        await pillBtn.click().catch(() => {});
        await humanPause({ min: 180, max: 350 });
      }
      return true;
    }

    // Native checkbox item
    const item = row.locator(`.input-row__control-item:has-text("${option}"), label.apply-flow-input-checkbox:has-text("${option}")`).first();
    const checkbox = item.locator('input[type="checkbox"]').first();
    let isChecked = false;
    if (await visible(checkbox)) {
      isChecked = await checkbox.isChecked().catch(() => false);
    } else {
      isChecked = typeof item.evaluate === 'function' ? await item.evaluate(el =>
        el.querySelector('input[type="checkbox"]')?.checked ||
        el.classList?.contains('apply-flow-input-checkbox--checked')
      ).catch(() => false) : false;
    }

    if (isChecked !== enable) {
      if (await visible(checkbox)) {
        await checkbox.click({ force: true }).catch(() => {});
      } else {
        await item.click().catch(() => {});
      }
      await humanPause({ min: 180, max: 350 });
    }
    return true;
  }

  async #scanDirectBranches(page, baseline = []) {
    const branches = [];

    // 1. Explore multi-checkbox / cx-select-pills groups
    const multiCheckboxGroups = (baseline ?? []).filter(f => f.type === 'multi-checkbox');
    for (const group of multiCheckboxGroups) {
      for (const option of group.options ?? []) {
        const before = await this.#extractControls(page);
        const beforeKeys = new Set(before.map(field => this.#fieldIdentity(field)));
        const beforeGroups = new Set(await this.#visibleRadioGroupLabels(page));

        // Toggle option ON
        const toggledOn = await this.#toggleMultiOption(page, group, option, true);
        if (!toggledOn) continue;
        await humanPause({ min: 300, max: 600 });

        const after = await this.#extractControls(page);
        const revealed = after.filter(field => !beforeKeys.has(this.#fieldIdentity(field)));
        const conditionPath = [{ triggerLabel: group.label, triggerValue: option, conditionType: 'includes' }];

        if (revealed.length) {
          const triggerSlug = this.#slug(group.label);
          for (const rf of revealed) {
            rf.isConditional = true;
            rf.triggerFieldId = triggerSlug;
            rf.triggerLabel = group.label;
            rf.triggerValue = option;
            rf.conditionType = 'includes';
            rf.visibleWhen = { field: triggerSlug, includes: option };
          }
          branches.push({
            triggerLabel: group.label,
            triggerValue: option,
            conditionType: 'includes',
            path: conditionPath,
            revealed
          });
          console.error(`[Phase 2] Discovered multi-checkbox branch: when "${group.label}" includes "${option}" -> reveals ${revealed.length} fields`);

          // Deep nested exploration: if any newly revealed control is a radio group, explore its options while holding the parent option active
          const newlyRevealedRadioGroups = (await this.#visibleRadioGroupLabels(page)).filter(label => !beforeGroups.has(label));
          for (const subRadioLabel of newlyRevealedRadioGroups) {
            const subGroup = page.getByRole('radiogroup', { name: subRadioLabel, exact: true }).first();
            if (!(await visible(subGroup))) continue;
            const subOptions = await this.#radioOptionLabels(subGroup);

            for (const subOption of subOptions) {
              const subBefore = await this.#extractControls(page);
              const subBeforeKeys = new Set(subBefore.map(f => this.#fieldIdentity(f)));

              await subGroup.getByRole('radio', { name: subOption, exact: true }).click().catch(async () => {
                await subGroup.locator(`button[role="radio"]:has-text("${subOption}"), button.cx-select-pill-section:has-text("${subOption}")`).first().click().catch(() => {});
              });
              await humanPause({ min: 250, max: 500 });

              const subAfter = await this.#extractControls(page);
              const subRevealed = subAfter.filter(f => !subBeforeKeys.has(this.#fieldIdentity(f)));
              if (subRevealed.length) {
                const subTriggerSlug = this.#slug(subRadioLabel);
                for (const srf of subRevealed) {
                  srf.isConditional = true;
                  srf.triggerFieldId = subTriggerSlug;
                  srf.triggerLabel = subRadioLabel;
                  srf.triggerValue = subOption;
                  srf.conditionType = 'equals';
                  srf.visibleWhen = { field: subTriggerSlug, equals: subOption };
                }
                const nestedPath = [
                  { triggerLabel: group.label, triggerValue: option, conditionType: 'includes' },
                  { triggerLabel: subRadioLabel, triggerValue: subOption }
                ];
                branches.push({
                  triggerLabel: subRadioLabel,
                  triggerValue: subOption,
                  path: nestedPath,
                  revealed: subRevealed
                });
                console.error(`[Phase 2] Discovered nested branch: when "${group.label}" includes "${option}" AND "${subRadioLabel}" = "${subOption}" -> reveals ${subRevealed.length} fields`);
              }
            }
          }
        }

        // Toggle option OFF to return to clean baseline
        await this.#toggleMultiOption(page, group, option, false);
        await humanPause({ min: 200, max: 400 });
      }
    }

    // 2. Explore radio group branches (standard single-select questions)
    const initialLabels = await this.#visibleRadioGroupLabels(page);
    const queue = initialLabels.map(label => ({ label, path: [] }));
    const queued = new Set(queue.map(item => item.label));
    const explored = new Set();
    let operations = 0;

    while (queue.length && operations < 80) {
      const item = queue.shift();
      await this.#activateRadioPath(page, item.path);
      const group = page.getByRole('radiogroup', { name: item.label, exact: true }).first();
      if (!(await visible(group))) continue;
      const optionLabels = await this.#radioOptionLabels(group);

      for (const targetLabel of optionLabels) {
        const explorationKey = `${JSON.stringify(item.path)}|${item.label}|${targetLabel}`;
        if (explored.has(explorationKey)) continue;
        explored.add(explorationKey);
        operations += 1;

        await this.#activateRadioPath(page, item.path);
        let currentGroup = page.getByRole('radiogroup', { name: item.label, exact: true }).first();
        if (!(await visible(currentGroup))) continue;
        const alternate = optionLabels.find(label => label !== targetLabel);
        if (alternate) {
          await currentGroup.getByRole('radio', { name: alternate, exact: true }).click();
          await humanPause({ min: 180, max: 350 });
          await this.#activateRadioPath(page, item.path);
          currentGroup = page.getByRole('radiogroup', { name: item.label, exact: true }).first();
        }

        const before = await this.#extractControls(page);
        const beforeKeys = new Set(before.map(field => this.#fieldIdentity(field)));
        const beforeGroups = new Set(await this.#visibleRadioGroupLabels(page));
        await currentGroup.getByRole('radio', { name: targetLabel, exact: true }).click();
        await humanPause({ min: 250, max: 600 });
        const after = await this.#extractControls(page);
        const revealed = after.filter(field => !beforeKeys.has(this.#fieldIdentity(field)));
        const conditionPath = [...item.path, { triggerLabel: item.label, triggerValue: targetLabel }];
        if (revealed.length) {
          const triggerSlug = this.#slug(item.label);
          for (const rf of revealed) {
            rf.isConditional = true;
            rf.triggerFieldId = triggerSlug;
            rf.triggerLabel = item.label;
            rf.triggerValue = targetLabel;
            rf.conditionType = 'equals';
            rf.visibleWhen = { field: triggerSlug, equals: targetLabel };
          }
          branches.push({ triggerLabel: item.label, triggerValue: targetLabel, path: conditionPath, revealed });
        }

        for (const newLabel of await this.#visibleRadioGroupLabels(page)) {
          if (beforeGroups.has(newLabel)) continue;
          const queueKey = `${JSON.stringify(conditionPath)}|${newLabel}`;
          if (!queued.has(queueKey)) {
            queued.add(queueKey);
            queue.push({ label: newLabel, path: conditionPath });
          }
        }
      }
    }
    return branches;
  }

  async #visibleRadioGroupLabels(page) {
    const hasSections = (await page.locator('.apply-flow-section').count().catch(() => 0)) > 0;
    const selector = hasSections
      ? '.apply-flow-section:not([style*="display: none"]) [role="radiogroup"]'
      : '[role="radiogroup"]';
    return page.locator(selector).evaluateAll(groups =>
      [...new Set(groups.map(group => group.getAttribute('aria-label') || '').filter(Boolean))]
    ).catch(() => []);
  }

  async #radioOptionLabels(group) {
    const options = group.getByRole('radio');
    const labels = [];
    for (let index = 0; index < Math.min(await options.count(), 12); index += 1) {
      const label = normalizeText(await options.nth(index).evaluate(element => {
        const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent ?? '').join(' ');
        const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : '';
        return element.innerText || element.getAttribute('aria-label') || labelledBy || explicit || element.value || '';
      }));
      if (label) labels.push(label);
    }
    return labels;
  }

  async #activateRadioPath(page, path) {
    for (const step of path) {
      const group = page.getByRole('radiogroup', { name: step.triggerLabel, exact: true }).first();
      if (!(await visible(group))) return false;
      await group.getByRole('radio', { name: step.triggerValue, exact: true }).click();
      await humanPause({ min: 140, max: 280 });
    }
    return true;
  }

  async #scanRepeatableGroups(page) {
    const knownDefinitions = [
      { id: 'experience', add: /^add experience$/i, cancel: /^cancel$/i },
      { id: 'education', add: /^add education$/i, cancel: /^cancel$/i },
      { id: 'supporting_links', add: /add another link/i, remove: /remove link/i }
    ];
    const groups = [];
    const seenGroupIds = new Set();

    // 1. Scan known standard repeatable sections
    for (const definition of knownDefinitions) {
      const add = page.getByRole('button', { name: definition.add }).first();
      if (!(await visible(add))) continue;
      const before = await this.#extractControls(page);
      const beforeKeys = new Set(before.map(field => this.#fieldIdentity(field)));
      await add.click();
      await humanPause({ min: 300, max: 700 });
      const after = await this.#extractControls(page);
      const fields = after.filter(field => !beforeKeys.has(this.#fieldIdentity(field)));
      const buttonText = normalizeText(await add.innerText().catch(() => ''));
      seenGroupIds.add(definition.id);
      groups.push({
        id: definition.id,
        label: definition.id.replaceAll('_', ' '),
        addButton: buttonText || `Add ${definition.id.replaceAll('_', ' ')}`,
        type: 'repeatable-group',
        fields,
        children: fields
      });
      const rollback = definition.cancel
        ? page.getByRole('button', { name: definition.cancel }).first()
        : page.getByRole('button', { name: definition.remove }).last();
      if (await visible(rollback)) await rollback.click();
      await humanPause({ min: 200, max: 500 });
    }

    // 2. Dynamically discover any additional + Add buttons (e.g. Certifications, Licenses, Skills, References, etc.)
    const addButtons = page.locator([
      'button:has-text("Add"):not(.apply-flow-pagination__button):visible',
      'button:has-text("+ Add"):visible',
      'button:has-text("+Add"):visible',
      'button[aria-label*="Add " i]:not(.apply-flow-pagination__button):visible',
      '.apply-flow-repeatable__add-button:visible'
    ].join(', '));

    const count = await addButtons.count();
    for (let i = 0; i < count; i += 1) {
      const btn = addButtons.nth(i);
      const rawText = normalizeText(await btn.innerText().catch(() => '') || await btn.getAttribute('aria-label') || '');
      if (!rawText || /^(next|cancel|continue|apply|back|close|submit)$/i.test(rawText)) continue;

      const groupId = this.#slug(rawText.replace(/^(\+?\s*add|\+)\s+/i, ''));
      if (!groupId || seenGroupIds.has(groupId)) continue;
      seenGroupIds.add(groupId);

      console.error(`[Phase 2] Discovered dynamic repeatable group: "${rawText}" (${groupId})`);
      const before = await this.#extractControls(page);
      const beforeKeys = new Set(before.map(field => this.#fieldIdentity(field)));
      await btn.click();
      await humanPause({ min: 300, max: 700 });
      const after = await this.#extractControls(page);
      const fields = after.filter(field => !beforeKeys.has(this.#fieldIdentity(field)));

      if (fields.length) {
        groups.push({
          id: groupId,
          label: groupId.replaceAll('_', ' '),
          addButton: rawText,
          type: 'repeatable-group',
          fields,
          children: fields
        });
      }

      const rollback = page.locator([
        'button:has-text("Cancel"):visible',
        'button:has-text("Remove"):visible',
        'button[aria-label*="remove" i]:visible',
        'button[aria-label*="delete" i]:visible'
      ].join(', ')).last();
      if (await visible(rollback)) await rollback.click();
      await humanPause({ min: 200, max: 500 });
    }

    return groups;
  }

  async #smoothScrollIntoView(page, locator) {
    try {
      await locator.evaluate(el => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }).catch(async () => {
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      });
      await humanPause({ min: 400, max: 700 });
    } catch {}
  }

  async #smoothScrollToBottom(page) {
    try {
      // 1. Dispatch smooth mouse wheel events to naturally scroll whatever container is active
      for (let i = 0; i < 6; i += 1) {
        await page.mouse.wheel(0, 350).catch(() => {});
        await delay(120);
      }

      // 2. Execute DOM scroll across document and all scrollable containers
      await page.evaluate(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        document.documentElement.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        for (const el of document.querySelectorAll('*')) {
          if (el.scrollHeight > el.clientHeight && el.clientHeight > 150) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }
        }
      }).catch(() => {});

      // 3. Specifically scroll the pagination buttons (Next / Submit) into view at the bottom
      const pagination = page.locator([
        '.apply-flow-pagination:visible',
        '.apply-flow-pagination__buttons:visible',
        'button.apply-flow-pagination__button:visible'
      ].join(', ')).last();

      if (await visible(pagination)) {
        await pagination.evaluate(el => {
          el.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
        }).catch(async () => {
          await pagination.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        });
      }

      await humanPause({ min: 500, max: 1000 });
    } catch {}
  }

  async fillApplication({ session, template, values, files = {}, context = {} }) {
    const { page } = session;
    const jobId = context.jobId ?? 'unknown';
    const userId = context.userId ?? 'unknown';

    await this.#ensureStandardApplyFlow(page);

    const results = [];
    const filledFieldIds = new Set();
    let pageNumber = 1;
    const maxPages = 10;

    console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Starting DOM-driven multi-page form fill across ${template.fields?.length ?? 0} fields...`);

    while (pageNumber <= maxPages) {
      console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Inspecting and filling fields on application page/step ${pageNumber}...`);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await humanPause(this.actionGap);

      // Multi-pass loop on current page to handle any dynamically revealed conditional questions
      let filledAnyOnPass = true;
      let pass = 0;

      while (filledAnyOnPass && pass < 4) {
        filledAnyOnPass = false;
        pass += 1;

        // 1. Live DOM scan of active controls on this step
        let liveControls = await this.#extractActivePageControls(page).catch(() => []);
        if (!liveControls.length && (template.fields?.length ?? 0) > 0) {
          liveControls = template.fields;
        }

        // 2. Discover visible repeatable section buttons (+ Add Experience, + Add Education)
        const visibleAddButtons = await this.#visibleAddButtons(page).catch(() => []);

        // 3. Process live controls top-to-bottom
        for (const liveControl of liveControls) {
          if (filledFieldIds.has(liveControl.id)) continue;

          // Multi-tier match against values
          const match = this.#matchLiveControlToValues(liveControl, values, template.fields);
          if (!match) continue;

          const { targetFieldId, targetField, answer } = match;
          if (answer === null || answer === undefined || answer === '') continue;
          if (filledFieldIds.has(targetFieldId)) continue;

          const effectiveField = { ...targetField, ...liveControl, id: targetFieldId };

          // Pre-check: is it already filled or locked/readonly?
          const liveState = await this.#inspectLiveControlState(page, effectiveField);
          if (liveState.matchesDesired(answer)) {
            console.error(`[Phase 4] [Job ${jobId} | User ${userId}] ✓ Already filled with desired value: "${effectiveField.label}"`);
            filledFieldIds.add(liveControl.id);
            filledFieldIds.add(targetFieldId);
            results.push({ fieldId: targetFieldId, status: 'verified', prefilled: true });
            continue;
          }

          if (liveState.isLocked) {
            console.error(`[Phase 4] [Job ${jobId} | User ${userId}] ℹ Pre-filled and locked by Oracle: "${effectiveField.label}" (current: "${liveState.currentValue}")`);
            filledFieldIds.add(liveControl.id);
            filledFieldIds.add(targetFieldId);
            results.push({ fieldId: targetFieldId, status: 'verified', locked: true, currentValue: liveState.currentValue });
            continue;
          }

          // Strict visibility check for the control on the active page
          let locator;
          if (effectiveField.type === 'repeatable-group') {
            locator = page.getByRole('button', { name: new RegExp(`^${effectiveField.addButton}$`, 'i') }).first();
          } else if (effectiveField.type === 'multi-checkbox') {
            locator = page.locator(`.input-row:has-text("${effectiveField.label}"), [role="group"]:has-text("${effectiveField.label}"), .form-field:has-text("${effectiveField.label}")`).first();
          } else if (effectiveField.type === 'radio') {
            locator = page.getByRole('radiogroup', { name: effectiveField.label }).first();
            if (!(await visible(locator))) {
              locator = page.locator(`.input-row[role="radiogroup"]:has-text("${effectiveField.label}"), [role="radiogroup"]:has-text("${effectiveField.label}"), .input-row:has-text("${effectiveField.label}") [role="radiogroup"]`).first();
            }
          } else if (effectiveField.sourceName) {
            locator = page.locator(`[name="${effectiveField.sourceName.replaceAll('"', '\\"')}"]:visible`).first();
          } else if (effectiveField.sourceId) {
            locator = page.locator(`[id="${effectiveField.sourceId.replaceAll('"', '\\"')}"]:visible`).first();
          } else {
            locator = page.getByLabel(effectiveField.label).first();
          }

          // Fallback if not matched with :visible selector
          if (!(await visible(locator))) {
            if (effectiveField.type === 'radio') {
              locator = page.getByRole('radiogroup', { name: effectiveField.label }).first();
            } else if (effectiveField.sourceId) {
              locator = page.locator(`[id="${effectiveField.sourceId.replaceAll('"', '\\"')}"]`).first();
            } else if (effectiveField.sourceName) {
              locator = page.locator(`[name="${effectiveField.sourceName.replaceAll('"', '\\"')}"]`).first();
            }
          }

          if (!(await visible(locator))) continue;

          let isActuallyVisible = await locator.isVisible().catch(() => false);
          if (!isActuallyVisible && effectiveField.type === 'radio') {
            const groupVisible = (await visible(locator)) && (await locator.isVisible().catch(() => false));
            isActuallyVisible = groupVisible;
            if (!isActuallyVisible) {
              const fallbackGroup = page.locator(`.input-row:has-text("${effectiveField.label}"), [role="radiogroup"]:has-text("${effectiveField.label}")`).first();
              isActuallyVisible = (await visible(fallbackGroup)) && (await fallbackGroup.isVisible().catch(() => false));
              if (isActuallyVisible) locator = fallbackGroup;
            }
          }
          if (!isActuallyVisible && effectiveField.type === 'multi-checkbox') {
            const rowVisible = (await visible(locator)) && (await locator.isVisible().catch(() => false));
            isActuallyVisible = rowVisible;
          }
          if (!isActuallyVisible && effectiveField.type === 'checkbox') {
            const customCheckbox = effectiveField.sourceId
              ? page.locator(`label[for="${effectiveField.sourceId}"]:visible, [id="${effectiveField.sourceId}"] + .apply-flow-input-checkbox__button:visible, label:has-text("${effectiveField.label}"):visible`).first()
              : page.locator(`label.apply-flow-input-checkbox:has-text("${effectiveField.label}"):visible, label:has-text("${effectiveField.label}"):visible, .input-row:has-text("${effectiveField.label}") .apply-flow-input-checkbox__button:visible`).first();
            isActuallyVisible = (await visible(customCheckbox)) && (await customCheckbox.isVisible().catch(() => false));
          }
          if (!isActuallyVisible && effectiveField.type === 'file') {
            const fileUploadArea = page.locator(`.file-upload-block:visible, .apply-flow-file-upload:visible, .apply-flow-block--file-upload:visible, .file-form-element:visible, [id="${effectiveField.sourceId}"]:visible`).first();
            isActuallyVisible = await visible(fileUploadArea);
          }

          if (!isActuallyVisible) continue;

          const fieldLabel = effectiveField.label || effectiveField.id;
          console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Applying: "${fieldLabel}"`);

          try {
            await humanPause(this.actionGap);
            if (effectiveField.type === 'repeatable-group') {
              await this.#fillRepeatableGroup(page, effectiveField, answer, context);
            } else {
              await this.#fillField(page, effectiveField, answer, files, context);
            }
            filledFieldIds.add(liveControl.id);
            filledFieldIds.add(targetFieldId);
            results.push({ fieldId: targetFieldId, status: 'verified' });
            filledAnyOnPass = true;
            console.error(`[Phase 4] [Job ${jobId} | User ${userId}] ✓ Applied successfully: "${fieldLabel}"`);
          } catch (error) {
            console.error(`[Phase 4] [Job ${jobId} | User ${userId}] ✗ Failed: "${fieldLabel}" (${error.message})`);
            results.push({ fieldId: targetFieldId, status: 'failed', error: error.message });
          }
          await humanPause(this.actionGap);
        }

        // 4. Process repeatable groups if matching add button is visible on page
        for (const addBtnInfo of visibleAddButtons) {
          const matchGroup = (template.repeatableGroups ?? []).find(g =>
            g.id === addBtnInfo.id || (g.addButton && g.addButton.toLowerCase() === addBtnInfo.text.toLowerCase())
          );
          if (!matchGroup || filledFieldIds.has(matchGroup.id)) continue;
          const answer = values[matchGroup.id]?.value;
          if (!answer || !Array.isArray(answer) || !answer.length) continue;

          console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Filling repeatable group "${matchGroup.label}" (${answer.length} entries)...`);
          try {
            await this.#fillRepeatableGroup(page, matchGroup, answer, context);
            filledFieldIds.add(matchGroup.id);
            results.push({ fieldId: matchGroup.id, status: 'verified' });
            filledAnyOnPass = true;
          } catch (error) {
            console.error(`[Phase 4] [Job ${jobId} | User ${userId}] ✗ Failed repeatable group "${matchGroup.label}": ${error.message}`);
            results.push({ fieldId: matchGroup.id, status: 'failed', error: error.message });
          }
        }
      }

      console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Scrolling to the end of page ${pageNumber}...`);
      await this.#smoothScrollToBottom(page);

      // Check if Submit is visible on this page
      const submitButton = page.getByRole('button', { name: SUBMIT_PATTERN }).first();
      const isSubmitVisible = (await visible(submitButton)) && (await submitButton.isVisible().catch(() => false));
      if (isSubmitVisible) {
        console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Submit button detected on page ${pageNumber}. Halting for operator review.`);
        await this.#smoothScrollIntoView(page, submitButton);
        break;
      }

      // Check if a safe Next button is available to advance
      const nextButton = this.#nextButtonLocator(page);
      if (!(await visible(nextButton))) {
        console.error(`[Phase 4] [Job ${jobId} | User ${userId}] No further Next button on page ${pageNumber}; fill completed. Halting for review.`);
        break;
      }

      const currentUrl = page.url();
      console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Clicking Next on page ${pageNumber}; advancing to page ${pageNumber + 1}...`);
      await this.#smoothScrollIntoView(page, nextButton);
      await humanPause(this.actionGap);
      await nextButton.click();
      await humanPause(this.postNextWait);
      await page.waitForLoadState('domcontentloaded').catch(() => {});

      if (page.url() === currentUrl && (await visible(submitButton)) && (await submitButton.isVisible().catch(() => false))) {
        console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Submit button reached. Halting for review.`);
        break;
      }
      pageNumber += 1;
    }

    const verifiedCount = results.filter(r => r.status === 'verified').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    console.error(`[Phase 4] [Job ${jobId} | User ${userId}] Fill completed: ${verifiedCount} verified, ${failedCount} failed. Halting for operator review.`);
    return results;
  }

  async #extractActivePageControls(page) {
    const hasSections = (await page.locator('.apply-flow-section').count().catch(() => 0)) > 0;
    const prefix = hasSections ? '.apply-flow-section:not([style*="display: none"]) ' : '';

    const { groups: multiCheckboxGroups, handledCheckboxIds } = await this.#extractCheckboxGroups(page);
    const handledSet = new Set(handledCheckboxIds);

    const candidates = page.locator([
      `${prefix}input:not([type="hidden"]):not([aria-hidden="true"]):visible`,
      `${prefix}textarea:not([aria-hidden="true"]):not(.input-row__control--helper):visible`,
      `${prefix}select:visible`,
      `${prefix}[role="combobox"]:visible`,
      `${prefix}[role="radiogroup"]:visible`,
      `${prefix}[role="checkbox"]:visible`,
      `${prefix}label:visible input[type="checkbox"]`,
      `${prefix}.input-row:visible input[type="checkbox"]`,
      `${prefix}.form-field:visible input[type="checkbox"]`,
      `${prefix}.apply-flow-block--file-upload input[type="file"]`,
      `${prefix}.file-form-element input[type="file"]`,
      `${prefix}input[type="file"][name="attachment-upload"]`,
      `${prefix}input[type="file"].apply-flow-profile-import-awli__file-upload`
    ].join(', '));

    const seen = new Set();
    const usedIds = new Set();
    const fields = [];

    for (const group of multiCheckboxGroups) {
      let id = this.#slug(group.label);
      if (usedIds.has(id)) id = `${id}_2`;
      usedIds.add(id);
      seen.add(group.label);
      fields.push({ id, ...group, value: null });
    }

    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const isCandidateVisible = await candidate.isVisible().catch(() => false);
      const isFile = await candidate.evaluate(el => el.type === 'file' || el.classList?.contains('upload-button')).catch(() => false);
      if (!isCandidateVisible && !isFile) continue;

      const field = await controlDescriptor(candidate);
      if (field.sourceId && handledSet.has(field.sourceId)) continue;
      const key = this.#fieldIdentity(field);
      if (!field.label || /import your profile from resume/i.test(field.label) || seen.has(key)) continue;
      seen.add(key);

      if (field.role === 'radiogroup' || (field.tag === 'div' && field.role === 'radiogroup')) {
        field.type = 'radio';
        field.options = await this.#radioOptionLabels(candidate);
      }

      let id = this.#fieldId(field, fields.length);
      if (usedIds.has(id)) id = `${id}_${this.#slug(field.label)}`;
      let suffix = 2;
      const baseId = id;
      while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
      usedIds.add(id);
      fields.push({ id, ...field, value: null });
    }

    return fields;
  }

  async #visibleAddButtons(page) {
    const hasSections = (await page.locator('.apply-flow-section').count().catch(() => 0)) > 0;
    const prefix = hasSections ? '.apply-flow-section:not([style*="display: none"]) ' : '';

    const addButtons = page.locator([
      `${prefix}button:has-text("Add"):not(.apply-flow-pagination__button):visible`,
      `${prefix}button:has-text("+ Add"):visible`,
      `${prefix}button:has-text("+Add"):visible`,
      `${prefix}button[aria-label*="Add " i]:not(.apply-flow-pagination__button):visible`,
      `${prefix}.apply-flow-repeatable__add-button:visible`,
      `${prefix}button.candidate-links__add-link:visible`
    ].join(', '));

    const count = await addButtons.count().catch(() => 0);
    const result = [];
    for (let i = 0; i < count; i += 1) {
      const btn = addButtons.nth(i);
      const rawText = normalizeText(await btn.innerText().catch(() => '') || await btn.getAttribute('aria-label') || '');
      if (!rawText || /^(next|cancel|continue|apply|back|close|submit)$/i.test(rawText)) continue;
      const groupId = this.#slug(rawText.replace(/^(\+?\s*add|\+)\s+/i, ''));
      result.push({ id: groupId, text: rawText, locator: btn });
    }
    return result;
  }

  #matchLiveControlToValues(liveControl, values, templateFields = []) {
    // 1. Direct match by computed slug ID
    if (values[liveControl.id]) {
      const targetField = (templateFields ?? []).find(f => f.id === liveControl.id) || liveControl;
      return { targetFieldId: liveControl.id, targetField, answer: values[liveControl.id]?.value };
    }

    // 2. Match by sourceId
    if (liveControl.sourceId) {
      for (const [key, val] of Object.entries(values)) {
        const tField = (templateFields ?? []).find(f => f.id === key);
        if (tField?.sourceId === liveControl.sourceId || key === liveControl.sourceId) {
          return { targetFieldId: key, targetField: tField || liveControl, answer: val?.value };
        }
      }
    }

    // 3. Match by sourceName
    if (liveControl.sourceName) {
      for (const [key, val] of Object.entries(values)) {
        const tField = (templateFields ?? []).find(f => f.id === key);
        if (tField?.sourceName === liveControl.sourceName || key === liveControl.sourceName) {
          return { targetFieldId: key, targetField: tField || liveControl, answer: val?.value };
        }
      }
    }

    // 4. Match by normalized label (+ section context)
    const normLiveLabel = normalizeText(liveControl.label).toLowerCase().replace(/\s*\*$/, '');
    if (normLiveLabel) {
      for (const [key, val] of Object.entries(values)) {
        const qLabel = normalizeText(val?.questionLabel || '').toLowerCase().replace(/\s*\*$/, '');
        if (qLabel && (qLabel === normLiveLabel || qLabel.includes(normLiveLabel) || normLiveLabel.includes(qLabel))) {
          const tField = (templateFields ?? []).find(f => f.id === key);
          return { targetFieldId: key, targetField: tField || liveControl, answer: val?.value };
        }
      }
    }

    return null;
  }

  async #inspectLiveControlState(page, field) {
    try {
      if (field.type === 'radio') {
        let group = page.getByRole('radiogroup', { name: field.label }).first();
        if (!(await visible(group))) {
          group = page.locator(`.input-row[role="radiogroup"]:has-text("${field.label}"), [role="radiogroup"]:has-text("${field.label}"), .input-row:has-text("${field.label}") [role="radiogroup"]`).first();
        }
        if (await visible(group)) {
          const checkedRadio = group.locator('input[type="radio"]:checked, [role="radio"][aria-checked="true"], .cx-select-pill-section--selected').first();
          if ((await checkedRadio.count().catch(() => 0)) > 0) {
            const checkedId = await checkedRadio.getAttribute('id').catch(() => null);
            let checkedText = '';
            if (checkedId) {
              checkedText = await page.locator(`label[for="${checkedId}"]`).innerText().catch(() => '');
            }
            if (!checkedText) {
              checkedText = await checkedRadio.innerText().catch(() => '');
            }
            const normChecked = normalizeText(checkedText).toLowerCase();
            return {
              currentValue: checkedText,
              isLocked: false,
              matchesDesired: (desired) => {
                const normDesired = normalizeText(String(desired)).toLowerCase();
                return Boolean(normChecked && normDesired && (normChecked === normDesired || normChecked.includes(normDesired) || normDesired.includes(normChecked)));
              }
            };
          }
        }
        return { matchesDesired: () => false, isLocked: false };
      }

      if (field.type === 'checkbox') {
        const locator = field.sourceId ? page.locator(`[id="${field.sourceId}"]`).first() : page.locator(`label:has-text("${field.label}") input[type="checkbox"]`).first();
        if (await visible(locator)) {
          const isChecked = await locator.isChecked().catch(() => false);
          return {
            currentValue: isChecked,
            isLocked: false,
            matchesDesired: (desired) => Boolean(desired) === isChecked
          };
        }
        return { matchesDesired: () => false, isLocked: false };
      }

      if (field.type === 'multi-checkbox') {
        return { matchesDesired: () => false, isLocked: false };
      }

      // Input / Text / Email / Tel / Combobox
      let locator;
      if (field.sourceName) {
        locator = page.locator(`[name="${field.sourceName}"]`).first();
      } else if (field.sourceId) {
        locator = page.locator(`[id="${field.sourceId}"]`).first();
      } else {
        locator = page.getByLabel(field.label).first();
      }

      if (await visible(locator)) {
        const val = await locator.inputValue().catch(async () => {
          return await locator.innerText().catch(() => '');
        });
        const isLocked = await locator.evaluate(el => {
          return Boolean(
            el.readOnly ||
            el.disabled ||
            el.getAttribute('readonly') !== null ||
            el.classList?.contains('communication-channel__email-row--locked') ||
            el.closest('.communication-channel__email-row--locked')
          );
        }).catch(() => false);

        return {
          currentValue: val,
          isLocked,
          matchesDesired: (desired) => {
            if (!val) return false;
            return normalizeText(String(val)).toLowerCase() === normalizeText(String(desired)).toLowerCase();
          }
        };
      }
    } catch {}
    return { matchesDesired: () => false, isLocked: false };
  }

  async #fillField(page, field, answer, files, context = {}) {
    if (field.type === 'file') {
      const file = files[field.id] ?? answer;
      invariant(file, 'MISSING_FILE', `No file supplied for ${field.label}`);
      const locator = page.locator([
        '.apply-flow-block--file-upload input[type="file"]',
        '.file-form-element input[type="file"]',
        '.file-upload-block input[type="file"]',
        'input[type="file"][name="attachment-upload"]',
        field.sourceId ? `[id="${field.sourceId.replaceAll('"', '\\"')}"]` : null
      ].filter(Boolean).join(', ')).first();
      await locator.setInputFiles(file);
      await humanPause(this.actionGap);
      return;
    }
    if (field.type === 'radio') {
      let group = page.getByRole('radiogroup', { name: field.label }).first();
      if (!(await visible(group))) {
        group = page.locator(`.input-row[role="radiogroup"]:has-text("${field.label}"), [role="radiogroup"]:has-text("${field.label}"), .input-row:has-text("${field.label}") [role="radiogroup"]`).first();
      }
      await this.#smoothScrollIntoView(page, group);

      let availableOptions = field.options ?? [];
      if (!availableOptions.length && (await visible(group))) {
        const optionEls = group.locator('label, button[role="radio"], .cx-select-pill-section');
        if (typeof optionEls.evaluateAll === 'function') {
          availableOptions = await optionEls.evaluateAll(elements =>
            elements.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
          ).catch(() => []);
        }
      }

      const targetValue = coerceToRadio(answer, availableOptions);
      const optionRadio = group.getByRole('radio', { name: targetValue, exact: true });
      const optionId = await optionRadio.getAttribute('id').catch(() => null);
      if (optionId) {
        const optionLabel = page.locator(`label[for="${optionId}"]:visible, .apply-flow-input-radio[for="${optionId}"]:visible`).first();
        if (await visible(optionLabel)) {
          await optionLabel.click();
        } else {
          await optionRadio.click({ force: true }).catch(() => {});
        }
      } else {
        const optionLabel = group.locator(`label:has-text("${targetValue}"):visible, .apply-flow-input-radio:has-text("${targetValue}"):visible`).first();
        if (await visible(optionLabel)) {
          await optionLabel.click();
        } else if (await visible(optionRadio)) {
          await optionRadio.click({ force: true }).catch(() => {});
        } else {
          const pillRadio = group.locator(`button[role="radio"]:has-text("${targetValue}"), button.cx-select-pill-section:has-text("${targetValue}")`).first();
          if (await visible(pillRadio)) {
            await pillRadio.click().catch(() => {});
          } else {
            await optionRadio.click({ force: true }).catch(() => {});
          }
        }
      }
      await humanPause(this.actionGap);
      return;
    }
    if (field.type === 'multi-checkbox') {
      const desired = coerceToMultiSelect(answer, field.options);
      const row = page.locator(`.input-row:has-text("${field.label}"), [role="group"]:has-text("${field.label}"), .form-field:has-text("${field.label}")`).first();
      await this.#smoothScrollIntoView(page, row);

      // Check if this multi-checkbox group uses Oracle cx-select-pills
      const isPills = (await row.locator('.cx-select-pills-container:visible, button.cx-select-pill-section:visible').count().catch(() => 0)) > 0;
      if (isPills) {
        for (const option of field.options ?? []) {
          const pillBtn = row.locator(`button.cx-select-pill-section:has-text("${option}")`).first();
          if (!(await visible(pillBtn))) continue;

          const isSelected = typeof pillBtn.evaluate === 'function' ? await pillBtn.evaluate(el =>
            el.classList?.contains('cx-select-pill-section--selected') ||
            el.classList?.contains('selected') ||
            el.getAttribute('aria-pressed') === 'true' ||
            Boolean(el.querySelector('.cx-select-pill__check-icon, .icon-close, .icon-check'))
          ).catch(() => false) : false;

          const shouldBeSelected = desired.some(d => String(d).trim().toLowerCase() === option.trim().toLowerCase());
          if (isSelected !== shouldBeSelected) {
            await pillBtn.click().catch(() => {});
            await humanPause({ min: 150, max: 300 });
          }
        }
        await humanPause(this.actionGap);
        return;
      }

      for (const option of field.options ?? []) {
        const item = row.locator(`.input-row__control-item:has-text("${option}"), label.apply-flow-input-checkbox:has-text("${option}")`).first();
        const checkbox = item.locator('input[type="checkbox"]').first();
        const isChecked = await checkbox.isChecked().catch(() => false);
        const shouldBeChecked = desired.some(d => String(d).trim().toLowerCase() === option.trim().toLowerCase());

        if (isChecked !== shouldBeChecked) {
          const customBtn = item.locator('.apply-flow-input-checkbox__button:visible, label.apply-flow-input-checkbox:visible').first();
          if (await visible(customBtn)) {
            await customBtn.click();
          } else {
            await checkbox.click({ force: true }).catch(async () => {
              await item.click({ force: true }).catch(() => {});
            });
          }
          await humanPause({ min: 150, max: 300 });
        }
      }
      await humanPause(this.actionGap);
      return;
    }
    if (field.type === 'checkbox') {
      const desired = coerceToBoolean(answer);
      const checkbox = field.sourceId
        ? page.locator(`[id="${field.sourceId.replaceAll('"', '\\"')}"]`).first()
        : page.locator(`label:has-text("${field.label}") input[type="checkbox"], .input-row:has-text("${field.label}") input[type="checkbox"]`).first();
      await this.#smoothScrollIntoView(page, checkbox);
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (desired !== isChecked) {
        const customButton = field.sourceId
          ? page.locator(`label[for="${field.sourceId}"] .apply-flow-input-checkbox__button:visible, label[for="${field.sourceId}"]:visible, label:has-text("${field.label}") .apply-flow-input-checkbox__button:visible`).first()
          : page.locator(`label.apply-flow-input-checkbox:has-text("${field.label}") .apply-flow-input-checkbox__button:visible, label.apply-flow-input-checkbox:has-text("${field.label}"):visible, .input-row:has-text("${field.label}") .apply-flow-input-checkbox__button:visible, label:has-text("${field.label}"):visible`).first();
        if (await visible(customButton)) {
          await customButton.click();
        } else {
          await checkbox.click({ force: true }).catch(async () => {
            await page.getByText(field.label).first().click().catch(() => {});
          });
        }
      }
      await humanPause(this.actionGap);
      return;
    }
    let locator;
    if (field.id === 'phone_number' || field.type === 'tel' || field.isPhoneNumber) {
      const phoneInput = page.locator('input.phone-row__input:visible, input[type="tel"]:visible, .phone-row__number input:visible').first();
      if (await visible(phoneInput)) {
        locator = phoneInput;
      }
    } else if (field.id === 'phone_country_code' || field.isPhonePrefix) {
      const prefixInput = page.locator('.phone-row__prefix [role="combobox"]:visible, .phone-row__prefix input:visible').first();
      if (await visible(prefixInput)) {
        locator = prefixInput;
      }
    }

    if (!locator) {
      locator = field.sourceName
        ? page.locator(`[name="${field.sourceName.replaceAll('"', '\\"')}"]`).first()
        : field.sourceId
          ? page.locator(`#${field.sourceId.replaceAll(':', '\\:')}`).first()
          : page.getByLabel(field.label).first();
    }

    await this.#smoothScrollIntoView(page, locator);

    const liveRole = typeof locator.getAttribute === 'function' ? await locator.getAttribute('role').catch(() => null) : null;
    const isLiveCombobox = field.type === 'combobox' || liveRole === 'combobox' ||
      (typeof locator.evaluate === 'function' ? await locator.evaluate(el => el.classList?.contains('cx-select-input') || el.closest('.cx-select-container') !== null || el.getAttribute('aria-haspopup') === 'grid').catch(() => false) : false);

    const effectiveAnswer = coerceToString(answer, field.options);

    if (isLiveCombobox) {
      await this.#fillCombobox(page, locator, field, effectiveAnswer, context);
      return;
    }

    const isLocked = await locator.evaluate(el => {
      return Boolean(
        el.readOnly ||
        el.disabled ||
        el.getAttribute('readonly') !== null ||
        el.classList?.contains('communication-channel__email-row--locked') ||
        el.closest('.communication-channel__email-row--locked')
      );
    }).catch(() => false);

    if (isLocked) {
      console.error(`[Phase 4] [Job ${context.jobId} | User ${context.userId}] ℹ Field "${field.label}" is locked/readonly. Retaining pre-filled value.`);
      return;
    }

    await humanType(locator, effectiveAnswer, this.humanDelay);
    await humanPause(this.actionGap);
    const actualVal = await locator.inputValue();
    if (field.type === 'tel' || field.id === 'phone_number') {
      const actualDigits = actualVal.replace(/\D/g, '');
      const expectedDigits = String(effectiveAnswer).replace(/\D/g, '');
      invariant(
        Boolean(actualDigits && expectedDigits && (actualDigits.endsWith(expectedDigits) || expectedDigits.endsWith(actualDigits))),
        'FIELD_VERIFICATION_FAILED',
        `Value did not persist for ${field.label} (expected digits "${expectedDigits}", got "${actualDigits}")`
      );
    } else {
      invariant(actualVal === String(effectiveAnswer), 'FIELD_VERIFICATION_FAILED', `Value did not persist for ${field.label}`);
    }
  }

  async #fillCombobox(page, locator, field, answer, context = {}) {
    // 1. Phone country code: type dial code + Enter directly and return without dropdown selection
    if (field.id === 'phone_country_code' || field.isPhonePrefix || /country.*code/i.test(field.label)) {
      await locator.fill('').catch(() => {});
      await humanType(locator, answer, this.humanDelay);
      await locator.press('Enter').catch(() => {});
      console.error(`[Phase 4] [Job ${context.jobId ?? ''} | User ${context.userId ?? ''}] ✓ Phone country code entered: "${answer}"`);
      await humanPause(this.actionGap);
      return;
    }

    const listboxId = await locator.getAttribute('aria-controls').catch(() => null);

    // 2. Focus and type answer with human speed
    await locator.fill('').catch(() => {});
    await humanType(locator, answer, this.humanDelay);

    // 3. Wait up to 3 seconds for dropdown list to appear
    const getDropdown = () => {
      if (listboxId) {
        return page.locator(`[id="${listboxId}"]:visible`);
      }
      return page.locator('.cx-select-dropdown--open:visible, .cx-select-dropdown:visible, [role="grid"]:visible, [role="listbox"]:visible');
    };

    const getOptionContainers = (dropdown) => {
      return dropdown.locator([
        '.cx-select__list-item-container:visible',
        '[id$="-listitem-0"]:visible',
        '.cx-select__list-item:visible',
        '[role="gridcell"]:visible',
        '[role="option"]:visible'
      ].join(', ')).filter({ hasText: /\S+/ });
    };

    let dropdown = getDropdown();
    let options = getOptionContainers(dropdown);

    let hasOptions = false;
    for (let i = 0; i < 6; i++) {
      if (await options.count().catch(() => 0) > 0 && await visible(options.first())) {
        hasOptions = true;
        break;
      }
      await delay(500);
      dropdown = getDropdown();
      options = getOptionContainers(dropdown);
    }

    if (!hasOptions) {
      console.error(`[Phase 4] [Job ${context.jobId ?? ''} | User ${context.userId ?? ''}] ⚠ Combobox "${field.label}": no options found for "${answer}" after 3s. Clearing for manual review.`);
      await locator.fill('').catch(() => {});
      await locator.press('Escape').catch(() => {});
      await humanPause(this.actionGap);
      return;
    }

    // 4. Keyboard-only commit: wait for dropdown to settle, ArrowDown to highlight, Enter to select
    await delay(3000);
    await locator.press('ArrowDown').catch(() => {});
    await delay(2000);
    await locator.press('Enter').catch(() => {});
    await delay(1000);

    // 5. Verify commit: check aria-expanded closed AND value persisted
    const ariaExpanded = await locator.getAttribute('aria-expanded').catch(() => 'false');
    const currentValue = await locator.inputValue().catch(() => '');
    const isInvalid = await locator.getAttribute('aria-invalid').catch(() => 'false') === 'true';

    // If dropdown is still open, try one more Enter
    if (ariaExpanded === 'true') {
      await locator.press('Enter').catch(() => {});
      await delay(300);
    }

    const finalValue = await locator.inputValue().catch(() => '');
    const finalExpanded = await locator.getAttribute('aria-expanded').catch(() => 'false');

    if (!finalValue || isInvalid || finalExpanded === 'true') {
      console.error(`[Phase 4] [Job ${context.jobId ?? ''} | User ${context.userId ?? ''}] ⚠ Combobox "${field.label}" was not committed (expanded=${finalExpanded}, value="${finalValue}"). Clearing for manual review.`);
      await locator.fill('').catch(() => {});
      await locator.press('Escape').catch(() => {});
    } else {
      console.error(`[Phase 4] [Job ${context.jobId ?? ''} | User ${context.userId ?? ''}] ✓ Combobox "${field.label}" committed: "${finalValue}"`);
    }

    await humanPause(this.actionGap);
  }

  async _fillFieldForTest(page, field, answer, files = {}, context = {}) {
    return this.#fillField(page, field, answer, files, context);
  }

  async _extractCheckboxGroupsForTest(page) {
    return this.#extractCheckboxGroups(page);
  }

  async _scanDirectBranchesForTest(page, baseline) {
    return this.#scanDirectBranches(page, baseline);
  }

  async _toggleMultiOptionForTest(page, group, option, enable) {
    return this.#toggleMultiOption(page, group, option, enable);
  }

  async _fillRepeatableGroupForTest(page, group, rows, context = {}) {
    return this.#fillRepeatableGroup(page, group, rows, context);
  }

  async #fillRepeatableGroup(page, group, rows, context = {}) {
    invariant(Array.isArray(rows), 'INVALID_REPEATABLE_VALUE', `${group.label} must be an array`);
    const isInlineLink = /link/i.test(group.id) || /link/i.test(group.label);

    for (const row of rows) {
      // 1. Click initial + Add button
      const addBtn = page.getByRole('button', { name: new RegExp(`^${group.addButton}$`, 'i') }).first();
      await this.#smoothScrollIntoView(page, addBtn);
      await addBtn.click();
      await humanPause({ min: 500, max: 1000 });

      // 2. Fill all inner fields
      let filledAny = false;
      for (const child of group.children ?? []) {
        const answer = row[child.id];
        if (answer === null || answer === undefined || answer === '') continue;
        await this.#fillField(page, child, answer, {}, context);
        filledAny = true;
      }

      // 3. For drawer/modal sections (Education, Experience, License):
      if (!isInlineLink) {
        if (!filledAny) {
          // Empty row: cancel out of drawer
          const cancelBtn = page.locator('button:has-text("Cancel"):visible').first();
          if (await visible(cancelBtn)) await cancelBtn.click().catch(() => {});
          continue;
        }

        const sectionName = (group.label || group.id).replace(/^add\s+/i, '').trim();
        const saveBtn = page.locator([
          `button:has-text("Add ${sectionName}"):visible`,
          `button:has-text("Save"):visible`,
          `button:has-text("Done"):visible`
        ].join(', ')).first();

        if (await visible(saveBtn)) {
          await this.#smoothScrollIntoView(page, saveBtn);
          await saveBtn.click();
          await humanPause({ min: 1000, max: 2000 });
          console.error(`[Phase 4] [Job ${context.jobId ?? ''} | User ${context.userId ?? ''}] ✓ Saved ${sectionName} record`);
        } else {
          console.error(`[Phase 4] [Job ${context.jobId ?? ''} | User ${context.userId ?? ''}] ⚠ Save button for ${sectionName} not found, checking Cancel fallback...`);
          const cancelBtn = page.locator('button:has-text("Cancel"):visible').first();
          if (await visible(cancelBtn)) await cancelBtn.click().catch(() => {});
        }
      }

      await humanPause(this.actionGap);
    }
  }

  async clickSubmit({ session }) {
    const button = session.page.getByRole('button', { name: SUBMIT_PATTERN }).first();
    await button.click();
    await session.page.waitForLoadState('networkidle').catch(() => { });
    return { url: session.page.url(), submittedAt: new Date().toISOString() };
  }
}

export class SessionRegistry {
  #sessions = new Map();

  set(applicationId, session) {
    this.#sessions.set(applicationId, session);
  }

  get(applicationId) {
    return this.#sessions.get(applicationId);
  }

  delete(applicationId) {
    this.#sessions.delete(applicationId);
  }
}
