const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticateToken, isAdmin } = require('../middleware/auth');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[0-9]{8,15}$/;
const normalizeEmail = e => String(e).trim().toLowerCase();
const normalizePhone = p => String(p).replace(/[\s\-()]/g, '');

const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isSubscribed = paidUntil => !!paidUntil && paidUntil >= todayYmd();

const publicUser = u => ({
  id: u.id,
  name: u.name,
  email: u.email || null,
  phone: u.phone || null,
  role: u.role,
  avatar_url: u.avatar_url || null,
  xp: u.xp || 0,
  is_active: u.is_active !== false,
  paid_until: u.paid_until || null,
  last_paid_at: u.last_paid_at || null,
  is_paid: isSubscribed(u.paid_until),
  created_at: u.created_at
});

// Teachers have no subscription / XP — a leaner shape than publicUser.
const publicTeacher = (u, courseCount) => ({
  id: u.id,
  name: u.name,
  email: u.email || null,
  phone: u.phone || null,
  role: u.role,
  avatar_url: u.avatar_url || null,
  is_active: u.is_active !== false,
  course_count: courseCount ?? undefined,
  created_at: u.created_at
});

// Every route here is admin-only.
router.use(authenticateToken, isAdmin);

/**
 * GET /api/admin/students
 *   ?search=   name / email / phone (partial, case-insensitive)
 *   ?paid=true|false        filter by active weekly subscription
 *   ?include_inactive=true  include soft-deleted accounts
 *   ?page=1 &limit=20
 */
router.get('/students', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const paidFilter = req.query.paid === 'true' ? true : req.query.paid === 'false' ? false : null;
    const includeInactive = req.query.include_inactive === 'true';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const from = (page - 1) * limit;

    let query = supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, xp, is_active, paid_until, last_paid_at, created_at', { count: 'exact' })
      .eq('role', 'student')
      .order('created_at', { ascending: false });

    if (!includeInactive) query = query.eq('is_active', true);

    // Active subscription = paid_until >= today. Filter at the DB level.
    if (paidFilter === true) query = query.gte('paid_until', todayYmd());
    if (paidFilter === false) query = query.or(`paid_until.is.null,paid_until.lt.${todayYmd()}`);

    if (search) {
      // Keep only characters safe inside a PostgREST or() filter expression.
      const esc = search.replace(/[^a-zA-Z0-9 @._+-]/g, '').trim();
      if (esc) {
        query = query.or(`name.ilike.%${esc}%,email.ilike.%${esc}%,phone.ilike.%${esc}%`);
      }
    }

    const { data: students, count, error } = await query.range(from, from + limit - 1);
    if (error) throw error;

    res.json({
      success: true,
      data: {
        students: (students || []).map(publicUser),
        pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) }
      }
    });
  } catch (error) {
    console.error('Admin list students error:', error);
    res.status(500).json({ success: false, error: 'Failed to list students: ' + error.message });
  }
});

/**
 * POST /api/admin/students
 * Register a new student. body: { name, email?, phone?, password }
 * (email or phone required)
 */
