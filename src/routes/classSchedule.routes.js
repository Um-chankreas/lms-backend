const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { requireFeature } = require('../utils/permissions');
const { v4: uuidv4 } = require('uuid');

// Recurring weekly schedule slots for a course's live classes (see
// sql/039_class_schedules.sql). Distinct from live_classes: a schedule is a
// pattern ("every Mon/Wed 3-4:30pm"), not a session a student can join —
// the teacher still creates/starts an actual live_classes row per session.
// The reminder cron (src/utils/classScheduler.js) reads these to know when
// to notify.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Every route here needs the 'schedule' feature (see src/utils/permissions.js)
// — no student-facing client reads this today, so gating the whole router is
// safe.
router.use(authenticateToken, requireFeature('schedule'));

function validateSchedulePayload({ days_of_week, start_time, end_time, timezone }) {
  if (!Array.isArray(days_of_week) || days_of_week.length === 0) {
    return 'days_of_week must be a non-empty array of 0 (Sun) - 6 (Sat)';
  }
  if (days_of_week.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return 'days_of_week values must be integers 0-6';
  }
  if (!TIME_RE.test(start_time || '') || !TIME_RE.test(end_time || '')) {
    return 'start_time/end_time must be "HH:MM" (24h)';
  }
  if (start_time >= end_time) {
    return 'start_time must be before end_time';
  }
  if (timezone !== undefined && typeof timezone !== 'string') {
    return 'timezone must be a string';
  }
  return null;
}

async function loadOwnedCourse(courseId, teacherId) {
  const { data: course } = await supabase
    .from('courses')
    .select('id, teacher_id, title')
    .eq('id', courseId)
    .maybeSingle();
  if (!course) return { error: { status: 404, message: 'Course not found' } };
  if (course.teacher_id !== teacherId) {
    return { error: { status: 403, message: 'You can only manage schedules for your own courses' } };
  }
  return { course };
}

const present = (row) => ({
  ...row,
  day_labels: (row.days_of_week || []).slice().sort((a, b) => a - b).map((d) => DAY_NAMES[d])
});

/**
 * GET /api/class-schedules/course/:courseId
 * All schedule slots for a course (teacher who owns it, or admin).
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;
    const { data: course } = await supabase
      .from('courses')
      .select('id, teacher_id')
      .eq('id', courseId)
      .maybeSingle();
    if (!course) return res.status(404).json({ success: false, error: 'Course not found' });
    if (req.user.role === 'teacher' && course.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You do not own this course' });
    }

    const { data: schedules, error } = await supabase
      .from('class_schedules')
      .select('*')
      .eq('course_id', courseId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    res.json({ success: true, data: { schedules: (schedules || []).map(present) } });
  } catch (error) {
    console.error('List class schedules error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch schedules: ' + error.message });
  }
});

/**
 * GET /api/class-schedules/mine
 * Every active schedule slot across the teacher's own courses, grouped by
 * course_id — what the "My Classes" list uses to show a schedule badge on
 * each card without a request per course.
 */
router.get('/mine', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { data: schedules, error } = await supabase
      .from('class_schedules')
      .select('*')
      .eq('teacher_id', req.user.userId)
      .eq('is_active', true);
    if (error) throw error;

    res.json({ success: true, data: { schedules: (schedules || []).map(present) } });
  } catch (error) {
    console.error('List my class schedules error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch schedules: ' + error.message });
  }
});

/**
 * POST /api/class-schedules
 * body: { course_id, days_of_week: [0-6,...], start_time: "HH:MM", end_time: "HH:MM", timezone? }
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { course_id, days_of_week, start_time, end_time, timezone } = req.body || {};
    if (!course_id) return res.status(400).json({ success: false, error: 'course_id is required' });

    const validationError = validateSchedulePayload({ days_of_week, start_time, end_time, timezone });
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const { error: ownError } = await loadOwnedCourse(course_id, req.user.userId);
    if (ownError) return res.status(ownError.status).json({ success: false, error: ownError.message });

    const { data: created, error } = await supabase
      .from('class_schedules')
      .insert({
        id: uuidv4(),
        course_id,
        teacher_id: req.user.userId,
        days_of_week,
        start_time,
        end_time,
        timezone: timezone || 'Asia/Phnom_Penh',
        is_active: true
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ success: true, data: { schedule: present(created) } });
  } catch (error) {
    console.error('Create class schedule error:', error);
    res.status(500).json({ success: false, error: 'Failed to create schedule: ' + error.message });
  }
});

/**
 * PUT /api/class-schedules/:id
 * Partial update: any of days_of_week / start_time / end_time / timezone / is_active.
 */
router.put('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: existing } = await supabase
      .from('class_schedules')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Schedule not found' });
    if (existing.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You do not own this schedule' });
    }

    const next = {
      days_of_week: req.body.days_of_week !== undefined ? req.body.days_of_week : existing.days_of_week,
      start_time: req.body.start_time !== undefined ? req.body.start_time : existing.start_time,
      end_time: req.body.end_time !== undefined ? req.body.end_time : existing.end_time,
      timezone: req.body.timezone !== undefined ? req.body.timezone : existing.timezone
    };
    const validationError = validateSchedulePayload(next);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const update = { ...next, updated_at: new Date() };
    if (req.body.is_active !== undefined) update.is_active = !!req.body.is_active;

    const { data: updated, error } = await supabase
      .from('class_schedules')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, data: { schedule: present(updated) } });
  } catch (error) {
    console.error('Update class schedule error:', error);
    res.status(500).json({ success: false, error: 'Failed to update schedule: ' + error.message });
  }
});

/**
 * DELETE /api/class-schedules/:id
 */
router.delete('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: existing } = await supabase
      .from('class_schedules')
      .select('id, teacher_id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Schedule not found' });
    if (existing.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You do not own this schedule' });
    }

    const { error } = await supabase.from('class_schedules').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true, message: 'Schedule removed' });
  } catch (error) {
    console.error('Delete class schedule error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete schedule: ' + error.message });
  }
});

module.exports = router;
