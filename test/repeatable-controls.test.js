import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { findRepeatableGroup, inspectRepeatableCards, openRepeatableEditor, closeRepeatableEditor } from '../src/adapters/oracle/repeatable-controls.js';

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
