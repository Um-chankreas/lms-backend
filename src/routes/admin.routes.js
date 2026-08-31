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

module.exports = router;
