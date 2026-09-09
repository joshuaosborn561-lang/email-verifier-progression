import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  getRun,
  listRuns,
} from './db.js';
import {
  buildResultsPayload,
  resumeVerification,
  startVerificationFromUrl,
} from './pipeline.js';
import { usefulOutputCount } from './salvage.js';

function summarizeRun(run) {
  return {
    run_id: run.id,
    segment_name: run.segment_name,
    status: run.status,
    total_emails: run.total_emails,
    final_sendable_count: run.final_sendable_count,
    final_rejected_count: run.final_rejected_count,
    mv_ok_count: run.mv_ok_count,
    mv_catch_all_count: run.mv_catch_all_count,
    mv_unknown_count: run.mv_unknown_count,
    mv_invalid_count: run.mv_invalid_count,
    mv_credits_used: run.mv_credits_used ?? 0,
    n2b_credits_used: run.n2b_credits_used,
    n2b_catch_all_candidates: run.n2b_catch_all_candidates ?? 0,
    n2b_catch_all_deliverable: run.n2b_catch_all_deliverable ?? 0,
    n2b_unknown_candidates: run.n2b_unknown_candidates ?? 0,
    n2b_unknown_deliverable: run.n2b_unknown_deliverable ?? 0,
    unresolved_after_n2b_count: run.unresolved_after_n2b_count ?? 0,
    unresolved_count: run.unresolved_count ?? 0,
    mv_recovered_count: run.mv_recovered_count ?? 0,
    mail_class_seg_count: run.mail_class_seg_count ?? 0,
    mail_class_native_count: run.mail_class_native_count ?? 0,
    mail_class_direct_count: run.mail_class_direct_count ?? 0,
    mail_class_unknown_count: run.mail_class_unknown_count ?? 0,
    sendable_seg_count: run.sendable_seg_count ?? 0,
    sendable_other_count: run.sendable_other_count ?? 0,
    useful_output_count: usefulOutputCount(run),
    stage_completed: run.stage_completed || 'none',
    last_error: run.last_error || run.error_message || null,
    retry_count: run.retry_count ?? 0,
    created_at: run.created_at,
    completed_at: run.completed_at,
  };
}

function textResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  };
}

