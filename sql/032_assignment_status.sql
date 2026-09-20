-- Draft/publish workflow for assignments (both file- and quiz-type): a
-- teacher can save an assignment — and, for quiz-type, its questions —
-- before students ever see it. Publishing is the one moment students get
-- notified (see notifyAssignmentPublished in utils/notifyEvents.js).
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.assignments
  add column if not exists status text not null default 'draft';

do $$ begin
  alter table public.assignments
    add constraint assignments_status_check check (status in ('draft', 'published'));
exception when duplicate_object then null; end $$;

alter table public.assignments
  add column if not exists published_at timestamptz;

-- Backfill: every assignment created before this migration was already
-- live for students, so treat existing rows as published rather than
-- hiding them behind the new draft default.
update public.assignments
  set status = 'published', published_at = coalesce(published_at, created_at)
  where status = 'draft';
