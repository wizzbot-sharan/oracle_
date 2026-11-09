import test from 'node:test';
import assert from 'node:assert/strict';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('OracleRecruitingAdapter.detectCaptcha identifies visible CAPTCHA indicators', async () => {
  const adapter = new OracleRecruitingAdapter({});

  const mockPageWithCaptcha = {
    locator: (selector) => {
      const loc = {
        count: async () => (selector.includes('arkose') || selector.includes('recaptcha')) ? 1 : 0,
        nth: () => loc,
        isVisible: async () => true
      };
      return loc;
    }
  };

  const detected = await adapter.detectCaptcha(mockPageWithCaptcha);
  assert.equal(detected, true, 'Should detect active CAPTCHA');

  const mockPageClean = {
    locator: () => ({
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
      isVisible: async () => false
    })
  };

  const detectedClean = await adapter.detectCaptcha(mockPageClean);
  assert.equal(detectedClean, false, 'Should return false when no CAPTCHA is present');
});

test('OracleRecruitingAdapter.createSession initializes stealth profile and closes gracefully', async () => {
  const adapter = new OracleRecruitingAdapter({
    headless: true,
    browserChannel: 'chrome' // Will use chrome if available, or fall back to bundled chromium
  });

  const session = await adapter.createSession({ applicationId: 'test-stealth' });
  assert.ok(session.browser, 'Browser instance must be created');
  assert.ok(session.context, 'BrowserContext must be created');
  assert.ok(session.page, 'Page must be created');

  // Verify anti-automation properties on live page
  const webdriverVal = await session.page.evaluate(() => navigator.webdriver);
  // With stealth plugin, navigator.webdriver is undefined or false
  assert.ok(!webdriverVal, 'navigator.webdriver should be false or undefined under stealth');

  const userAgent = await session.page.evaluate(() => navigator.userAgent);
  assert.ok(userAgent.includes('Chrome/'), 'User-Agent should report desktop Chrome');

  await adapter.closeSession(session);
});
