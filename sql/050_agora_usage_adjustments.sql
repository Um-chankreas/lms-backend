-- Manual usage sync.
--
-- Our own minute counting only started when usage tracking shipped, so an
-- account that already burned minutes this month (as the Agora console shows)
-- looks emptier here than it really is. An admin types the console's figure
-- and we store the difference per account and month; the usage pages show
-- tracked minutes + this adjustment. Tracking keeps adding on top afterwards.

create table if not exists public.agora_usage_adjustments (
  agora_account text not null,          -- 'env' or an agora_accounts.id
  month text not null,                  -- 'YYYY-MM' (UTC)
  minutes integer not null default 0,   -- added to the tracked total (can be negative)
  updated_at timestamp with time zone not null default now(),
  primary key (agora_account, month)
);
