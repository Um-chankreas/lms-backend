-- Teacher follow-up log per student: notes, messages sent, praise, and
-- "marked as followed up". Drives the Students > follow-up page.
create table if not exists public.student_followups (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  author_id uuid references public.users(id) on delete set null,
  author_name text,
  kind text not null default 'note' check (kind in ('note', 'message', 'praise', 'done', 'reopen')),
  text text,
  created_at timestamptz not null default now()
);
create index if not exists student_followups_student_idx on public.student_followups (student_id, created_at desc);
