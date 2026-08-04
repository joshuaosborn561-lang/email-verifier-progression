import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  getRun,
  listRuns,
} from './db.js';
import { startVerificationFromUrl } from './pipeline.js';
import { createSignedUrl } from './storage.js';
import { config } from './config.js';
import { exportSendableZip } from './export.js';

function summarizeRun(run) {
  const mvCredits = run.mv_credits_used ?? 0;
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
    mv_credits_used: mvCredits,
    // Signature-compatible alias (Stage 1 is MillionVerifier now)
    bv_credits_used: mvCredits,
    n2b_credits_used: run.n2b_credits_used,
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
    version: '1.0.0',
  });

  server.tool(
    'start_verification',
    'Start an email verification waterfall run from a CSV file URL. Returns immediately with run_id — does not wait for completion. Never returns per-email results.',
    {
      file_url: z.string().url().describe('Publicly accessible URL to a CSV with an Email column'),
      segment_name: z.string().min(1).describe('Segment / list name for this run'),
    },
    async ({ file_url, segment_name }) => {
      const run = await startVerificationFromUrl(file_url, segment_name);
      return textResult({ run_id: run.id, status: run.status, segment_name: run.segment_name });
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
      const mvCredits = run.mv_credits_used ?? 0;
      return textResult({
        status: run.status,
        total_emails: run.total_emails,
        final_sendable_count: run.final_sendable_count,
        final_rejected_count: run.final_rejected_count,
        mv_ok_count: run.mv_ok_count,
        mv_catch_all_count: run.mv_catch_all_count,
        mv_unknown_count: run.mv_unknown_count,
        mv_invalid_count: run.mv_invalid_count,
        mv_credits_used: mvCredits,
        bv_credits_used: mvCredits,
        n2b_credits_used: run.n2b_credits_used,
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
    'Once a run is completed, return signed download URLs for SENDABLE and REJECTED CSVs. Summary-only — no row data.',
    {
      run_id: z.string().uuid(),
    },
    async ({ run_id }) => {
      const run = await getRun(run_id);
      if (run.status !== 'completed') {
        return textResult({
          error: 'Run is not completed',
          status: run.status,
        });
      }
      if (!run.sendable_path || !run.rejected_path) {
        return textResult({ error: 'Result files missing for this run' });
      }

      const [sendable_url, rejected_url] = await Promise.all([
        createSignedUrl(config.resultsBucket, run.sendable_path),
        createSignedUrl(config.resultsBucket, run.rejected_path),
      ]);

      return textResult({
        run_id: run.id,
        status: run.status,
        final_sendable_count: run.final_sendable_count,
        final_rejected_count: run.final_rejected_count,
        sendable_url,
        rejected_url,
      });
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
