-- Khmer stories library: famous stories (title, author, year, summary) split
-- into labelled excerpts that tell a learner which part of a story fits which
-- essay topic. Content comes from the client; admins manage it through
-- /api/stories (admin / super_admin only for writes).
--
-- Run in the Supabase SQL editor (dev and prod).

create table if not exists public.khmer_stories (
  id uuid primary key,
  title_km text not null,
  title_en text,
  author text,
  year integer,
  summary_km text,
  summary_en text,
  themes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.khmer_story_excerpts (
  id uuid primary key,
  story_id uuid not null references public.khmer_stories(id) on delete cascade,
  label text not null,                       -- e.g. "Beginning", "Climax"
  excerpt_km text not null,
  usable_for_topics text[] not null default '{}',  -- e.g. family, honesty, nature
  order_number integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists khmer_story_excerpts_story_idx
  on public.khmer_story_excerpts (story_id, order_number);
