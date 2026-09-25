const supabase = require('../config/supabase');

// Most timestamp columns are `timestamp without time zone` holding UTC
// wall-clock time (written as `new Date()`), so PostgREST returns them with no
// offset and `new Date(s)` would read them as server-local time. These treat
// an offset-less timestamp as UTC; a bare 'YYYY-MM-DD' is UTC midnight.
function toMs(ts) {
  if (ts == null || ts === '') return null;
  if (ts instanceof Date) return ts.getTime();
  const s = String(ts);
  const hasZone = s.length <= 10 || /(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/.test(s);
  const ms = Date.parse(hasZone ? s : `${s}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ts) {
  const ms = toMs(ts);
  return ms == null ? null : new Date(ms).toISOString();
}

// PostgREST caps one response at 1000 rows; page through anything that can
// outgrow that. `build` must return a fresh query each call, ordered on a
// unique key so pages don't overlap or skip rows.
async function fetchAllRows(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

// `.in()` filters travel in the URL, so a long id list is split into chunks
// (each fully paged). `build(chunk)` must return a fresh query.
async function fetchAllIn(ids, build, chunkSize = 150) {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    out.push(...(await fetchAllRows(() => build(chunk))));
  }
  return out;
}

/**
 * Where each student is in each course, using the same rules as the student
 * app's home screen (routes/dashboard.routes.js):
 *   - progress % is unit-level (a unit-less chapter counts as one unit, done
 *     when the chapter is complete);
 *   - the current chapter is the first one, in playback order, without a
 *     lesson_completions row; inside it, the current unit is the first unit
 *     (by order_number) not yet read. A chapter whose units are all read but
 *     isn't complete yet is waiting on its quizzes (step: 'quiz').
 *
 * Returns { lessonsByCourse, unitsByLesson, get(studentId, courseId) } where
 * get() returns { units_done, units_total, percentage, lessons_done,
 *   lessons_total, current, last_progress_at, path }. `current` is null once
 *   every chapter is complete. Lessons and units load even with no students,
 *   so a class roster can still list its chapters.
 */
async function courseProgress({ courseIds, studentIds }) {
  const lessonsByCourse = new Map(courseIds.map(id => [id, []]));
  const unitsByLesson = new Map();
  if (courseIds.length === 0) {
    return { lessonsByCourse, unitsByLesson, get: () => null };
  }

  const lessons = await fetchAllIn(courseIds, chunk => supabase
    .from('lessons')
    .select('id, course_id, title, order_number, created_at')
    .in('course_id', chunk)
    .order('order_number', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }));
  // Chunks come back ordered on their own; restore one global playback order.
  // Null order_number sorts last, as Postgres does for the student app.
  // (Infinity - Infinity is NaN, which falls through to the tie-breakers.)
  const ord = v => v ?? Infinity;
  lessons.sort((a, b) =>
    (ord(a.order_number) - ord(b.order_number))
    || String(a.created_at).localeCompare(String(b.created_at))
    || String(a.id).localeCompare(String(b.id)));
  lessons.forEach(l => lessonsByCourse.get(l.course_id)?.push(l));

  const lessonIds = lessons.map(l => l.id);
  const units = await fetchAllIn(lessonIds, chunk => supabase
    .from('lesson_units')
    .select('id, lesson_id, title, order_number')
    .in('lesson_id', chunk)
    .order('id', { ascending: true }));
  units.sort((a, b) => (a.order_number ?? 0) - (b.order_number ?? 0));
  units.forEach(u => {
    if (!unitsByLesson.has(u.lesson_id)) unitsByLesson.set(u.lesson_id, []);
    unitsByLesson.get(u.lesson_id).push(u);
  });

  // Completions are filtered by student only (then narrowed in JS) so the
  // URL never carries the course's whole lesson/unit id list.
  const lessonIdSet = new Set(lessonIds);
  const unitIdSet = new Set(units.map(u => u.id));
  const [lessonDone, unitDone] = await Promise.all([
    fetchAllIn(studentIds, chunk => supabase
      .from('lesson_completions')
      .select('id, student_id, lesson_id, completed_at')
      .in('student_id', chunk)
      .order('id', { ascending: true })),
    fetchAllIn(studentIds, chunk => supabase
      .from('unit_completions')
      .select('id, student_id, unit_id, completed_at')
      .in('student_id', chunk)
      .order('id', { ascending: true })),
  ]);

  // studentId -> Map(id -> completed_at)
  const index = (rows, key, allowed) => {
    const out = new Map();
    rows.forEach(r => {
      if (!allowed.has(r[key])) return;
      if (!out.has(r.student_id)) out.set(r.student_id, new Map());
      out.get(r.student_id).set(r[key], r.completed_at);
    });
    return out;
  };
  const lessonsDoneBy = index(lessonDone, 'lesson_id', lessonIdSet);
  const unitsDoneBy = index(unitDone, 'unit_id', unitIdSet);

  const EMPTY = new Map();
  const get = (studentId, courseId) => {
    const list = lessonsByCourse.get(courseId) || [];
    const doneLessons = lessonsDoneBy.get(studentId) || EMPTY;
    const doneUnits = unitsDoneBy.get(studentId) || EMPTY;

    let unitsDone = 0, unitsTotal = 0, lessonsDone = 0;
    let current = null;
    // lesson_completions and unit_completions use different timestamp types
    // (with / without zone), so compare them as instants, not strings.
    let lastMs = null;
    const bump = (ts) => { const ms = toMs(ts); if (ms != null && (lastMs == null || ms > lastMs)) lastMs = ms; };

    const path = list.map((lesson, i) => {
      const lessonUnits = unitsByLesson.get(lesson.id) || [];
      const lessonComplete = doneLessons.has(lesson.id);
      bump(doneLessons.get(lesson.id));
      if (lessonComplete) lessonsDone += 1;

      let uDone, uTotal;
      if (lessonUnits.length > 0) {
        uDone = lessonUnits.filter(u => doneUnits.has(u.id)).length;
        uTotal = lessonUnits.length;
        lessonUnits.forEach(u => bump(doneUnits.get(u.id)));
      } else {
        uDone = lessonComplete ? 1 : 0;
        uTotal = 1;
      }
      unitsDone += uDone;
      unitsTotal += uTotal;

      if (!current && !lessonComplete) {
        const idx = lessonUnits.findIndex(u => !doneUnits.has(u.id));
        const unit = idx >= 0 ? lessonUnits[idx] : null;
        current = {
          lesson_id: lesson.id,
          lesson_title: lesson.title,
          lesson_index: i + 1,
          unit_id: unit?.id || null,
          unit_title: unit?.title || null,
          unit_index: unit ? idx + 1 : null,
          units_in_lesson: lessonUnits.length,
          // 'unit' = reading a unit, 'quiz' = units read, quizzes pending,
          // 'lesson' = chapter has no units (manual mark-complete)
          step: unit ? 'unit' : lessonUnits.length > 0 ? 'quiz' : 'lesson',
        };
      }

      return {
        lesson_id: lesson.id,
        title: lesson.title,
        done: lessonComplete,
        units_done: uDone,
        units_total: uTotal,
      };
    });

    // Stays at 99 until every unit is read and every chapter is complete
    // (199/200 would otherwise round up, and a chapter with all units read
    // but quizzes pending would otherwise show 100%).
    const percentage = unitsTotal > 0
      ? Math.min(Math.round((unitsDone / unitsTotal) * 100), unitsDone === unitsTotal && current === null ? 100 : 99)
      : 0;

    return {
      units_done: unitsDone,
      units_total: unitsTotal,
      percentage,
      lessons_done: lessonsDone,
      lessons_total: list.length,
      current,
      last_progress_at: lastMs == null ? null : new Date(lastMs).toISOString(),
      path,
    };
  };

  return { lessonsByCourse, unitsByLesson, get };
}

module.exports = { courseProgress, fetchAllRows, fetchAllIn, toMs, toIso };