router.post('/students', async (req, res) => {
  try {
    let { name, email, phone, password } = req.body;

    if (!name || !password) {
      return res.status(400).json({ success: false, error: 'Name and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    if (!email && !phone) {
      return res.status(400).json({ success: false, error: 'Email or phone number is required' });
    }

    let normalizedEmail = null;
    if (email) {
      normalizedEmail = normalizeEmail(email);
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({ success: false, error: 'Invalid email address' });
      }
    }

    let normalizedPhone = null;
    if (phone) {
      normalizedPhone = normalizePhone(phone);
      if (!PHONE_REGEX.test(normalizedPhone)) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
      }
    }

    if (normalizedEmail) {
      const { data: dupe } = await supabase.from('users').select('id').eq('email', normalizedEmail).maybeSingle();
      if (dupe) return res.status(409).json({ success: false, error: 'Email already registered' });
    }
    if (normalizedPhone) {
      const { data: dupe } = await supabase.from('users').select('id').eq('phone', normalizedPhone).maybeSingle();
      if (dupe) return res.status(409).json({ success: false, error: 'Phone number already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        id: uuidv4(),
        name,
        email: normalizedEmail,
        phone: normalizedPhone,
        password: hashed,
        role: 'student',
        created_at: new Date()
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ success: true, message: 'Student registered', data: { student: publicUser(newUser) } });
  } catch (error) {
    console.error('Admin create student error:', error);
    res.status(500).json({ success: false, error: 'Failed to register student: ' + error.message });
  }
});

/**
 * GET /api/admin/students/:id
 * Student detail + subscription + the courses they're enrolled in.
 */
router.get('/students/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: student } = await supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, xp, role, is_active, paid_until, last_paid_at, created_at')
      .eq('id', id)
      .eq('role', 'student')
      .maybeSingle();
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const { data: enrollments } = await supabase
      .from('course_enrollments')
      .select('course_id, enrolled_at')
      .eq('student_id', id);

    const courseIds = (enrollments || []).map(e => e.course_id);
    const { data: courses } = courseIds.length
      ? await supabase.from('courses').select('id, title, is_free, live_enabled').in('id', courseIds)
      : { data: [] };
    const courseById = Object.fromEntries((courses || []).map(c => [c.id, c]));

    const enrolledCourses = (enrollments || []).map(e => ({
      course: courseById[e.course_id] || { id: e.course_id },
      enrolled_at: e.enrolled_at
    }));

    res.json({
      success: true,
      data: {
        student: publicUser(student),
        subscription: {
          is_paid: isSubscribed(student.paid_until),
          paid_until: student.paid_until || null,
          last_paid_at: student.last_paid_at || null
        },
        enrolled_courses: enrolledCourses
      }
    });
  } catch (error) {
    console.error('Admin student detail error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch student: ' + error.message });
  }
});

/**
 * PATCH /api/admin/students/:id
 * Update a student. body: { name?, email?, phone?, password?, is_active? }
 */
router.patch('/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { name, email, phone, password } = req.body;

    const { data: student } = await supabase
      .from('users').select('id').eq('id', id).eq('role', 'student').maybeSingle();
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (typeof req.body.is_active === 'boolean') updates.is_active = req.body.is_active;

    if (email !== undefined) {
      if (email === null || email === '') {
        updates.email = null;
      } else {
        const e = normalizeEmail(email);
        if (!EMAIL_REGEX.test(e)) return res.status(400).json({ success: false, error: 'Invalid email address' });
        const { data: dupe } = await supabase.from('users').select('id').eq('email', e).neq('id', id).maybeSingle();
        if (dupe) return res.status(409).json({ success: false, error: 'Email already registered' });
        updates.email = e;
      }
    }

    if (phone !== undefined) {
      if (phone === null || phone === '') {
        updates.phone = null;
      } else {
        const p = normalizePhone(phone);
        if (!PHONE_REGEX.test(p)) return res.status(400).json({ success: false, error: 'Invalid phone number' });
        const { data: dupe } = await supabase.from('users').select('id').eq('phone', p).neq('id', id).maybeSingle();
        if (dupe) return res.status(409).json({ success: false, error: 'Phone number already registered' });
        updates.phone = p;
      }
    }

    if (password !== undefined) {
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
      }
      updates.password = await bcrypt.hash(password, 10);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    const { data: updated, error } = await supabase
      .from('users').update(updates).eq('id', id).select().single();
    if (error) throw error;

    res.json({ success: true, message: 'Student updated', data: { student: publicUser(updated) } });
  } catch (error) {
    console.error('Admin update student error:', error);
    res.status(500).json({ success: false, error: 'Failed to update student: ' + error.message });
  }
});

/**
 * DELETE /api/admin/students/:id
 * Soft delete — deactivates the account (is_active = false). The student can
 * no longer log in and is hidden from lists, but their data is kept and the
 * account can be restored with PATCH { is_active: true }.
 */
router.delete('/students/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: student } = await supabase
      .from('users').select('id').eq('id', id).eq('role', 'student').maybeSingle();
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const { data: updated, error } = await supabase
      .from('users')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, message: 'Student deactivated', data: { student: publicUser(updated) } });
  } catch (error) {
    console.error('Admin delete student error:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate student: ' + error.message });
  }
});

