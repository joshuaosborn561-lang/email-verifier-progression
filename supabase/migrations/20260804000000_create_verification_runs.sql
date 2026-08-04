-- Email verification waterfall schema
create table if not exists verification_runs (
  id uuid primary key default gen_random_uuid(),
  segment_name text not null,
  status text not null default 'queued', -- queued | verifying_bv | verifying_n2b | merging | completed | failed | paused
  total_emails int,
  bv_valid_count int default 0,
  bv_catchall_count int default 0,
  bv_unknown_count int default 0,
  bv_invalid_count int default 0,
  bv_credits_used int default 0,
  n2b_candidates_count int default 0,
  n2b_deliverable_count int default 0,
  n2b_credits_used int default 0,
  final_sendable_count int default 0,
  final_rejected_count int default 0,
  error_message text,
  started_at timestamp,
  completed_at timestamp,
  created_at timestamp default now(),
  upload_path text,
  sendable_path text,
  rejected_path text
);

create table if not exists verification_run_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references verification_runs(id) on delete cascade,
  message text,
  created_at timestamp default now()
);

create index if not exists verification_runs_created_at_idx
  on verification_runs (created_at desc);

create index if not exists verification_run_logs_run_id_created_at_idx
  on verification_run_logs (run_id, created_at);

alter table verification_runs enable row level security;
alter table verification_run_logs enable row level security;

-- Private storage buckets (created via SQL as well)
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('verification-uploads', 'verification-uploads', false, 104857600),
  ('verification-results', 'verification-results', false, 104857600)
on conflict (id) do nothing;
