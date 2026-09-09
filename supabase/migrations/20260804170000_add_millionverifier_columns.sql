-- MillionVerifier Stage 1 metrics (BillionVerify columns retained but unused)
alter table verification_runs
  add column if not exists mv_ok_count int default 0,
  add column if not exists mv_catch_all_count int default 0,
  add column if not exists mv_unknown_count int default 0,
  add column if not exists mv_invalid_count int default 0,
  add column if not exists mv_credits_used int default 0,
  add column if not exists mv_file_id text;
