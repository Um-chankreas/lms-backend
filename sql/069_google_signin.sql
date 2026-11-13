-- Sign in with Google. `google_sub` is Google's stable account id for the person
-- (the "sub" claim of their ID token). We match returning users on it, never on
-- the email address alone.
alter table public.users add column if not exists google_sub text;
create unique index if not exists users_google_sub_key on public.users (google_sub) where google_sub is not null;
