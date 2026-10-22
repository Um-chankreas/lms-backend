-- Introduces the 'super_admin' role (see the permission matrix discussed
-- with the team): super_admin sits above 'admin' — manages admin accounts,
-- system settings/pricing (not built yet), and can start any live class.
-- 'admin' keeps everything it already had (manage teachers/students,
-- payments/enrollment, courses, analytics) plus course creation, which this
-- pass also opens up to admins (see src/routes/courses.routes.js).
--
-- users.role has no CHECK constraint (verified against the dev project —
-- confirm this migration's INSERT succeeds on prod too; if the role column
-- there does have a constraint, this INSERT will fail with a clear error
-- naming it, and that constraint needs widening first).
--
-- Creates the first super_admin account directly (no signup flow issues
-- admin/super_admin accounts). Password below is a bcrypt hash (10 rounds,
-- same as signup) of the password the user chose — never store a plaintext
-- password here, since login does bcrypt.compare(password, users.password)
-- and a non-hash value there can never match.
--
-- Run in the Supabase SQL editor (prod; dev too if you want to test the role
-- there first).

insert into public.users (id, name, email, phone, password, role, created_at)
values (
  gen_random_uuid(),
  'Super Admin',
  'romduolschorlarsuperadmin@gmail.com',
  null,
  '$2b$10$hB2bf7MtXNli1N.PMyN3MurSFuGySKOgsm2JviYH4T1wOnHuNCOR.',
  'super_admin',
  now()
)
on conflict (email) do update set
  role = 'super_admin',
  password = excluded.password,
  name = excluded.name;
