-- The phone number on a student's Telegram account, shared by the student themselves
-- (they tap "Share my phone number" in the bot; Telegram never gives it to bots otherwise).
-- Private like the rest of student_private: staff see it only when the student's
-- telegram_visibility is 'teachers' or 'friends'.
--
-- Run in the Supabase SQL editor (dev and prod), after 064.

alter table public.student_private
  add column if not exists telegram_phone text;
