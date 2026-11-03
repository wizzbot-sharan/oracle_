import { chromium } from 'playwright';

const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const applyBtn = page.getByRole('button', { name: /apply now/i }).first();
await applyBtn.click();
await page.waitForTimeout(3000);

const html = await page.evaluate(() => {
  const container = document.querySelector('.legal-disclaimer-container') || document.getElementById('legal-disclaimer-checkbox')?.parentElement;
  return container ? container.outerHTML : 'none';
});

console.log('Container full HTML:\n', html);

// Try checking via page.evaluate
await page.evaluate(() => {
  const cb = document.getElementById('legal-disclaimer-checkbox');
  if (cb) {
    cb.click();
  }
});
console.log('After cb.click() in evaluate, isChecked:', await page.evaluate(() => document.getElementById('legal-disclaimer-checkbox')?.checked));

// Also test what Knockout / Oracle JET events it expects
await browser.close();