/**
 * POST /api/admin/students/:id/subscription
 * Grant / extend / revoke the student's weekly live-class subscription.
 *
 *   { weeks: 1 }                 -> extend paid_until by 1 week (from today or
 *                                   from the current expiry if still active)
 *   { paid_until: "2026-12-31" } -> set the expiry date explicitly
 *   { paid_until: null }         -> revoke immediately
 *
 * `weeks` and `paid_until` are mutually exclusive; `weeks` defaults to 1 if
 * neither is given.
 */
router.post('/students/:id/subscription', async (req, res) => {
  try {
    const { id } = req.params;
    let { weeks, paid_until } = req.body;

    const { data: student } = await supabase
      .from('users')
      .select('id, paid_until')
      .eq('id', id)
      .eq('role', 'student')
      .maybeSingle();
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const updates = {};

    if (paid_until !== undefined) {
      if (paid_until === null || paid_until === '') {
        updates.paid_until = null;
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_until) || Number.isNaN(Date.parse(paid_until))) {
        return res.status(400).json({ success: false, error: 'paid_until must be "YYYY-MM-DD" or null' });
      } else {
        updates.paid_until = paid_until;
        updates.last_paid_at = new Date();
      }
    } else {
      const n = Number.isFinite(weeks) ? Math.trunc(weeks) : 1;
      if (n < 1 || n > 52) {
        return res.status(400).json({ success: false, error: 'weeks must be between 1 and 52' });
      }
      // Extend from whichever is later: today, or the student's current expiry.
      const today = todayYmd();
      const base = student.paid_until && student.paid_until > today ? student.paid_until : today;
      const d = new Date(base + 'T00:00:00');
      d.setDate(d.getDate() + n * 7);
      updates.paid_until = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      updates.last_paid_at = new Date();
    }

    const { data: updated, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    res.json({
      success: true,
      message: updates.paid_until ? 'Subscription updated' : 'Subscription revoked',
      data: {
        subscription: {
          student_id: id,
          is_paid: isSubscribed(updated.paid_until),
          paid_until: updated.paid_until || null,
          last_paid_at: updated.last_paid_at || null
        }
      }
    });
  } catch (error) {
    console.error('Admin set subscription error:', error);
    res.status(500).json({ success: false, error: 'Failed to update subscription: ' + error.message });
  }
});

// ─────────────────────────── TEACHERS ───────────────────────────
// Same account model as students (users row, bcrypt password, JWT login),
// just role:"teacher". No subscription. Email is required — teachers sign in
// with it, matching POST /api/auth/register. Removal is a soft deactivate;
// their courses and content are left untouched.

/**
 * GET /api/admin/teachers
 *   ?search=                name / email / phone (partial, case-insensitive)
 *   ?include_inactive=true  include deactivated accounts
 *   ?page=1 &limit=20
 * Each row also carries course_count (courses they own).
 */
router.get('/teachers', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const includeInactive = req.query.include_inactive === 'true';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const from = (page - 1) * limit;

    let query = supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, is_active, created_at', { count: 'exact' })
      .eq('role', 'teacher')
      .order('created_at', { ascending: false });

    if (!includeInactive) query = query.eq('is_active', true);

    if (search) {
      const esc = search.replace(/[^a-zA-Z0-9 @._+-]/g, '').trim();
      if (esc) query = query.or(`name.ilike.%${esc}%,email.ilike.%${esc}%,phone.ilike.%${esc}%`);
    }

    const { data: teachers, count, error } = await query.range(from, from + limit - 1);
    if (error) throw error;

    // Course counts for the teachers on this page.
    const ids = (teachers || []).map(t => t.id);
    const countByTeacher = {};
    if (ids.length) {
      const { data: courseRows } = await supabase
        .from('courses').select('teacher_id').in('teacher_id', ids);
      (courseRows || []).forEach(c => {
        countByTeacher[c.teacher_id] = (countByTeacher[c.teacher_id] || 0) + 1;
      });
    }

    res.json({
      success: true,
      data: {
        teachers: (teachers || []).map(t => publicTeacher(t, countByTeacher[t.id] || 0)),
        pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) }
      }
    });
  } catch (error) {
    console.error('Admin list teachers error:', error);
    res.status(500).json({ success: false, error: 'Failed to list teachers: ' + error.message });
  }
});

