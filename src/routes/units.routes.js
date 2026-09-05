const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { hasCourseAccess, ensureEnrolled } = require('../utils/access');

/**
 * Units (sections) live inside a chapter (a `lessons` row). See
 * sql/018_lesson_units.sql.
 *
 *   GET    /api/units?lesson_id=       list a chapter's units (titles + preview)
 *   GET    /api/units/search?q=        browse/search units the student can see
 *   GET    /api/units/:id              one unit, full Markdown content
 *   POST   /api/units                  add a unit                         (teacher)
 *   POST   /api/units/bulk             paste a chapter's Markdown, split on `##` (teacher)
 *   POST   /api/units/reorder          { lesson_id, order: [id, ...] }    (teacher)
 *   PUT    /api/units/:id              edit a unit                        (teacher)
 *   DELETE /api/units/:id              remove a unit                      (teacher)
 */

const PREVIEW_LEN = 200;

// Strip Markdown / LaTeX noise down to a short plain-text preview.
const toPreview = (content) => {
  if (!content) return '';
  const text = String(content)
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')       // block math
    .replace(/\$[^$\n]*\$/g, ' ')            // inline math
    .replace(/[#>*_`~\-]{1,}/g, ' ')         // md markers
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_LEN ? text.slice(0, PREVIEW_LEN).trimEnd() + '…' : text;
};

// Split a chapter's Markdown into units on every `## ` heading. Anything
// before the first `##` (the `#` chapter title, `---` rules) is ignored.
//
// A leading "Unit 3:" / "Unit 3 -" / "Unit 3." label is stripped from the
// heading so the stored title is just the real name.
const stripUnitLabel = (title) =>
  title.replace(/^\s*units?\s*\d+\s*[:.)\-–—]\s*/i, '').trim() || title.trim();

const parseUnitsFromMarkdown = (markdown) => {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const units = [];
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.*\S)\s*$/);
    if (heading) {
      if (current) units.push(current);
      current = { title: stripUnitLabel(heading[1]), content: '' };
    } else if (current) {
      current.content += line + '\n';
    }
  }
  if (current) units.push(current);

  return units.map((u, i) => ({
    title: u.title,
    content: u.content
      .replace(/\n*(?:---+|\*\*\*+)\s*$/, '') // trailing horizontal rule
      .trim(),
    order_number: i + 1
  }));
};

// Load a chapter with its parent course. Returns null if not found.
const loadChapter = async (lessonId) => {
  const { data } = await supabase
    .from('lessons')
    .select('id, title, is_free, courses(*)')
    .eq('id', lessonId)
    .single();
  return data || null;
};

const teacherOwnsCourse = (course, user) =>
  !!course && user?.role === 'teacher' && course.teacher_id === user.userId;

const nextOrderNumber = async (lessonId) => {
  const { data } = await supabase
    .from('lesson_units')
    .select('order_number')
    .eq('lesson_id', lessonId)
    .order('order_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.order_number || 0) + 1;
};

/**
 * GET /api/units/search?q=&course_id=
 * Browse / search units. Without course_id, searches the student's enrolled
 * courses plus free courses; with course_id, searches just that course
 * (after an access check).
 */
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const courseId = req.query.course_id ? String(req.query.course_id) : null;

    if (q.length < 2) {
      return res.status(400).json({ success: false, error: 'Search query must be at least 2 characters' });
    }

    // Work out which courses this user may search.
    let courseIds = [];
    if (courseId) {
      const { data: course } = await supabase.from('courses').select('*').eq('id', courseId).single();
      if (!course) return res.status(404).json({ success: false, error: 'Course not found' });
      const access = await hasCourseAccess({ supabase, course, user: req.user });
      if (!access) return res.status(403).json({ success: false, error: 'Enroll in this course to search it' });
      courseIds = [courseId];
    } else if (req.user.role === 'teacher') {
      const { data: owned } = await supabase.from('courses').select('id').eq('teacher_id', req.user.userId);
      courseIds = (owned || []).map(c => c.id);
    } else {
      const [{ data: enrolled }, { data: free }] = await Promise.all([
        supabase.from('course_enrollments').select('course_id').eq('student_id', req.user.userId),
        supabase.from('courses').select('id').eq('is_free', true)
      ]);
      courseIds = [...new Set([...(enrolled || []).map(e => e.course_id), ...(free || []).map(c => c.id)])];
    }

    if (courseIds.length === 0) {
      return res.json({ success: true, data: { units: [] } });
    }

    // chapters in those courses
    const { data: chapters } = await supabase
      .from('lessons')
      .select('id, title, course_id, courses(id, title)')
      .in('course_id', courseIds);

    const chapterById = Object.fromEntries((chapters || []).map(c => [c.id, c]));
    const lessonIds = Object.keys(chapterById);
    if (lessonIds.length === 0) {
      return res.json({ success: true, data: { units: [] } });
    }

    // `,` `(` `)` are PostgREST .or() syntax — drop them from the term.
    const term = q.replace(/[(),]/g, ' ').trim();
    const like = `%${term}%`;
    const { data: units, error } = await supabase
      .from('lesson_units')
      .select('id, lesson_id, title, content, order_number, is_free')
      .in('lesson_id', lessonIds)
      .or(`title.ilike.${like},content.ilike.${like}`)
      .order('order_number', { ascending: true })
      .limit(50);
    if (error) throw error;

    res.json({
      success: true,
      data: {
        units: (units || []).map(u => {
          const chapter = chapterById[u.lesson_id];
          return {
            id: u.id,
            title: u.title,
            preview: toPreview(u.content),
            order_number: u.order_number,
            is_free: u.is_free,
            chapter: chapter ? { id: chapter.id, title: chapter.title } : null,
            course: chapter?.courses ? { id: chapter.courses.id, title: chapter.courses.title } : null
          };
        })
      }
    });
  } catch (error) {
    console.error('Unit search error:', error);
    res.status(500).json({ success: false, error: 'Failed to search units: ' + error.message });
  }
});

