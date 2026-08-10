import { Router } from 'express';
import multer from 'multer';
import {
  getRun,
  getRunLogs,
  listRuns,
} from './db.js';
import {
  startVerificationFromBuffer,
  resumeVerification,
  buildResultsPayload,
} from './pipeline.js';
import { createSignedUrl } from './storage.js';
import { config } from './config.js';
import { sanitizeSegmentName } from './csv.js';
import { exportSendableZip } from './export.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export function createApiRouter() {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'email-verification-waterfall' });
  });

  router.get('/runs', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      const runs = await listRuns(limit);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/runs/:id', async (req, res) => {
    try {
      const run = await getRun(req.params.id);
      const logs = await getRunLogs(req.params.id);
      let downloads = null;
      if (run.status === 'completed' && run.sendable_path && run.rejected_path) {
        const [sendable_url, rejected_url] = await Promise.all([
          createSignedUrl(config.resultsBucket, run.sendable_path),
          createSignedUrl(config.resultsBucket, run.rejected_path),
        ]);
        downloads = { sendable_url, rejected_url };
      }
      res.json({ run, logs, downloads });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post('/upload', upload.array('files', 20), async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const runs = [];
      for (const file of files) {
        const segment =
          (req.body.segment_name && files.length === 1
            ? req.body.segment_name
            : null) || sanitizeSegmentName(file.originalname);

        const run = await startVerificationFromBuffer({
          buffer: file.buffer,
          segmentName: segment,
          filename: file.originalname,
        });
        runs.push({
          run_id: run.id,
          segment_name: run.segment_name,
          status: run.status,
          total_emails: run.total_emails,
        });
      }

      res.status(202).json({ runs });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/runs/:id/retry', async (req, res) => {
    try {
      const run = await resumeVerification(req.params.id);
      res.json({
        ok: true,
        run_id: run.id,
        status: run.status,
        stage_completed: run.stage_completed || 'none',
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/runs/:id/resume', async (req, res) => {
    try {
      const run = await resumeVerification(req.params.id);
      res.json({
        ok: true,
        run_id: run.id,
        status: run.status,
        stage_completed: run.stage_completed || 'none',
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/runs/:id/results', async (req, res) => {
    try {
      const run = await getRun(req.params.id);
      const payload = await buildResultsPayload(run);
      res.json(payload);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /**
   * GET /api/export/bulk?run_ids=uuid1,uuid2
   * Zips SENDABLE CSVs for completed runs → signed URL in verification-results.
   */
  router.get('/export/bulk', async (req, res) => {
    try {
      const result = await exportSendableZip(req.query.run_ids ?? req.query.run_id);
      res.json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        ...(err.skipped ? { skipped: err.skipped } : {}),
      });
    }
  });

  return router;
}