/**
 * POST /api/admin/teachers
 * body: { name, email, password, phone? }  — email + password required.
 */
router.post('/teachers', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !password) {
      return res.status(400).json({ success: false, error: 'Name and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required for a teacher account' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    let normalizedPhone = null;
    if (phone) {
      normalizedPhone = normalizePhone(phone);
      if (!PHONE_REGEX.test(normalizedPhone)) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
      }
    }

    const { data: emailDupe } = await supabase.from('users').select('id').eq('email', normalizedEmail).maybeSingle();
    if (emailDupe) return res.status(409).json({ success: false, error: 'Email already registered' });
    if (normalizedPhone) {
      const { data: phoneDupe } = await supabase.from('users').select('id').eq('phone', normalizedPhone).maybeSingle();
      if (phoneDupe) return res.status(409).json({ success: false, error: 'Phone number already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        id: uuidv4(),
        name,
        email: normalizedEmail,
        phone: normalizedPhone,
        password: hashed,
        role: 'teacher',
        created_at: new Date()
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ success: true, message: 'Teacher created', data: { teacher: publicTeacher(newUser, 0) } });
  } catch (error) {
    console.error('Admin create teacher error:', error);
    res.status(500).json({ success: false, error: 'Failed to create teacher: ' + error.message });
  }
});

/**
 * GET /api/admin/teachers/:id
 * Teacher detail + the courses they own.
 */
router.get('/teachers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: teacher } = await supabase
      .from('users')
      .select('id, name, email, phone, avatar_url, role, is_active, created_at')
      .eq('id', id)
      .eq('role', 'teacher')
      .maybeSingle();
    if (!teacher) return res.status(404).json({ success: false, error: 'Teacher not found' });

    const { data: courses } = await supabase
      .from('courses')
      .select('id, title, is_free, live_enabled, code, created_at')
      .eq('teacher_id', id)
      .order('created_at', { ascending: false });

    res.json({
      success: true,
      data: {
        teacher: publicTeacher(teacher, (courses || []).length),
        courses: courses || []
      }
    });
  } catch (error) {
    console.error('Admin teacher detail error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch teacher: ' + error.message });
  }
});

/**
 * PATCH /api/admin/teachers/:id
 * body: { name?, email?, phone?, password?, is_active? }
 */
router.patch('/teachers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, password } = req.body;

    const { data: teacher } = await supabase
      .from('users').select('id').eq('id', id).eq('role', 'teacher').maybeSingle();
    if (!teacher) return res.status(404).json({ success: false, error: 'Teacher not found' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (typeof req.body.is_active === 'boolean') updates.is_active = req.body.is_active;

    if (email !== undefined) {
      // A teacher must always keep an email — clearing it is rejected.
      if (email === null || email === '') {
        return res.status(400).json({ success: false, error: 'A teacher account must have an email' });
      }
      const e = normalizeEmail(email);
      if (!EMAIL_REGEX.test(e)) return res.status(400).json({ success: false, error: 'Invalid email address' });
      const { data: dupe } = await supabase.from('users').select('id').eq('email', e).neq('id', id).maybeSingle();
      if (dupe) return res.status(409).json({ success: false, error: 'Email already registered' });
      updates.email = e;
    }

    if (phone !== undefined) {
      if (phone === null || phone === '') {
        updates.phone = null;
      } else {
        const p = normalizePhone(phone);
        if (!PHONE_REGEX.test(p)) return res.status(400).json({ success: false, error: 'Invalid phone number' });
        const { data: dupe } = await supabase.from('users').select('id').eq('phone', p).neq('id', id).maybeSingle();
        if (dupe) return res.status(409).json({ success: false, error: 'Phone number already registered' });
        updates.phone = p;
      }
    }

    if (password !== undefined) {
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
      }
      updates.password = await bcrypt.hash(password, 10);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    const { data: updated, error } = await supabase
      .from('users').update(updates).eq('id', id).select().single();
    if (error) throw error;

    res.json({ success: true, message: 'Teacher updated', data: { teacher: publicTeacher(updated) } });
  } catch (error) {
    console.error('Admin update teacher error:', error);
    res.status(500).json({ success: false, error: 'Failed to update teacher: ' + error.message });
  }
});

