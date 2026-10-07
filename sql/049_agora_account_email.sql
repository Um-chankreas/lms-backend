-- The Agora console login email for each stored account, so admins can tell
-- which login owns which project (and where to go to top up / check billing).
alter table public.agora_accounts
  add column if not exists email text;
