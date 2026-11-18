import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { findRepeatableGroup, inspectRepeatableCards, openRepeatableEditor, closeRepeatableEditor } from '../src/adapters/oracle/repeatable-controls.js';
import { OracleRecruitingAdapter } from '../src/adapters/oracle/oracle-recruiting.js';

test('inline link scanner probes Add Another Link and restores the original row without retaining values', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<section class="apply-flow-block"><h2 class="apply-flow-block__title">Work and Education History</h2>
      <candidate-links><div class="candidate-links">
        <div class="candidate-links__link"><label for="siteLink-1-a">Link 1</label><input id="siteLink-1-a" name="siteLink-1" type="url" aria-label="Work and Education History Link 1"></div>
        <button type="button" class="candidate-links__add-link">Add Another Link</button>
      </div></candidate-links></section>
      <script>
        const linkGroup = document.querySelector('candidate-links');
        linkGroup.querySelector('.candidate-links__add-link').addEventListener('click', () => {
          const n = linkGroup.querySelectorAll('input[name^="siteLink-"]').length + 1;
          const row = document.createElement('div'); row.className = 'candidate-links__link candidate-links__link--removable';
          row.innerHTML = '<input name="siteLink-' + n + '" type="url" aria-label="Work and Education History Link ' + n + '"><button type="button" class="candidate-links__remove-link">Remove</button>';
          row.querySelector('button').onclick = () => row.remove(); linkGroup.querySelector('.candidate-links').append(row);
        });
      </script>`);
    const adapter = new OracleRecruitingAdapter();
    const groups = await adapter._scanInlineLinkGroupsForTest(page);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kind, 'inline-links');
    assert.equal(groups[0].sectionLabel, 'Work and Education History');
    assert.equal(groups[0].children[0].sourceName, 'siteLink-1');
    assert.equal(groups[0].addRowProbe.succeeded, true);
    assert.deepEqual(await page.locator('candidate-links input').evaluateAll(items => items.map(item => item.name)), ['siteLink-1']);
  } finally {
    await browser.close();
  }
});

test('inline link filling stays inside its scanned component and preserves existing URLs', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<candidate-links><div class="candidate-links"><div class="candidate-links__link"><input name="siteLink-1" type="url" aria-label="Work History Link 1"></div><button class="candidate-links__add-link" type="button">Add Another Link</button></div></candidate-links>
      <candidate-links><div class="candidate-links"><div class="candidate-links__link"><input name="siteLink-1" type="url" value="https://keep.example" aria-label="Diversity Information Link 1"></div><button class="candidate-links__add-link" type="button">Add Another Link</button></div></candidate-links>`);
    const adapter = new OracleRecruitingAdapter({ humanDelay: { min: 0, max: 0 }, actionGap: { min: 0, max: 0 } });
    await adapter._fillRepeatableGroupForTest(page, {
      id: 'inline_links_work_history_1', kind: 'inline-links', label: 'Work History', sectionLabel: 'Work History',
      componentOrdinal: 0, addButton: 'Add Another Link', children: [{ id: 'url', type: 'url', sourceName: 'siteLink-1' }]
    }, [{ url: 'https://candidate.example/profile' }]);
    assert.deepEqual(await page.locator('candidate-links').nth(0).locator('input').evaluateAll(items => items.map(item => item.value)), ['https://candidate.example/profile']);
    assert.deepEqual(await page.locator('candidate-links').nth(1).locator('input').evaluateAll(items => items.map(item => item.value)), ['https://keep.example']);
  } finally {
    await browser.close();
  }
});

test('timeline cards remain scoped to Experience or Education', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="timeline-container">
      <button id="timeline-add-experience-button">Add Experience</button>
      <button id="timeline-add-education-button">Add Education</button>
      <div class="beautiful-timeline__column" data-bind="foreach: experiences"><div data-profile-item-tile="true"><span class="beautiful-timeline-item__title">Unnamed Job Title</span></div></div>
      <div class="beautiful-timeline__column" data-bind="foreach: educations"></div>
    </div>`);
    const experience = await findRepeatableGroup(page, { id: 'experience' });
    const education = await findRepeatableGroup(page, { id: 'education' });
    assert.equal((await inspectRepeatableCards(experience)).length, 1);
    assert.equal((await inspectRepeatableCards(education)).length, 0);
  } finally { await browser.close(); }
});

test('profile-inline language editor distinguishes provisional tile from saved card', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="apply-flow-block"><h2 class="apply-flow-block__title">Languages</h2>
      <div class="apply-flow-block__form-list" role="region" aria-label="Languages "><div class="profile-item-container">
        <div class="profile-item-list"></div><button class="apply-flow-profile-item-tile__new-tile" onclick="openEditor()">Add Language</button>
        <div class="profile-item-content" style="display:none"><input name="contentItemId" role="combobox" value="English"></div>
        <div class="profile-item-footer" style="display:none"><button data-qa="profileItemInlineSaveButton" onclick="saveEditor()">Add Language</button><button class="cancel-btn" onclick="cancelEditor()">Cancel</button></div>
      </div></div></div>
      <script>
      function openEditor(){ document.querySelector('.profile-item-content').style.display='block';document.querySelector('.profile-item-footer').style.display='block';document.querySelector('.profile-item-list').innerHTML='<article class="apply-flow-profile-item-tile apply-flow-profile-item-tile--active"><div class="apply-flow-profile-item-tile__summary-title">Unnamed Language</div></article>'; }
      function saveEditor(){ document.querySelector('.profile-item-content').style.display='none';document.querySelector('.profile-item-footer').style.display='none';document.querySelector('article').classList.remove('apply-flow-profile-item-tile--active');document.querySelector('.apply-flow-profile-item-tile__summary-title').textContent='English'; }
      function cancelEditor(){ document.querySelector('.profile-item-content').style.display='none';document.querySelector('.profile-item-footer').style.display='none';document.querySelector('.profile-item-list').innerHTML=''; }
      </script>`);
    const group = await findRepeatableGroup(page, { id: 'languages', label: 'Languages' });
    assert.equal((await inspectRepeatableCards(group)).length, 0);
    const opened = await openRepeatableEditor(group);
    assert.equal((await inspectRepeatableCards(group))[0].provisional, true);
    const cards = await closeRepeatableEditor(opened, 'save');
    assert.deepEqual(cards.map(card => [card.title, card.provisional]), [['English', false]]);
  } finally { await browser.close(); }
});
