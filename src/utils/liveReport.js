// Timestamps without a zone (Supabase `timestamp` columns) are UTC.
function toMs(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  const str = String(ts);
  const hasZone = str.length <= 10 || /(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str}Z`);
  return Number.isNaN(ms) ? null : ms;
}
const toIso = (ts) => { const ms = toMs(ts); return ms == null ? null : new Date(ms).toISOString(); };

// The dashboard's "Live classes" report: how much live teaching happened and
// how much of it each student actually sat through. Pure function over rows
// already fetched, so it can be tested without a database.

const MIN = 60 * 1000;
const ATTEND_MINUTES = 15;        // a student "attended" a class after this long in it
const MIN_CLASS_MINUTES = 5;      // shorter sessions are accidental starts, not classes
const GOAL_HOURS = Number(process.env.LIVE_HOURS_GOAL) || 100;
const REGULAR = 0.75;             // joins at least this share of the classes they could
const SOMETIMES = 0.4;

/** Total minutes covered by [start, end] intervals, overlaps counted once. */
function unionMinutes(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [a, b] of sorted) {
    if (curEnd == null || a > curEnd) {
      if (curEnd != null) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd != null) total += curEnd - curStart;
  return total / MIN;
}

const round1 = (n) => Math.round(n * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * courses:      [{ id, title, category }]
 * enrollments:  [{ course_id, student_id, enrolled_at }]
 * students:     [{ id, name, avatar_url }]   (active, non-test)
 * classes:      [{ id, course_id, status, started_at, ended_at }]
 * participants: [{ live_class_id, user_id, joined_at, left_at }]   (students only)
 */
function buildLiveReport({ courses, enrollments, students, classes, participants, now = Date.now(), goalHours = GOAL_HOURS }) {
  const studentById = new Map(students.map(s => [s.id, s]));
  const courseById = new Map(courses.map(c => [c.id, c]));

  // Held classes with their real length.
  const held = [];
  for (const c of classes) {
    const start = toMs(c.started_at);
    if (start == null || !courseById.has(c.course_id)) continue;
    const end = toMs(c.ended_at) ?? (c.status === 'active' ? now : null);
    if (end == null) continue;
    const minutes = (end - start) / MIN;
    if (minutes < MIN_CLASS_MINUTES) continue;
    held.push({ id: c.id, course_id: c.course_id, start, end, minutes });
  }
  held.sort((a, b) => a.start - b.start);
  const heldById = new Map(held.map(c => [c.id, c]));

  // Minutes each student spent in each class (clipped to the class window).
  const intervals = new Map();   // `${classId}|${userId}` -> [[a,b]...]
  for (const p of participants) {
    const cls = heldById.get(p.live_class_id);
    if (!cls || !studentById.has(p.user_id)) continue;
    const a = Math.max(toMs(p.joined_at) ?? cls.start, cls.start);
    const b = Math.min(toMs(p.left_at) ?? cls.end, cls.end);
    const key = `${cls.id}|${p.user_id}`;
    if (!intervals.has(key)) intervals.set(key, []);
    intervals.get(key).push([a, b]);
  }

  // Who is in which course, since when.
  const enrolledAt = new Map();   // courseId -> Map(studentId -> ms|null)
  for (const e of enrollments) {
    if (!studentById.has(e.student_id) || !courseById.has(e.course_id)) continue;
    if (!enrolledAt.has(e.course_id)) enrolledAt.set(e.course_id, new Map());
    const m = enrolledAt.get(e.course_id);
    const t = toMs(e.enrolled_at);
    if (!m.has(e.student_id) || (t != null && t < m.get(e.student_id))) m.set(e.student_id, t);
  }
  const allStudentIds = new Set();
  enrolledAt.forEach(m => m.forEach((_, id) => allStudentIds.add(id)));

  const per = new Map();   // studentId -> accumulator
  const acc = (id) => {
    if (!per.has(id)) per.set(id, { minutes: 0, byCourse: {}, perCourse: {}, attended: 0, eligible: 0, eligibleMinutes: 0, last: null });
    return per.get(id);
  };
  allStudentIds.forEach(acc);

  let totalLiveMinutes = 0;
  const courseMinutes = {};
  const attendeesPerClass = [];
  const sharePerClass = [];
  const stays = [];

  for (const cls of held) {
    totalLiveMinutes += cls.minutes;
    courseMinutes[cls.course_id] = (courseMinutes[cls.course_id] || 0) + cls.minutes;
    const threshold = Math.min(ATTEND_MINUTES, cls.minutes * 0.5);
    let eligible = 0;
    let attendees = 0;
    (enrolledAt.get(cls.course_id) || new Map()).forEach((since, studentId) => {
      if (since != null && since > cls.end) return;   // joined the course after this class
      eligible += 1;
      const a = acc(studentId);
      a.eligible += 1;
      const pc = a.perCourse[cls.course_id] || (a.perCourse[cls.course_id] = { minutes: 0, attended: 0, eligible: 0, held: 0, last: null });
      pc.eligible += 1;
      pc.held += cls.minutes;
      a.eligibleMinutes += cls.minutes;
      const mins = unionMinutes(intervals.get(`${cls.id}|${studentId}`) || []);
      a.minutes += mins;
      a.byCourse[cls.course_id] = (a.byCourse[cls.course_id] || 0) + mins;
      pc.minutes += mins;
      if (mins >= threshold) {
        a.attended += 1;
        pc.attended += 1;
        if (pc.last == null || cls.start > pc.last) pc.last = cls.start;
        attendees += 1;
        stays.push(mins);
        if (a.last == null || cls.start > a.last) a.last = cls.start;
      }
    });
    attendeesPerClass.push(attendees);
    if (eligible) sharePerClass.push(attendees / eligible);
  }

  // Per-student rows.
  const rows = [];
  const buckets = { regular: 0, sometimes: 0, rarely: 0, never: 0 };
  let reached = 0;
  per.forEach((a, id) => {
    const s = studentById.get(id);
    if (a.attended > 0) reached += 1;
    if (a.eligible > 0) {
      const rate = a.attended / a.eligible;
      if (a.attended === 0) buckets.never += 1;
      else if (rate >= REGULAR) buckets.regular += 1;
      else if (rate >= SOMETIMES) buckets.sometimes += 1;
      else buckets.rarely += 1;
    }
    rows.push({
      student_id: id,
      name: s.name || null,
      avatar_url: s.avatar_url || null,
      classes_attended: a.attended,
      classes_eligible: a.eligible,
      minutes: Math.round(a.minutes),
      minutes_by_course: Object.fromEntries(Object.entries(a.byCourse).map(([k, v]) => [k, Math.round(v)])),
      by_course: Object.fromEntries(Object.entries(a.perCourse).map(([k, v]) => [k, { minutes: Math.round(v.minutes), attended: v.attended, eligible: v.eligible, held_minutes: Math.round(v.held), last_attended: v.last == null ? null : toIso(v.last) }])),
      share_of_live_time: a.eligibleMinutes ? Math.round((a.minutes / a.eligibleMinutes) * 100) : 0,
      last_attended: a.last == null ? null : toIso(a.last),
    });
  });
  rows.sort((x, y) => y.minutes - x.minutes);

  // Pace: when does the goal land at the current rate?
  const totalHours = totalLiveMinutes / 60;
  const firstStart = held.length ? held[0].start : null;
  let projected = null;
  if (firstStart != null && totalHours > 0 && totalHours < goalHours) {
    const days = Math.max(1, (now - firstStart) / 86400000);
    projected = new Date(now + ((goalHours - totalHours) / (totalHours / days)) * 86400000).toISOString().slice(0, 10);
  }

  return {
    goal_hours: goalHours,
    attend_minutes: ATTEND_MINUTES,
    since: firstStart == null ? null : toIso(firstStart).slice(0, 10),
    classes_held: held.length,
    live_hours: round1(totalHours),
    projected_goal_date: projected,
    hours_by_course: courses
      .filter(c => courseMinutes[c.id])
      .map(c => ({ course_id: c.id, title: c.title, subject: c.category || c.title, hours: round1(courseMinutes[c.id] / 60) })),
    students_total: rows.length,
    reached,
    reached_pct: rows.length ? Math.round((reached / rows.length) * 100) : 0,
    per_class_avg: attendeesPerClass.length ? round1(mean(attendeesPerClass)) : 0,
    per_class_pct: sharePerClass.length ? round1(mean(sharePerClass) * 100) : 0,
    avg_stay_minutes: stays.length ? Math.round(mean(stays)) : 0,
    avg_class_minutes: held.length ? Math.round(mean(held.map(c => c.minutes))) : 0,
    frequency: buckets,
    never_joined: buckets.never,
    students: rows,
  };
}

module.exports = { buildLiveReport, unionMinutes, ATTEND_MINUTES, MIN_CLASS_MINUTES };
