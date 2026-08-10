-- Remove BillionVerifier permanently; add per-address persistence + resume metadata.
-- Historical run rows are retained (only BV aggregate columns are dropped).

alter table verification_runs
  drop column if exists bv_valid_count,
  drop column if exists bv_catchall_count,
  drop column if exists bv_unknown_count,
  drop column if exists bv_invalid_count,
  drop column if exists bv_credits_used;

alter table verification_runs
  add column if not exists last_error text,
  add column if not exists retry_count int default 0,
  add column if not exists stage_completed text default 'none',
  add column if not exists n2b_catch_all_candidates int default 0,
  add column if not exists n2b_catch_all_deliverable int default 0,
  add column if not exists n2b_unknown_candidates int default 0,
  add column if not exists n2b_unknown_deliverable int default 0,
  add column if not exists unresolved_after_n2b_count int default 0;

comment on column verification_runs.stage_completed is
  'Last fully completed stage: none | mv | n2b | merge';

create table if not exists verification_address_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references verification_runs(id) on delete cascade,
  email text not null,
  mv_result text,
  n2b_status text,
  n2b_cohort text,
  final_disposition text default 'pending',
  confidence text,
  verification_source text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (run_id, email)
);

create index if not exists verification_address_results_run_id_idx
  on verification_address_results (run_id);

create index if not exists verification_address_results_run_disposition_idx
  on verification_address_results (run_id, final_disposition);

alter table verification_address_results enable row level security;

-- Backfill stage_completed for runs that already finished MillionVerifier
update verification_runs
set stage_completed = 'mv'
where coalesce(stage_completed, 'none') in ('none', '')
  and mv_file_id is not null
  and status in ('failed', 'paused', 'verifying_n2b');

update verification_runs
set stage_completed = 'merge'
where status = 'completed'
  and coalesce(stage_completed, 'none') in ('none', '');
