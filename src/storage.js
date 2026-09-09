import { getSupabase } from './db.js';
import { config } from './config.js';

export async function uploadFile(bucket, path, data, contentType = 'text/csv') {
  const supabase = getSupabase();
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const { error } = await supabase.storage.from(bucket).upload(path, body, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
  return path;
}

export async function downloadFile(bucket, path) {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw error;
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

export async function createSignedUrl(bucket, path, expiresIn = 60 * 60) {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function downloadFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file_url (HTTP ${res.status})`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export { config };
