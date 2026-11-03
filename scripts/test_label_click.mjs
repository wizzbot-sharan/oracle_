import { chromium } from 'playwright';

const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const applyBtn = page.getByRole('button', { name: /apply now/i }).first();
await applyBtn.click();
await page.waitForTimeout(3000);

console.log('Testing label click...');
const label = page.locator('label[for="legal-disclaimer-checkbox"], .legal-disclaimer-container').first();
console.log('Label visible:', await label.isVisible());
await label.click();

const isChecked = await page.evaluate(() => {
  return document.getElementById('legal-disclaimer-checkbox')?.checked;
});
console.log('Is checkbox checked after clicking label?:', isChecked);

await browser.close();
