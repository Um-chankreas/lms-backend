-- The Library tab: standalone reading material, independent of the course
-- path. A book is just a PDF in the existing public `course-materials`
-- bucket plus the metadata needed to show it on a shelf — storage filenames
-- carry none of that (they sanitize down to `<uuid>-<ts>-_.pdf`), and the
-- PDFs are scans with no text layer, so nothing can be derived at read time.
--
-- Unlike lessons.file_url these aren't tied to a chapter: students browse and
-- read them freely. Uploading is still manual until the portal grows a screen
-- for it — see books.routes.js.

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  -- The English title printed under the Khmer one on the page itself.
  subtitle text,
  subject text not null,
  -- Where the book comes from, shown as the shelf's byline.
  source text,
  -- Path inside the `course-materials` bucket, same convention as
  -- lessons.file_url (no leading slash, no public-URL prefix).
  file_url text not null,
  cover_url text,
  page_count integer,
  order_number integer not null default 0,
  is_published boolean not null default true,
  created_at timestamp with time zone not null default now()
);

create index if not exists books_shelf_idx
  on public.books (subject, order_number);

-- The three Preah Sisowath algebra chapters already sitting in
-- course-materials/pdfs. A fourth file,
-- pdfs/b1aebd2f-...-1787628513149-_.pdf, is a duplicate upload of the
-- differential-equations one 18 seconds earlier and is deliberately left out.
insert into public.books (title, subtitle, subject, source, file_url, cover_url, page_count, order_number)
values
  ('មេរៀនទី១ ចំនួនកុំផ្លិច', 'Complex Numbers', 'គណិតវិទ្យា', 'វិទ្យាល័យព្រះស៊ីសុវត្ថិ',
   'pdfs/e5928ad1-97c0-4611-97b9-20ed98c70f35-1787624795860-_.pdf',
   'book-covers/complex-numbers.jpg', 25, 1),
  ('មេរៀនទី២ លីមីតនៃអនុគមន៍', 'Limit of Functions', 'គណិតវិទ្យា', 'វិទ្យាល័យព្រះស៊ីសុវត្ថិ',
   'pdfs/d71c3d45-eec2-4382-8099-e493b91ad8c7-1787627479168-_.pdf',
   'book-covers/limit-of-functions.jpg', 28, 2),
  ('មេរៀនទី៦ សមីការឌីផេរ៉ង់ស្យែល', 'Differential Equations', 'គណិតវិទ្យា', 'វិទ្យាល័យព្រះស៊ីសុវត្ថិ',
   'pdfs/1480bcb7-b07e-49de-812a-adee6d47ea32-1787628531902-_.pdf',
   'book-covers/differential-equations.jpg', 61, 3)
on conflict do nothing;
