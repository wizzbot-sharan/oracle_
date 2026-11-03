import { chromium } from 'playwright';

const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const applyBtn = page.getByRole('button', { name: /apply now/i }).first();
await applyBtn.click();
await page.waitForTimeout(4000);

const checkboxInfo = await page.evaluate(() => {
  const cb = document.getElementById('legal-disclaimer-checkbox');
  if (!cb) return { error: 'not found' };
  const style = window.getComputedStyle(cb);
  const parent = cb.parentElement;
  const label = document.querySelector('label[for="legal-disclaimer-checkbox"]') || cb.closest('label');
  const rect = cb.getBoundingClientRect();
  return {
    id: cb.id,
    type: cb.type,
    checked: cb.checked,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    position: style.position,
    width: rect.width,
    height: rect.height,
    hasLabel: !!label,
    labelHtml: label ? label.outerHTML.slice(0, 300) : null,
    parentHtml: parent ? parent.outerHTML.slice(0, 300) : null
  };
});

console.log('Checkbox detailed info:', JSON.stringify(checkboxInfo, null, 2));

// Test Playwright's locator for visible
const loc = page.locator('#legal-disclaimer-checkbox:visible');
console.log('locator("#legal-disclaimer-checkbox:visible").count():', await loc.count());
console.log('locator("#legal-disclaimer-checkbox").isVisible():', await page.locator('#legal-disclaimer-checkbox').isVisible());

// Test checking it
console.log('Trying page.locator("#legal-disclaimer-checkbox").check()...');
try {
  await page.locator('#legal-disclaimer-checkbox').check();
  console.log('Checked directly! isChecked:', await page.locator('#legal-disclaimer-checkbox').isChecked());
} catch (e) {
  console.log('Direct check failed:', e.message);
}

// Test clicking label
const labelLoc = page.locator('label[for="legal-disclaimer-checkbox"], label:has(#legal-disclaimer-checkbox), .agreements-label');
console.log('Label loc count:', await labelLoc.count());
if (await labelLoc.count() > 0) {
  console.log('Label loc text:', await labelLoc.first().textContent());
}

await browser.close();
