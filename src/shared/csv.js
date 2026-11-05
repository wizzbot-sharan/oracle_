import { WorkflowError } from './errors.js';

const DANGEROUS_HEADERS = new Set(['__proto__', 'prototype', 'constructor']);

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (character === '\n') {
      row.push(cell.trim().replace(/\r$/, ''));
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new WorkflowError('INVALID_CSV', 'CSV ends inside a quoted value');
  row.push(cell.trim().replace(/\r$/, ''));
  if (row.some(value => value !== '')) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) throw new WorkflowError('INVALID_CSV_HEADERS', 'CSV headers must be unique');
  if (headers.some(header => !header || DANGEROUS_HEADERS.has(header))) throw new WorkflowError('INVALID_CSV_HEADERS', 'CSV contains an empty or unsafe header');

  return rows.map((values, rowIndex) => {
    if (values.length !== headers.length) throw new WorkflowError('INVALID_CSV_ROW', `CSV row ${rowIndex + 2} has ${values.length} values; expected ${headers.length}`);
    const record = Object.create(null);
    headers.forEach((header, index) => { record[header] = values[index]; });
    return record;
  });
}

export function formatCsvRow(row, headers) {
  const escapeCell = value => {
    const str = String(value ?? '');
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  return headers.map(h => escapeCell(row[h])).join(',');
}

export function formatCsv(rows, headers) {
  const headerLine = formatCsvRow(Object.fromEntries(headers.map(h => [h, h])), headers);
  const lines = rows.map(row => formatCsvRow(row, headers));
  return [headerLine, ...lines].join('\n') + '\n';
}

