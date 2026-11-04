export function flattenTemplateFields(template) {
  const fields = [];
  const visit = (items, context = {}) => {
    for (const item of items ?? []) {
      const nextContext = { ...context, sectionId: item.id ?? context.sectionId };
      if (Array.isArray(item.fields)) {
        for (const field of item.fields) {
          if (field.type === 'compound-phone' && field.children) {
            for (const child of field.children) {
              fields.push({ ...child, sectionId: item.id, parentId: field.id });
            }
          } else {
            fields.push({ ...field, ...context });
          }
        }
      }
      if (Array.isArray(item.groups)) {
        for (const group of item.groups) {
          fields.push({
            id: group.id,
            type: 'repeatable-group',
            label: group.label ?? group.id.replaceAll('_', ' '),
            addButton: group.addButton,
            required: Boolean(group.required),
            children: group.fields ?? [],
            sectionId: item.id
          });
          for (const field of group.fields ?? []) {
            fields.push({ ...field, sectionId: item.id, repeatableGroupId: group.id });
          }
        }
      }
    }
  };

  if (Array.isArray(template.fields)) {
    for (const field of template.fields) fields.push(field);
  }
  visit(template.sections);
  for (const group of template.repeatableGroups ?? []) {
    fields.push({
      id: group.id,
      type: 'repeatable-group',
      label: group.label ?? group.id.replaceAll('_', ' '),
      addButton: group.addButton,
      required: Boolean(group.required),
      children: group.fields ?? []
    });
    for (const field of group.fields ?? []) fields.push({ ...field, repeatableGroupId: group.id });
  }
  return fields;
}

export function isFieldVisible(field, values) {
  const condition = field.visibleWhen;
  if (!condition) return true;
  if (condition.all) return condition.all.every(item => isFieldVisible({ visibleWhen: item }, values));
  const parentVal = values[condition.field]?.value;
  if (condition.includes !== undefined) {
    if (Array.isArray(parentVal)) return parentVal.includes(condition.includes);
    if (parentVal === condition.includes) return true;
    if (condition.includes === 'Yes' && parentVal === true) return true;
    if (condition.includes === 'No' && parentVal === false) return true;
    return false;
  }
  if (parentVal === condition.equals) return true;
  if (condition.equals === 'Yes' && parentVal === true) return true;
  if (condition.equals === 'No' && parentVal === false) return true;
  if (condition.equals === true && /^(yes|true)$/i.test(String(parentVal))) return true;
  if (condition.equals === false && /^(no|false)$/i.test(String(parentVal))) return true;
  return false;
}

export function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