/**
 * POST /api/units/reorder   (Teacher)
 * Body: { lesson_id, order: [unitId, unitId, ...] }
 */
router.post('/reorder', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { lesson_id, order } = req.body;
    if (!lesson_id || !Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ success: false, error: 'lesson_id and a non-empty order array are required' });
    }

    const chapter = await loadChapter(lesson_id);
    if (!chapter) return res.status(404).json({ success: false, error: 'Chapter not found' });
    if (!teacherOwnsCourse(chapter.courses, req.user)) {
      return res.status(403).json({ success: false, error: 'You can only edit your own courses' });
    }

    const { data: existing } = await supabase
      .from('lesson_units')
      .select('id')
      .eq('lesson_id', lesson_id);
    const validIds = new Set((existing || []).map(u => u.id));

    await Promise.all(
      order
        .filter(id => validIds.has(id))
        .map((id, idx) =>
          supabase.from('lesson_units').update({ order_number: idx + 1, updated_at: new Date() }).eq('id', id)
        )
    );

    const { data: units } = await supabase
      .from('lesson_units')
      .select('id, title, order_number, is_free')
      .eq('lesson_id', lesson_id)
      .order('order_number', { ascending: true });

    res.json({ success: true, message: 'Units reordered', data: { units } });
  } catch (error) {
    console.error('Unit reorder error:', error);
    res.status(500).json({ success: false, error: 'Failed to reorder units: ' + error.message });
  }
});

/**
 * POST /api/units/bulk   (Teacher)
 * Body: { lesson_id, markdown, replace? }
 * Splits `markdown` into units on each `## ` heading.
 */
router.post('/bulk', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { lesson_id, markdown, replace } = req.body;
    if (!lesson_id || !markdown) {
      return res.status(400).json({ success: false, error: 'lesson_id and markdown are required' });
    }

    const chapter = await loadChapter(lesson_id);
    if (!chapter) return res.status(404).json({ success: false, error: 'Chapter not found' });
    if (!teacherOwnsCourse(chapter.courses, req.user)) {
      return res.status(403).json({ success: false, error: 'You can only edit your own courses' });
    }

    const parsed = parseUnitsFromMarkdown(markdown);
    if (parsed.length === 0) {
      return res.status(400).json({ success: false, error: 'No "## " unit headings found in the markdown' });
    }

    if (replace) {
      await supabase.from('lesson_units').delete().eq('lesson_id', lesson_id);
    }
    const offset = replace ? 0 : (await nextOrderNumber(lesson_id)) - 1;

    const rows = parsed.map(u => ({
      id: uuidv4(),
      lesson_id,
      title: u.title,
      content: u.content,
      order_number: offset + u.order_number,
      is_free: false,
      created_at: new Date(),
      updated_at: new Date()
    }));

    const { data: units, error } = await supabase.from('lesson_units').insert(rows).select('id, title, order_number, is_free');
    if (error) throw error;

    res.status(201).json({
      success: true,
      message: `${units.length} unit(s) ${replace ? 'imported' : 'added'}`,
      data: { units }
    });
  } catch (error) {
    console.error('Unit bulk import error:', error);
    res.status(500).json({ success: false, error: 'Failed to import units: ' + error.message });
  }
});

