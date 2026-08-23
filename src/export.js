import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { getRun } from './db.js';
import { config } from './config.js';
import { sanitizeSegmentName } from './csv.js';
import {
  createSignedUrl,
  downloadFile,
  uploadFile,
} from './storage.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Parse run_ids from query/body: comma-separated string, repeated params, or array.
 */
export function parseRunIds(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const ids = [];
  for (const item of raw) {
    for (const part of String(item).split(',')) {
      const id = part.trim();
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/**
 * Zip SENDABLE CSVs for completed runs, upload to verification-results, return signed URL.
 */
export async function exportSendableZip(runIds) {
  const ids = parseRunIds(runIds);
  if (!ids.length) {
    throw Object.assign(new Error('run_ids is required'), { statusCode: 400 });
  }
  if (ids.length > 100) {
    throw Object.assign(new Error('Maximum 100 run_ids per export'), { statusCode: 400 });
  }

  const invalid = ids.filter((id) => !UUID_RE.test(id));
  if (invalid.length) {
    throw Object.assign(
      new Error(`Invalid run_id(s): ${invalid.slice(0, 5).join(', ')}`),
      { statusCode: 400 }
    );
  }

  const included = [];
  const skipped = [];
  const zip = new JSZip();
  const usedNames = new Map();

  for (const runId of ids) {
    let run;
    try {
      run = await getRun(runId);
    } catch {
      skipped.push({ run_id: runId, reason: 'not_found' });
      continue;
    }

    if (run.status !== 'completed') {
      skipped.push({ run_id: runId, reason: `status_${run.status}` });
      continue;
    }
    if (!run.sendable_path) {
      skipped.push({ run_id: runId, reason: 'missing_sendable_path' });
      continue;
    }

    const buffer = await downloadFile(config.resultsBucket, run.sendable_path);
    const segment = sanitizeSegmentName(run.segment_name);
    let entryName = `${segment}_SENDABLE.csv`;
    if (usedNames.has(entryName)) {
      entryName = `${segment}_${runId.slice(0, 8)}_SENDABLE.csv`;
    }
    usedNames.set(entryName, true);

    zip.file(entryName, buffer);

    const extraFiles = [];
    for (const [path, suffix] of [
      [run.sendable_seg_path, 'SENDABLE_SEG'],
      [run.sendable_other_path, 'SENDABLE_OTHER'],
    ]) {
      if (!path) continue;
      try {
        const extra = await downloadFile(config.resultsBucket, path);
        let extraName = `${segment}_${suffix}.csv`;
        if (usedNames.has(extraName)) {
          extraName = `${segment}_${runId.slice(0, 8)}_${suffix}.csv`;
        }
        usedNames.set(extraName, true);
        zip.file(extraName, extra);
        extraFiles.push(extraName);
      } catch {
        // Combined SENDABLE remains the primary artifact
      }
    }

    included.push({
      run_id: runId,
      segment_name: run.segment_name,
      final_sendable_count: run.final_sendable_count,
      sendable_seg_count: run.sendable_seg_count ?? null,
      sendable_other_count: run.sendable_other_count ?? null,
      entry_name: entryName,
      extra_files: extraFiles,
    });
  }

  if (!included.length) {
    throw Object.assign(
      new Error('No completed runs with SENDABLE CSVs found for the given run_ids'),
      { statusCode: 404, skipped }
    );
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = `exports/sendable_bulk_${stamp}_${randomUUID().slice(0, 8)}.zip`;

  await uploadFile(
    config.resultsBucket,
    zipPath,
    zipBuffer,
    'application/zip'
  );

  const download_url = await createSignedUrl(config.resultsBucket, zipPath, 60 * 60);

  return {
    download_url,
    zip_path: zipPath,
    file_count: included.length,
    total_sendable_rows: included.reduce(
      (sum, r) => sum + (Number(r.final_sendable_count) || 0),
      0
    ),
    included,
    skipped,
  };
}
