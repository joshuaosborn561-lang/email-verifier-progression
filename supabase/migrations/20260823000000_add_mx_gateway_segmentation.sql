-- Persistent MX / secure-email-gateway cache + per-address tags.
-- Tag and split only — never filter or delete contacts.

create table if not exists domain_mx_cache (
  domain text primary key,
  mx_host text,
  mx_hosts text,
  mail_class text not null default 'unknown',
  gateway_provider text not null default 'none',
  lookup_error text,
  lookup_count int not null default 1,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

create index if not exists domain_mx_cache_mail_class_idx
  on domain_mx_cache (mail_class);

alter table domain_mx_cache enable row level security;

alter table verification_address_results
  add column if not exists domain text,
  add column if not exists mail_class text,
  add column if not exists gateway_provider text,
  add column if not exists mx_host text,
  add column if not exists behind_gateway boolean;

create index if not exists verification_address_results_mail_class_idx
  on verification_address_results (run_id, mail_class);

alter table verification_runs
  add column if not exists mx_domain_count int default 0,
  add column if not exists mx_cache_hits int default 0,
  add column if not exists mx_lookups int default 0,
  add column if not exists mail_class_seg_count int default 0,
  add column if not exists mail_class_native_count int default 0,
  add column if not exists mail_class_direct_count int default 0,
  add column if not exists mail_class_unknown_count int default 0,
  add column if not exists sendable_seg_count int default 0,
  add column if not exists sendable_other_count int default 0,
  add column if not exists sendable_seg_path text,
  add column if not exists sendable_other_path text;

comment on column verification_runs.stage_completed is
  'Last fully completed stage: none | mx | mv | n2b | merge';
comment on column verification_runs.mail_class_seg_count is
  'Contacts behind a third-party secure email gateway (Proofpoint/Mimecast/Barracuda/Cisco/etc). Tagged only — never dropped.';
comment on column verification_runs.sendable_seg_path is
  'Campaign-staging split: sendable contacts with mail_class=seg. Same copy/offer, separate campaign.';
