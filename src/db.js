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

export async function createRun({ segmentName, uploadPath, totalEmails = null }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_runs')
    .insert({
      segment_name: segmentName,
      status: 'queued',
      upload_path: uploadPath,
      total_emails: totalEmails,
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
