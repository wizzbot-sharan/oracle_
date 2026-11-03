import { chromium } from 'playwright';

const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const applyBtn = page.getByRole('button', { name: /apply now/i }).first();
await applyBtn.click();
await page.waitForTimeout(3000);

// Check if dialog is visible initially
const dialogBefore = await page.locator('oj-dialog, agreement-dialog, .standard-apply-flow-agreement__dialog').isVisible().catch(() => false);
console.log('Is agreement dialog visible BEFORE click?:', dialogBefore);

// Click specifically the checkbox button
const squareBox = page.locator('label[for="legal-disclaimer-checkbox"] .apply-flow-input-checkbox__button').first();
console.log('Square box visible:', await squareBox.isVisible());
await squareBox.click();
await page.waitForTimeout(1000);

// Check if dialog opened
const dialogAfter = await page.locator('oj-dialog, agreement-dialog, .standard-apply-flow-agreement__dialog').isVisible().catch(() => false);
console.log('Is agreement dialog visible AFTER click?:', dialogAfter);

// Check state of the checkbox
const isChecked = await page.evaluate(() => document.getElementById('legal-disclaimer-checkbox')?.checked);
console.log('Is #legal-disclaimer-checkbox checked?:', isChecked);

// Check if any other input got checked or modified
const allCheckedInputs = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('input:checked')).map(el => ({ id: el.id, name: el.name, type: el.type }));
});
console.log('All checked inputs on page now:', allCheckedInputs);

await browser.close();