export function createMcpServer() {
  const server = new McpServer({
    name: 'email-verification-waterfall',
    version: '1.1.0',
  });

  server.tool(
    'start_verification',
    [
      'Start a FULL email verification waterfall from a CSV file URL.',
      'RULE: never start a fresh run on a file that already has a run until you have called get_verification_results on that prior run and read resolved_counts / salvage_decision.',
      'A failed run is not empty. Restarting without that check re-bills MillionVerifier for addresses already paid.',
      'If a prior run exists, pass prior_run_id. The server refuses the start when salvage_decision.action is resume or salvage unless force_fresh=true.',
      'force_fresh is only valid when resolved_counts shows every MV verdict count at 0 (action=fresh_ok). Re-export from the client table first so deletions are not re-verified.',
      'Always runs end-to-end: (0) free MX lookup tags each contact (seg / native_filter / direct / unknown) — nothing is dropped;',
      '(1) MillionVerifier classifies ok/catch_all/unknown/invalid,',
      '(2) catch_all AND unknown are sent to No2Bounce,',
      '(3) final SENDABLE = MV ok + No2Bounce-confirmed catch_alls + No2Bounce-confirmed unknowns.',
      'Report useful_output_count (verified sendable), never rows submitted.',
      'Returns immediately with run_id. Never returns per-email results.',
    ].join(' '),
    {
      file_url: z.string().url().describe('Publicly accessible URL to a CSV with an Email column'),
      segment_name: z.string().min(1).describe('Segment / list name for this run'),
      prior_run_id: z
        .string()
        .uuid()
        .optional()
        .describe('Failed/paused run for this same file. Required whenever one exists. Server reads resolved_counts before starting.'),
      force_fresh: z
        .boolean()
        .optional()
        .describe('Override only when salvage_decision.action is fresh_ok (zero MV verdicts). Never use to skip salvage.'),
    },
    async ({ file_url, segment_name, prior_run_id, force_fresh }) => {
      try {
        const run = await startVerificationFromUrl(file_url, segment_name, {
          priorRunId: prior_run_id || null,
          forceFresh: Boolean(force_fresh),
        });
        return textResult({
          run_id: run.id,
          status: run.status,
          segment_name: run.segment_name,
          waterfall: 'mx-tag -> millionverifier -> no2bounce(catch_all+unknown) -> merge sendable/rejected + seg/other split',
          note: 'MX tagging is free and never drops contacts. Pipeline continues automatically through No2Bounce and final merge. Poll until status=completed. Report useful_output_count, not rows submitted.',
        });
      } catch (err) {
        return textResult({ error: err.message });
      }
    }
  );

  server.tool(
    'get_verification_status',
    'Get compact status for a verification run. Summary fields only — no per-email data. On failed/paused/stuck runs this is step 1 of the salvage ladder: read stage_completed, retry_count, last_error (MV file_id/percent/verified), and credits. Then you MUST call get_verification_results and read resolved_counts / salvage_decision before start_verification. useful_output_count is verified sendable addresses — never report rows submitted as success.',
    {
      run_id: z.string().uuid(),
    },
    async ({ run_id }) => {
      const run = await getRun(run_id);
      return textResult({
        status: run.status,
        total_emails: run.total_emails,
        final_sendable_count: run.final_sendable_count,
        final_rejected_count: run.final_rejected_count,
        mv_ok_count: run.mv_ok_count,
        mv_catch_all_count: run.mv_catch_all_count,
        mv_unknown_count: run.mv_unknown_count,
        mv_invalid_count: run.mv_invalid_count,
        mv_credits_used: run.mv_credits_used ?? 0,
        n2b_credits_used: run.n2b_credits_used,
        n2b_catch_all_candidates: run.n2b_catch_all_candidates ?? 0,
        n2b_catch_all_deliverable: run.n2b_catch_all_deliverable ?? 0,
        n2b_unknown_candidates: run.n2b_unknown_candidates ?? 0,
        n2b_unknown_deliverable: run.n2b_unknown_deliverable ?? 0,
        unresolved_after_n2b_count: run.unresolved_after_n2b_count ?? 0,
        unresolved_count: run.unresolved_count ?? 0,
        mv_recovered_count: run.mv_recovered_count ?? 0,
        mail_class_seg_count: run.mail_class_seg_count ?? 0,
        mail_class_native_count: run.mail_class_native_count ?? 0,
        mail_class_direct_count: run.mail_class_direct_count ?? 0,
        mail_class_unknown_count: run.mail_class_unknown_count ?? 0,
        sendable_seg_count: run.sendable_seg_count ?? 0,
        sendable_other_count: run.sendable_other_count ?? 0,
        useful_output_count: usefulOutputCount(run),
        stage_completed: run.stage_completed || 'none',
        last_error: run.last_error || run.error_message || null,
        retry_count: run.retry_count ?? 0,
        next_step:
          run.status === 'completed'
            ? null
            : 'Call get_verification_results and read resolved_counts / salvage_decision before start_verification or a third resume.',
      });
    }
  );

  server.tool(
    'list_verification_runs',
    'List recent verification runs in compact summary form.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max rows to return (default 20)'),
    },
    async ({ limit }) => {
      const runs = await listRuns(limit || 20);
      return textResult({
        runs: runs.map(summarizeRun),
      });
    }
  );

  server.tool(
    'get_verification_results',
    'REQUIRED before starting a fresh run on a file that already has a run. Returns SENDABLE/REJECTED URLs, resolved_counts, and salvage_decision. A failed run is not empty — read salvage_decision.action: fresh_ok (safe to re-export and restart), resume (do not restart; MV already paid), salvage (ingest sendable+rejected, remainder only), done. Signed URLs expire in one hour. Never dump per-email rows into chat.',
    {
      run_id: z.string().uuid(),
    },
    async ({ run_id }) => {
      const run = await getRun(run_id);
      const payload = await buildResultsPayload(run);
      return textResult(payload);
    }
  );

  server.tool(
    'resume_verification',
    'Resume a failed, paused, queued, stuck, or completed-but-corrupt run from the last completed stage. Reloads mv_file_id without re-billing. Resume once; a second resume only if percent/verified moved. A third resume on an unmoving stall (same file_id/percent/verified, retry_count>=2) is refused — call get_verification_results instead. Never merges unverified rows as rejected.',
    {
      run_id: z.string().uuid(),
      force: z
        .boolean()
        .optional()
        .describe('Override the unmoving-stall cap or resume a completed run. Only after reading salvage_decision.'),
    async ({ run_id, force }) => {
      try {
        const run = await resumeVerification(run_id, { force: Boolean(force) });
        return textResult({
          run_id: run.id,
          status: run.status,
          stage_completed: run.stage_completed || 'none',
          resumed: true,
        });
      } catch (err) {
        return textResult({ error: err.message, run_id });
      }
    }
  );

  server.tool(
    'export_all_sendable',
    'Zip SENDABLE CSVs for multiple completed runs into one archive in verification-results and return a single signed download URL. Summary-only — never returns CSV row data.',
    {
      run_ids: z
        .array(z.string().uuid())
        .min(1)
        .max(100)
        .describe('Completed verification run IDs to include'),
    },
    async ({ run_ids }) => {
      try {
        const { exportSendableZip } = await import('./export.js');
        const result = await exportSendableZip(run_ids);
        return textResult({
          download_url: result.download_url,
          file_count: result.file_count,
          total_sendable_rows: result.total_sendable_rows,
          included: result.included.map((r) => ({
            run_id: r.run_id,
            segment_name: r.segment_name,
            final_sendable_count: r.final_sendable_count,
          })),
          skipped: result.skipped,
        });
      } catch (err) {
        return textResult({
          error: err.message,
          ...(err.skipped ? { skipped: err.skipped } : {}),
        });
      }
    }
  );

  return server;
}

/**
 * Mount MCP Streamable HTTP endpoint on Express.
 * Clients POST to /mcp (JSON-RPC). Each request gets a fresh transport.
 */
export function mountMcp(app) {
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message || 'Internal error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. Use POST for Streamable HTTP MCP.',
      },
      id: null,
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).end();
  });
}
