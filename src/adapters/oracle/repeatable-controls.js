const categories = [
  ['experience', /experience|employment|work history/i],
  ['education', /education|school|academic/i],
  ['skills', /skills?/i],
  ['licenses', /licen[cs]es?|certificates?|certifications?/i],
  ['languages', /languages?/i]
];

export function repeatableCategory(group) {
  const value = `${group?.label || ''} ${group?.id || ''}`;
  return categories.find(([, pattern]) => pattern.test(value))?.[0] || null;
}

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function findRepeatableGroup(page, group) {
  const category = repeatableCategory(group);
  if (!category) return null;
  if (category === 'experience' || category === 'education') {
    const button = page.locator(category === 'experience' ? '#timeline-add-experience-button' : '#timeline-add-education-button');
    if (await button.count() && typeof button.first().locator === 'function') {
      const root = button.first().locator('xpath=ancestor::*[contains(@class,"timeline-container")][1]');
      return { category, layout: 'timeline', root, add: button.first() };
    }
  }

  const blocks = page.locator('.apply-flow-block:visible');
  if (typeof blocks.nth !== 'function') return null;
  const count = await blocks.count();
  const matches = [];
  for (let index = 0; index < count; index++) {
    const block = blocks.nth(index);
    const title = normalize(await block.locator('.apply-flow-block__title').first().innerText().catch(() => ''));
    const region = normalize(await block.locator('.apply-flow-block__form-list[role="region"]').first().getAttribute('aria-label').catch(() => ''));
    const target = normalize(group.label || group.id);
    const sameCategory = categories.find(([name, pattern]) => name === category && (pattern.test(title) || pattern.test(region)));
    if (!sameCategory) continue;
    if (target && !sameCategory[1].test(target)) continue;
    const root = block.locator('.profile-item-container').first();
    if (!(await root.count())) continue;
    const add = root.locator('button.apply-flow-profile-item-tile__new-tile').first();
    matches.push({ category, layout: 'profile-inline', root, add, title });
  }
  if (matches.length > 1) {
    const wanted = normalize(group.addButton || group.label || group.id).replace(/^add\s+/, '').replace(/s\b/g, '');
    const precise = matches.filter(item => normalize(item.title).replace(/s\b/g, '').startsWith(wanted));
    if (precise.length === 1) return precise[0];
    throw new Error(`Ambiguous ${category} group on active page`);
  }
  return matches[0] || null;
}

export async function inspectRepeatableCards(handle) {
  if (handle.layout === 'timeline') {
    const column = handle.root.locator(handle.category === 'experience'
      ? '.beautiful-timeline__column[data-bind*="experiences"]'
      : '.beautiful-timeline__column[data-bind*="educations"]');
    return column.locator('[data-profile-item-tile="true"]').evaluateAll(elements => elements.map(element => ({
      title: (element.querySelector('.beautiful-timeline-item__title')?.textContent || '').trim(),
      subtitle: (element.querySelector('.beautiful-timeline-item__subtitle')?.textContent || '').trim(),
      isInvalid: element.getAttribute('data-profile-item-invalid') === 'true',
      provisional: false
    })));
  }
  return handle.root.locator('.profile-item-list article.apply-flow-profile-item-tile').evaluateAll(elements => elements.map(element => ({
    title: (element.querySelector('.apply-flow-profile-item-tile__summary-title')?.textContent || '').trim(),
    subtitle: (element.querySelector('.apply-flow-profile-item-tile__summary-subtitle')?.textContent || '').trim(),
    isInvalid: element.classList.contains('apply-flow-profile-item-tile--invalid') || element.querySelector('[data-profile-item-invalid="true"]') !== null,
    provisional: element.classList.contains('apply-flow-profile-item-tile--active') && element.closest('.profile-item-container')?.querySelector('.profile-item-content') !== null
  })));
}

export async function openRepeatableEditor(handle) {
  if (!(await handle.add.count()) || !(await handle.add.isEnabled())) throw new Error(`Add ${handle.category} is unavailable`);
  await handle.add.click();
  const editor = handle.layout === 'timeline'
    ? handle.root.locator('timeline-form-inline .standard-apply-flow-timeline-form:visible').first()
    : handle.root.locator('.profile-item-content:visible').first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  return { ...handle, editor, fields: editor, actions: handle.layout === 'timeline' ? editor : handle.root.locator('.profile-item-footer:visible').first() };
}

export async function closeRepeatableEditor(opened, action) {
  const button = action === 'save'
    ? opened.actions.locator(opened.layout === 'timeline' ? 'button[data-qa="addTimelineItemDialogButton"]' : 'button[data-qa="profileItemInlineSaveButton"]').first()
    : opened.actions.locator('button.cancel-btn').first();
  await button.click();
  await opened.editor.waitFor({ state: 'hidden', timeout: 15000 });
  return inspectRepeatableCards(opened);
}
