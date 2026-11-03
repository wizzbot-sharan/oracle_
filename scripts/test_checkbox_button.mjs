import { chromium } from 'playwright';

const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const applyBtn = page.getByRole('button', { name: /apply now/i }).first();
await applyBtn.click();
await page.waitForTimeout(3000);

console.log('Testing click on .apply-flow-input-checkbox__button...');
const checkboxButton = page.locator('.apply-flow-input-checkbox__button').first();
console.log('Checkbox button is visible:', await checkboxButton.isVisible());
await checkboxButton.click();

let isChecked = await page.evaluate(() => document.getElementById('legal-disclaimer-checkbox')?.checked);
console.log('Is checked after clicking .apply-flow-input-checkbox__button?:', isChecked);

const hasCheckedClass = await page.evaluate(() => {
  return document.querySelector('.apply-flow-input-checkbox__button')?.classList.contains('apply-flow-input-checkbox__button--checked');
});
console.log('Has checked class?:', hasCheckedClass);

await browser.close();
