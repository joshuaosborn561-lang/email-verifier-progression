-- Never-verified rows stay unresolved (not rejected).
-- mv_recovered_count records how many rows were pulled from a stalled MV file.

alter table verification_runs
  add column if not exists unresolved_count int default 0,
  add column if not exists unresolved_path text,
  add column if not exists mv_recovered_count int default 0;

comment on column verification_runs.unresolved_count is
  'Rows the verifier never assessed, or still pending N2B. Not rejected.';
comment on column verification_runs.mv_recovered_count is
  'Rows recovered from a MillionVerifier result file, including partial stall recovery.';
