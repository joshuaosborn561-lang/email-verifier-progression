import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client;

export function getSupabase() {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Test helper — inject a mock client. */
export function __setSupabaseClientForTests(mock) {
  client = mock;
}

export async function createRun({ segmentName, uploadPath, totalEmails = null }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_runs')
    .insert({
      segment_name: segmentName,
      status: 'queued',
      upload_path: uploadPath,
      total_emails: totalEmails,
      stage_completed: 'none',
      retry_count: 0,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function getRun(runId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_runs')
    .select('*')
    .eq('id', runId)
    .single();
  if (error) throw error;
  return data;
}

export async function listRuns(limit = 50) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function updateRun(runId, patch) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_runs')
    .update(patch)
    .eq('id', runId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function addLog(runId, message) {
  const supabase = getSupabase();
  const { error } = await supabase.from('verification_run_logs').insert({
    run_id: runId,
    message,
  });
  if (error) throw error;
  console.log(`[run:${runId}] ${message}`);
}

export async function getRunLogs(runId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_run_logs')
    .select('*')
    .eq('run_id', runId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getTodayCreditsUsed(column) {
  const supabase = getSupabase();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('verification_runs')
    .select(column)
    .gte('created_at', start.toISOString());
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + (Number(row[column]) || 0), 0);
}

/**
 * Upsert per-address results in chunks (Supabase payload limits).
 */
export async function upsertAddressResults(runId, rows) {
  if (!rows.length) return;
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const payload = rows.map((row) => ({
    run_id: runId,
    email: String(row.email).toLowerCase(),
    mv_result: row.mv_result ?? null,
    n2b_status: row.n2b_status ?? null,
    n2b_cohort: row.n2b_cohort ?? null,
    final_disposition: row.final_disposition ?? 'pending',
    confidence: row.confidence ?? null,
    verification_source: row.verification_source ?? null,
    updated_at: now,
  }));

  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('verification_address_results')
      .upsert(chunk, { onConflict: 'run_id,email' });
    if (error) throw error;
  }
}

export async function listAddressResults(runId) {
  const supabase = getSupabase();
  const pageSize = 1000;
  let from = 0;
  const all = [];

  for (;;) {
    const { data, error } = await supabase
      .from('verification_address_results')
      .select('*')
      .eq('run_id', runId)
      .order('email', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

export async function countAddressResultsByDisposition(runId) {
  const rows = await listAddressResults(runId);
  const counts = {
    total: rows.length,
    pending: 0,
    sendable: 0,
    rejected: 0,
    mv_ok: 0,
    mv_catch_all: 0,
    mv_unknown: 0,
    mv_invalid: 0,
    n2b_resolved: 0,
    awaiting_n2b: 0,
  };
  for (const row of rows) {
    if (row.final_disposition === 'sendable') counts.sendable += 1;
    else if (row.final_disposition === 'rejected') counts.rejected += 1;
    else counts.pending += 1;

    if (row.mv_result === 'ok') counts.mv_ok += 1;
    else if (row.mv_result === 'catch_all') counts.mv_catch_all += 1;
    else if (row.mv_result === 'unknown') counts.mv_unknown += 1;
    else if (row.mv_result === 'invalid') counts.mv_invalid += 1;

    if (row.n2b_status) counts.n2b_resolved += 1;
    else if (row.mv_result === 'catch_all' || row.mv_result === 'unknown') {
      counts.awaiting_n2b += 1;
    }
  }
  return counts;
}