/**
 * POST /api/units   (Teacher)
 * Body: { lesson_id, title, content?, order_number?, is_free? }
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { lesson_id, title, content, order_number, is_free } = req.body;
    if (!lesson_id || !title) {
      return res.status(400).json({ success: false, error: 'lesson_id and title are required' });
    }

    const chapter = await loadChapter(lesson_id);
    if (!chapter) return res.status(404).json({ success: false, error: 'Chapter not found' });
    if (!teacherOwnsCourse(chapter.courses, req.user)) {
      return res.status(403).json({ success: false, error: 'You can only add units to your own courses' });
    }

    const order = Number.isFinite(parseInt(order_number, 10))
      ? parseInt(order_number, 10)
      : await nextOrderNumber(lesson_id);

    const { data: unit, error } = await supabase
      .from('lesson_units')
      .insert({
        id: uuidv4(),
        lesson_id,
        title,
        content: content || '',
        order_number: order,
        is_free: is_free === true,
        created_at: new Date(),
        updated_at: new Date()
      })
      .select()
      .single();
    if (error) throw error;

    res.status(201).json({ success: true, message: 'Unit created', data: { unit } });
  } catch (error) {
    console.error('Unit create error:', error);
    res.status(500).json({ success: false, error: 'Failed to create unit: ' + error.message });
  }
});

/**
 * GET /api/units?lesson_id=
 * A chapter's units — titles, order and preview. Full `content` only for
 * units the caller can access (course access, or a free unit).
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const lessonId = req.query.lesson_id ? String(req.query.lesson_id) : null;
    if (!lessonId) {
      return res.status(400).json({ success: false, error: 'lesson_id query param is required' });
    }

    const chapter = await loadChapter(lessonId);
    if (!chapter) return res.status(404).json({ success: false, error: 'Chapter not found' });

    await ensureEnrolled({ supabase, course: chapter.courses, user: req.user });
    const courseAccess = await hasCourseAccess({ supabase, course: chapter.courses, user: req.user });

    const { data: units, error } = await supabase
      .from('lesson_units')
      .select('id, title, content, order_number, is_free, updated_at')
      .eq('lesson_id', lessonId)
      .order('order_number', { ascending: true });
    if (error) throw error;

    res.json({
      success: true,
      data: {
        chapter: {
          id: chapter.id,
          title: chapter.title,
          course: chapter.courses ? { id: chapter.courses.id, title: chapter.courses.title } : null
        },
        course_access: courseAccess,
        units: (units || []).map(u => {
          const unlocked = courseAccess || chapter.is_free || u.is_free;
          return {
            id: u.id,
            title: u.title,
            order_number: u.order_number,
            is_free: u.is_free,
            locked: !unlocked,
            preview: toPreview(u.content),
            content: unlocked ? (u.content || '') : null,
            updated_at: u.updated_at
          };
        })
      }
    });
  } catch (error) {
    console.error('Unit list error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch units: ' + error.message });
  }
});

/**
 * GET /api/units/:id
 * One unit with its full Markdown content (access-checked via the course).
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: unit, error } = await supabase
      .from('lesson_units')
      .select('*, lessons(id, title, is_free, courses(*))')
      .eq('id', req.params.id)
      .single();

    if (error || !unit) {
      return res.status(404).json({ success: false, error: 'Unit not found' });
    }

    const chapter = unit.lessons;
    const course = chapter?.courses;

    await ensureEnrolled({ supabase, course, user: req.user });
    const courseAccess = await hasCourseAccess({ supabase, course, user: req.user });
    if (!courseAccess && !chapter?.is_free && !unit.is_free) {
      return res.status(403).json({ success: false, error: 'Enroll in this course to read this unit' });
    }

    res.json({
      success: true,
      data: {
        unit: {
          id: unit.id,
          title: unit.title,
          content: unit.content || '',
          order_number: unit.order_number,
          is_free: unit.is_free,
          updated_at: unit.updated_at,
          chapter: chapter ? { id: chapter.id, title: chapter.title } : null,
          course: course ? { id: course.id, title: course.title } : null
        }
      }
    });
  } catch (error) {
    console.error('Unit fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch unit: ' + error.message });
  }
});

/**
 * PUT /api/units/:id   (Teacher)
 * Body: { title?, content?, order_number?, is_free? }
 */
router.put('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { data: unit } = await supabase
      .from('lesson_units')
      .select('id, lessons(courses(teacher_id))')
      .eq('id', req.params.id)
      .single();

    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' });
    if (unit.lessons?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You can only edit your own courses' });
    }

    const updates = { updated_at: new Date() };
    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.content !== undefined) updates.content = req.body.content;
    if (req.body.is_free !== undefined) updates.is_free = req.body.is_free === true;
    if (req.body.order_number !== undefined && Number.isFinite(parseInt(req.body.order_number, 10))) {
      updates.order_number = parseInt(req.body.order_number, 10);
    }

    const { data: updated, error } = await supabase
      .from('lesson_units')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, message: 'Unit updated', data: { unit: updated } });
  } catch (error) {
    console.error('Unit update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update unit: ' + error.message });
  }
});

/**
 * DELETE /api/units/:id   (Teacher)
 */
router.delete('/:id', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { data: unit } = await supabase
      .from('lesson_units')
      .select('id, lessons(courses(teacher_id))')
      .eq('id', req.params.id)
      .single();

    if (!unit) return res.status(404).json({ success: false, error: 'Unit not found' });
    if (unit.lessons?.courses?.teacher_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'You can only edit your own courses' });
    }

    const { error } = await supabase.from('lesson_units').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, message: 'Unit removed' });
  } catch (error) {
    console.error('Unit delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete unit: ' + error.message });
  }
});

module.exports = router;
