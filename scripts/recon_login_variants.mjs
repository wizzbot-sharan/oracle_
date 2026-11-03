import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const urls = [
  'https://eohh.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/428288',
  'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012594',
  'https://ibcjqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/2624'
];

const outDir = path.resolve('recon/login-variants');
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  const tag = `url_${i + 1}`;
  console.log(`\n==============================================`);
  console.log(`Inspecting [${tag}]: ${url}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Capture initial job page title / buttons
    const applyButtons = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      return elements
        .filter(el => /apply/i.test(el.textContent || el.getAttribute('aria-label') || ''))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          text: (el.textContent || '').trim().replace(/\s+/g, ' '),
          ariaLabel: el.getAttribute('aria-label'),
          class: el.className,
          id: el.id
        }));
    });
    console.log(`Discovered Apply triggers on initial page:`, JSON.stringify(applyButtons, null, 2));

    // Click Apply
    const applyBtn = page.getByRole('button', { name: /apply now|apply/i }).first();
    if (await applyBtn.isVisible().catch(() => false)) {
      console.log('Clicking Apply button...');
      await applyBtn.click();
    } else {
      console.log('Looking for Apply link or general role button...');
      const fallback = page.locator('button:has-text("Apply"), a:has-text("Apply")').first();
      await fallback.click();
    }

    await page.waitForTimeout(4000);

    // Save screenshot of the auth screen
    const screenshotPath = path.join(outDir, `${tag}-auth-screen.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Saved screenshot to ${screenshotPath}`);

    // Inspect interactive controls on this auth screen
    const authControls = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, textarea, [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"]')).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        name: el.getAttribute('name'),
        id: el.id,
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        value: el.value,
        checked: el.checked,
        required: el.required || el.getAttribute('aria-required') === 'true',
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        parentText: (el.parentElement?.textContent || '').trim().slice(0, 100).replace(/\s+/g, ' ')
      }));

      const actionButtons = Array.from(document.querySelectorAll('button, a, [role="button"]')).map(el => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        text: (el.textContent || '').trim().replace(/\s+/g, ' '),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        id: el.id,
        class: el.className
      })).filter(b => b.visible && b.text.length < 100);

      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend, [role="heading"]')).map(h => ({
        tag: h.tagName.toLowerCase(),
        text: (h.textContent || '').trim().replace(/\s+/g, ' ')
      })).filter(h => h.text.length > 0 && h.text.length < 120);

      return { headings, inputs, actionButtons, currentUrl: window.location.href };
    });

    console.log(`Auth screen URL: ${authControls.currentUrl}`);
    console.log(`Headings:`, authControls.headings);
    console.log(`Inputs found:`, authControls.inputs);
    console.log(`Action buttons / links found:`, authControls.actionButtons);

    await fs.writeFile(
      path.join(outDir, `${tag}-analysis.json`),
      JSON.stringify(authControls, null, 2),
      'utf8'
    );

  } catch (err) {
    console.error(`Error inspecting ${url}:`, err.message);
  } finally {
    await context.close();
  }
}

await browser.close();
console.log('\nDone with recon!');
