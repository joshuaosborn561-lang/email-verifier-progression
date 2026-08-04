import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

export function parseCsv(bufferOrString) {
  const text = Buffer.isBuffer(bufferOrString)
    ? bufferOrString.toString('utf8')
    : String(bufferOrString);

  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  if (!records.length) {
    throw new Error('CSV contains no data rows');
  }

  const columns = Object.keys(records[0]);
  const emailCol = columns.find((c) => c.toLowerCase() === 'email');
  if (!emailCol) {
    throw new Error('CSV must include an Email column');
  }

  return { records, columns, emailCol };
}

export function toCsv(records, columns) {
  return stringify(records, {
    header: true,
    columns,
  });
}

export function sanitizeSegmentName(name) {
  return String(name || 'segment')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120) || 'segment';
}
