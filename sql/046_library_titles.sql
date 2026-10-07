-- Optional hand-written titles for Library files.
--
-- The shelves are driven by filenames (utils/textbookNames.js etc.), which
-- also derive each file's title: "ភាសាខ្មែរ ថ្នាក់ទី២" comes from
-- 02-grade02-khmer-khmer.pdf. That is right for conforming names, but gives
-- no way to title a file differently (or to title a mis-named upload).
--
-- A row here overrides the derived title/subtitle for one file. No row means
-- the filename-derived title is used, exactly as before. `file_id` is the
-- filename without ".pdf"; `kind` is textbook | past-paper | formula.

create table if not exists public.library_titles (
  kind text not null check (kind in ('textbook', 'past-paper', 'formula')),
  file_id text not null,
  title text not null,
  subtitle text,
  updated_at timestamp with time zone not null default now(),
  primary key (kind, file_id)
);

-- Only the server (service key) touches this table.
alter table public.library_titles enable row level security;