/**
 * DELETE /api/admin/teachers/:id
 * Soft delete — is_active = false. Courses and content the teacher owns are
 * left in place; restore with PATCH { is_active: true }.
 */
router.delete('/teachers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: teacher } = await supabase
      .from('users').select('id').eq('id', id).eq('role', 'teacher').maybeSingle();
    if (!teacher) return res.status(404).json({ success: false, error: 'Teacher not found' });

    const { data: updated, error } = await supabase
      .from('users')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, message: 'Teacher deactivated', data: { teacher: publicTeacher(updated) } });
  } catch (error) {
    console.error('Admin delete teacher error:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate teacher: ' + error.message });
  }
});

/**
 * GET /api/admin/courses
 * Course list with the live-class toggle.
 */
router.get('/courses', async (req, res) => {
  try {
    const { data: courses, error } = await supabase
      .from('courses')
      .select('id, title, is_free, live_enabled, teacher_id, code, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const teacherIds = [...new Set((courses || []).map(c => c.teacher_id))];
    const { data: teachers } = teacherIds.length
      ? await supabase.from('users').select('id, name').in('id', teacherIds)
      : { data: [] };
    const teacherById = Object.fromEntries((teachers || []).map(t => [t.id, t]));

    res.json({
      success: true,
      data: {
        courses: (courses || []).map(c => ({
          id: c.id,
          title: c.title,
          is_free: !!c.is_free,
          live_enabled: c.live_enabled !== false,
          code: c.code,
          teacher: teacherById[c.teacher_id] || { id: c.teacher_id }
        }))
      }
    });
  } catch (error) {
    console.error('Admin list courses error:', error);
    res.status(500).json({ success: false, error: 'Failed to list courses: ' + error.message });
  }
});

/**
 * PATCH /api/admin/courses/:id
 * Toggle whether a course's live classes can be joined at all.
 * body: { live_enabled: boolean }
 */
router.patch('/courses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { live_enabled } = req.body;

    if (typeof live_enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'live_enabled (boolean) is required' });
    }

    const { data: course } = await supabase.from('courses').select('id').eq('id', id).maybeSingle();
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });

    const { data: updated, error } = await supabase
      .from('courses')
      .update({ live_enabled })
      .eq('id', id)
      .select('id, title, is_free, live_enabled')
      .single();
    if (error) throw error;

    res.json({
      success: true,
      message: live_enabled ? 'Live classes enabled for this course' : 'Live classes disabled for this course',
      data: { course: { ...updated, live_enabled: updated.live_enabled !== false, is_free: !!updated.is_free } }
    });
  } catch (error) {
    console.error('Admin toggle course live error:', error);
    res.status(500).json({ success: false, error: 'Failed to update course: ' + error.message });
  }
});

/**
 * GET /api/admin/live-classes
 * Overview of every live class (for the portal's monitoring screen).
 * ?status=active,scheduled  optional filter.
 */
router.get('/live-classes', async (req, res) => {
  try {
    const statusFilter = (req.query.status || '').split(',').map(s => s.trim()).filter(Boolean);

    let query = supabase.from('live_classes').select('*').order('scheduled_at', { ascending: false });
    if (statusFilter.length) query = query.in('status', statusFilter);

    const { data: classes, error } = await query;
    if (error) throw error;

    const courseIds = [...new Set((classes || []).map(c => c.course_id))];
    const teacherIds = [...new Set((classes || []).map(c => c.teacher_id))];
    const [{ data: courses }, { data: teachers }] = await Promise.all([
      courseIds.length ? supabase.from('courses').select('id, title').in('id', courseIds) : Promise.resolve({ data: [] }),
      teacherIds.length ? supabase.from('users').select('id, name').in('id', teacherIds) : Promise.resolve({ data: [] })
    ]);
    const courseById = Object.fromEntries((courses || []).map(c => [c.id, c]));
    const teacherById = Object.fromEntries((teachers || []).map(t => [t.id, t]));

    res.json({
      success: true,
      data: {
        liveClasses: (classes || []).map(c => ({
          id: c.id,
          title: c.title,
          status: c.status,
          scheduled_at: c.scheduled_at,
          started_at: c.started_at,
          ended_at: c.ended_at,
          course: courseById[c.course_id] || { id: c.course_id },
          teacher: teacherById[c.teacher_id] || { id: c.teacher_id }
        }))
      }
    });
  } catch (error) {
    console.error('Admin list live classes error:', error);
    res.status(500).json({ success: false, error: 'Failed to list live classes: ' + error.message });
  }
});

