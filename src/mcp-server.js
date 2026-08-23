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
    mail_class_seg_count: run.mail_class_seg_count ?? 0,
    mail_class_native_count: run.mail_class_native_count ?? 0,
    mail_class_direct_count: run.mail_class_direct_count ?? 0,
    mail_class_unknown_count: run.mail_class_unknown_count ?? 0,
    sendable_seg_count: run.sendable_seg_count ?? 0,
    sendable_other_count: run.sendable_other_count ?? 0,
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
      'Always runs end-to-end: (0) free MX lookup tags each contact (seg / native_filter / direct / unknown) — nothing is dropped;',
      '(1) MillionVerifier classifies ok/catch_all/unknown/invalid,',
      '(2) catch_all AND unknown are sent to No2Bounce,',
      '(3) final SENDABLE = MV ok + No2Bounce-confirmed catch_alls + No2Bounce-confirmed unknowns;',
      'final REJECTED = MV invalid + No2Bounce rejects / unresolved.',
      'Campaign staging also writes SENDABLE_SEG (third-party gateway) and SENDABLE_OTHER (everyone else) — same copy, separate campaign.',
      'Does NOT stop after MillionVerifier. Does NOT filter or suppress gateway-protected contacts.',
      'Returns immediately with run_id — poll get_verification_status until status=completed, then get_verification_results for the final files.',
      'Never returns per-email results.',
    ].join(' '),
    {
      file_url: z.string().url().describe('Publicly accessible URL to a CSV with an Email column'),
      segment_name: z.string().min(1).describe('Segment / list name for this run'),
    },
    async ({ file_url, segment_name }) => {
      const run = await startVerificationFromUrl(file_url, segment_name);
      return textResult({
        run_id: run.id,
        status: run.status,
        segment_name: run.segment_name,
        waterfall: 'mx-tag -> millionverifier -> no2bounce(catch_all+unknown) -> merge sendable/rejected + seg/other split',
        note: 'MX tagging is free and never drops contacts. Pipeline continues automatically through No2Bounce and final merge. Poll until status=completed.',
      });
    }
  );

  server.tool(
    'get_verification_status',
    'Get compact status for a verification run. Summary fields only — no per-email data.',
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
        mail_class_seg_count: run.mail_class_seg_count ?? 0,
        mail_class_native_count: run.mail_class_native_count ?? 0,
        mail_class_direct_count: run.mail_class_direct_count ?? 0,
        mail_class_unknown_count: run.mail_class_unknown_count ?? 0,
        sendable_seg_count: run.sendable_seg_count ?? 0,
        sendable_other_count: run.sendable_other_count ?? 0,
        stage_completed: run.stage_completed || 'none',
        last_error: run.last_error || run.error_message || null,
        retry_count: run.retry_count ?? 0,
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
    'Return SENDABLE/REJECTED download URLs and stage counts. Completed runs return full results; failed/paused/in-progress runs return partial results labeled as such.',
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
    'Resume a failed, paused, queued, or stuck in-progress run (classifying_mx / verifying_mv / verifying_n2b / merging) from the last completed stage. Does not re-run MillionVerifier when mv_file_id or address results already exist. Re-runs free MX tagging only for addresses that still lack a mail_class.',
    {
      run_id: z.string().uuid(),
    },
    async ({ run_id }) => {
      try {
        const run = await resumeVerification(run_id);
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
