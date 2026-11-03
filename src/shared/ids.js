import { createHash, randomUUID } from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function stableId(prefix, value) {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}
