import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594';
const outDir = path.resolve('recon/login-variants');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

try {
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const applyBtn = page.getByRole('button', { name: /apply now/i }).first();
  await applyBtn.click();
  await page.waitForTimeout(4000);

  // Find the switch method button
  const switchBtn = page.locator('.quick-apply-flow-verify-method__button, button:has-text("phone instead")');
  console.log('Switch button found count:', await switchBtn.count());
  const switchText = await switchBtn.textContent();
  console.log('Switch button text:', switchText.trim());

  console.log('Clicking switch to phone button...');
  await switchBtn.click();
  await page.waitForTimeout(3000);

  const screenshotPath = path.join(outDir, 'phone-screen.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Saved phone screen screenshot to:', screenshotPath);

  // Now inspect the phone view
  const phoneScreenData = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, select, textarea, [role="textbox"], [role="combobox"]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: el.getAttribute('name'),
      id: el.id,
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      value: el.value,
      required: el.required || el.getAttribute('aria-required') === 'true',
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      parentText: (el.parentElement?.textContent || '').trim().slice(0, 100).replace(/\s+/g, ' ')
    }));

    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: (el.textContent || '').trim().replace(/\s+/g, ' '),
      ariaLabel: el.getAttribute('aria-label'),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      class: el.className
    })).filter(b => b.visible && b.text.length < 100);

    return { inputs, buttons, currentUrl: window.location.href };
  });

  console.log('Phone screen URL:', phoneScreenData.currentUrl);
  console.log('Inputs in phone view:', JSON.stringify(phoneScreenData.inputs, null, 2));
  console.log('Buttons in phone view:', JSON.stringify(phoneScreenData.buttons, null, 2));

  // Now test switching BACK to email from phone view!
  const switchBackBtn = page.locator('.quick-apply-flow-verify-method__button, button:has-text("email instead"), button:has-text("email")');
  console.log('Switch back button found count:', await switchBackBtn.count());
  const switchBackText = await switchBackBtn.textContent();
  console.log('Switch back button text:', switchBackText.trim());

  await switchBackBtn.click();
  await page.waitForTimeout(2000);

  const emailScreenPath = path.join(outDir, 'switched-back-to-email.png');
  await page.screenshot({ path: emailScreenPath, fullPage: true });
  console.log('Switched back to email, screenshot saved.');

} catch (err) {
  console.error('Error during phone screen inspection:', err);
} finally {
  await browser.close();
}