/**
 * GET /api/admin/analytics
 * School-wide teacher dashboard: headline KPIs, weekly signups, and the
 * "most improved" / "at-risk" student lists. All aggregation is in JS over a
 * handful of bulk reads — fine at a single school's scale.
 */
router.get('/analytics', async (req, res) => {
  try {
    const now = new Date();
    const ms = 86400000;
    const daysAgo = (n) => new Date(now.getTime() - n * ms);
    const iso = (d) => d.toISOString();
    const ymd = (d) => d.toISOString().slice(0, 10);
    const d7 = daysAgo(7), d14 = daysAgo(14), d30 = daysAgo(30), d45 = daysAgo(45), d60 = daysAgo(60);
    const WEEKS = 12;
    const mondayOf = (d) => {
      const x = new Date(d); x.setUTCHours(0, 0, 0, 0);
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x;
    };
    const firstWeek = mondayOf(daysAgo(WEEKS * 7));

    const [
      { data: students },
      { data: subs },
      { data: xpRows },
      { data: lessons },
      { data: enrolls },
    ] = await Promise.all([
      supabase.from('users').select('id, name, avatar_url, created_at, is_active, paid_until').eq('role', 'student'),
      supabase.from('quiz_submissions').select('student_id, score, submitted_at').gte('submitted_at', iso(d60)),
      supabase.from('xp_events').select('student_id, created_at').gte('created_at', iso(d45)),
      supabase.from('lesson_completions').select('student_id, completed_at').gte('completed_at', iso(d30)),
      supabase.from('course_enrollments').select('student_id'),
    ]);

    const S = students || [];
    const meta = new Map(S.map(s => [s.id, s]));
    const today = todayYmd();

    // ── KPIs ──────────────────────────────────────────────────────────────
    const countCreatedBetween = (from, to) =>
      S.filter(s => { const c = new Date(s.created_at); return c >= from && c < to; }).length;
    const kpis = {
      total_students: S.length,
      active_eligible: S.filter(s => s.is_active !== false).length,
      new_students_7d: countCreatedBetween(d7, now),
      new_students_prev_7d: countCreatedBetween(d14, d7),
      paid_students: S.filter(s => s.paid_until && s.paid_until >= today).length,
    };

    // ── Last-active (max of any XP event or quiz submission) ──────────────
    const lastActive = new Map();
    const touch = (id, ts) => {
      const cur = lastActive.get(id);
      if (!cur || ts > cur) lastActive.set(id, ts);
    };
    (xpRows || []).forEach(r => touch(r.student_id, r.created_at));
    (subs || []).forEach(r => touch(r.student_id, r.submitted_at));
    const active7 = [...lastActive].filter(([, ts]) => new Date(ts) >= d7).length;
    kpis.active_students_7d = active7;

    // ── Weekly signups (last 12 weeks) + cumulative ──────────────────────
    const weekBuckets = new Map();
    for (let i = 0; i < WEEKS; i++) weekBuckets.set(ymd(new Date(firstWeek.getTime() + i * 7 * ms)), 0);
    let carried = 0;
    S.forEach(s => {
      const c = new Date(s.created_at);
      if (c < firstWeek) { carried += 1; return; }
      const wk = ymd(mondayOf(c));
      if (weekBuckets.has(wk)) weekBuckets.set(wk, weekBuckets.get(wk) + 1);
    });
    let cum = carried;
    const signups_weekly = [...weekBuckets].map(([week, count]) => {
      cum += count;
      return { week, count, cumulative: cum };
    });

    // ── Quiz-score windows: recent (0–30d) vs prior (30–60d) ─────────────
    const recent = new Map(), prior = new Map();
    const push = (map, k, v) => { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };
    const all30 = [], allPrev30 = [];
    (subs || []).forEach(x => {
      const sc = Number(x.score);
      if (!Number.isFinite(sc)) return;
      const t = new Date(x.submitted_at);
      if (t >= d30) { push(recent, x.student_id, sc); all30.push(sc); }
      else if (t >= d60) { push(prior, x.student_id, sc); allPrev30.push(sc); }
    });
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    kpis.avg_quiz_score_30d = all30.length ? Math.round(mean(all30)) : null;
    kpis.avg_quiz_score_prev_30d = allPrev30.length ? Math.round(mean(allPrev30)) : null;

    const trend = new Map();
    new Set([...recent.keys(), ...prior.keys()]).forEach(id => {
      const r = recent.get(id) || [], p = prior.get(id) || [];
      const ra = mean(r), pa = mean(p);
      trend.set(id, { rn: r.length, pn: p.length, ra, pa, delta: (ra != null && pa != null) ? ra - pa : null });
    });

    const most_improved = [...trend]
      .filter(([, x]) => x.delta != null && x.delta > 2 && x.rn >= 2 && x.pn >= 2)
      .sort((a, b) => b[1].delta - a[1].delta)
      .slice(0, 8)
      .map(([id, x]) => ({
        student_id: id,
        name: meta.get(id)?.name || null,
        avatar_url: meta.get(id)?.avatar_url || null,
        recent_avg: Math.round(x.ra),
        prior_avg: Math.round(x.pa),
        delta: Math.round(x.delta),
        quizzes: x.rn + x.pn,
      }));

    // ── At-risk ─────────────────────────────────────────────────────────
    const enrolledSet = new Set((enrolls || []).map(e => e.student_id));
    const finishedLesson14 = new Set((lessons || []).filter(l => new Date(l.completed_at) >= d14).map(l => l.student_id));
    const atRisk = [];
    S.forEach(s => {
      if (s.is_active === false || !enrolledSet.has(s.id)) return;
      const la = lastActive.get(s.id) || null;
      const daysIdle = la ? Math.floor((now - new Date(la)) / ms) : null;
      const tr = trend.get(s.id);
      let reason = null, sev = 0;
      if (tr && tr.delta != null && tr.delta <= -8 && tr.rn >= 2 && tr.pn >= 2) { reason = 'declining'; sev = 4 + Math.min(-tr.delta / 20, 1); }
      else if (daysIdle != null && daysIdle >= 10) { reason = 'inactive'; sev = 3 + Math.min(daysIdle / 30, 1); }
      else if (daysIdle != null && daysIdle >= 7) { reason = 'slowing'; sev = 2.5; }
      else if (la && daysIdle >= 3 && !finishedLesson14.has(s.id)) { reason = 'stuck'; sev = 2; }
      else if (!la && new Date(s.created_at) < d7) { reason = 'never_started'; sev = 1.5; }
      if (reason) {
        atRisk.push({
          student_id: s.id,
          name: meta.get(s.id)?.name || null,
          avatar_url: meta.get(s.id)?.avatar_url || null,
          reason,
          last_active: la,
          days_inactive: daysIdle,
          recent_avg: tr?.ra != null ? Math.round(tr.ra) : null,
          delta: tr?.delta != null ? Math.round(tr.delta) : null,
          _sev: sev,
        });
      }
    });
    atRisk.sort((a, b) => b._sev - a._sev);

    res.json({
      success: true,
      data: {
        kpis,
        signups_weekly,
        most_improved,
        at_risk: atRisk.slice(0, 20).map(({ _sev, ...x }) => x),
        at_risk_total: atRisk.length,
        generated_at: iso(now),
      },
    });
  } catch (error) {
    console.error('Admin analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to load analytics: ' + error.message });
  }
});

module.exports = router;
