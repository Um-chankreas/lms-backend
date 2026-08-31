-- Student profile screen: a free-text bio, plus lesson-milestone badges
-- ("First Step", "Quick Learner", "Knowledge Seeker") added to the catalog.

alter table public.users
  add column if not exists bio text;

insert into public.badges (code, label, description) values
  ('first_step',       'First Step',       'Complete your first lesson'),
  ('quick_learner',    'Quick Learner',    'Complete 5 lessons'),
  ('knowledge_seeker', 'Knowledge Seeker', 'Complete 10 lessons')
on conflict (code) do nothing;
