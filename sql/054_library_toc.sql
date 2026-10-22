-- Tables of contents for Library books.
--
-- Textbook PDFs are scans with no table of contents of their own. An admin
-- uploads a photo of the book's contents page in the portal, the server reads
-- it (utils/tocExtract.js), the admin corrects it, and the result is saved here
-- for the app's reader to show as chapters.
--
-- `items` is an ordered JSON array of { title, page, level }: level 0 = chapter,
-- 1 = section, 2 = subsection; page = the number PRINTED on the page (or null).
-- `page_offset` converts printed numbers to PDF pages: pdf page = printed + offset
-- (a book whose "page 1" is the 9th sheet has an offset of 8).
-- `file_id` is the filename without ".pdf"; `kind` matches library_titles.

create table if not exists public.library_toc (
  kind text not null check (kind in ('textbook', 'past-paper', 'formula')),
  file_id text not null,
  items jsonb not null default '[]'::jsonb,
  page_offset integer not null default 0,
  updated_at timestamp with time zone not null default now(),
  primary key (kind, file_id)
);

-- Only the server (service key) touches this table.
alter table public.library_toc enable row level security;
