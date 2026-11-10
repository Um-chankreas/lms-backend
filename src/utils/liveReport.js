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
const GRACE_MINUTES = Number(process.env.LIVE_SCHEDULE_GRACE_MIN) || 60;  // a class may start/run this long outside its scheduled time and still count
const PP_MS = 7 * 60 * MIN;       // Cambodia is UTC+7, no daylight saving
const GOAL_HOURS = Number(process.env.LIVE_HOURS_GOAL) || 100;
const REGULAR = 0.75;             // joins at least this share of the classes they could
const SOMETIMES = 0.4;

/**
 * Time a student was in a session, as first join to last leave within each
 * class of it. The join/leave records are often cut short (a dropped
 * connection closes the record while the student is still watching and nothing
 * reopens it), so adding up only the recorded stretches badly under-counts
 * people who were there. Intervals are [from, to, classId].
 */
function presenceMinutes(intervals) {
  const byClass = new Map();
  for (const [a, b, classId] of intervals) {
    if (b <= a) continue;
    const cur = byClass.get(classId);
    if (!cur) byClass.set(classId, [a, b]);
    else { cur[0] = Math.min(cur[0], a); cur[1] = Math.max(cur[1], b); }
  }
  let total = 0;
  byClass.forEach(([a, b]) => { total += b - a; });
  return total / MIN;
}

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


/**
 * Scheduled windows for a course on the Cambodia calendar day of `ms`:
 * [{ from, to }] in epoch ms, from the course's active schedules.
 */
function windowsOn(schedules, ms) {
  const local = new Date(ms + PP_MS);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - PP_MS;
  const weekday = local.getUTCDay();   // 0 = Sunday, like class_schedules.days_of_week
  const at = (t) => { const [h, m] = String(t).split(':').map(Number); return dayStart + ((h || 0) * 60 + (m || 0)) * MIN; };
  return schedules
    .filter(sc => (sc.days_of_week || []).includes(weekday))
    .map(sc => ({ from: at(sc.start_time), to: at(sc.end_time) }));
}
const dayKeyPP = (ms) => new Date(ms + PP_MS).toISOString().slice(0, 10);

const round1 = (n) => Math.round(n * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * courses:      [{ id, title, category }]
 * enrollments:  [{ course_id, student_id, enrolled_at }]
 * students:     [{ id, name, avatar_url }]   (active, non-test)
 * classes:      [{ id, course_id, status, started_at, ended_at }]
 * participants: [{ live_class_id, user_id, joined_at, left_at }]   (students only)
 * schedules:    [{ course_id, days_of_week, start_time, end_time }]   (active class schedules)
 *
 * What counts as "a live class": one session per course per Cambodia day.
 *  - Several classes the same day (the class dropped and the teacher started a
 *    new one) are ONE session; a student's time adds up across all of them.
 *  - When the course has a schedule, a session only counts if it overlaps a
 *    scheduled window (plus/minus GRACE_MINUTES). Test classes outside the
 *    schedule, or on days with no class, are ignored. No schedule: every
 *    class of 5+ minutes counts, still merged per day.
 */
function buildLiveReport({ courses, enrollments, students, classes, participants, schedules = [], now = Date.now(), goalHours = GOAL_HOURS }) {
  const studentById = new Map(students.map(s => [s.id, s]));
  const courseById = new Map(courses.map(c => [c.id, c]));

  // Real classes (long enough), then merged into sessions: course + Cambodia day.
  const schedulesBy = new Map();
  schedules.forEach(sc => {
    if (!schedulesBy.has(sc.course_id)) schedulesBy.set(sc.course_id, []);
    schedulesBy.get(sc.course_id).push(sc);
  });
  const bounds = new Map();      // class id -> [start, end]
  const sessionsByKey = new Map();
  for (const c of classes) {
    const start = toMs(c.started_at);
    if (start == null || !courseById.has(c.course_id)) continue;
    const end = toMs(c.ended_at) ?? (c.status === 'active' ? now : null);
    if (end == null || (end - start) / MIN < MIN_CLASS_MINUTES) continue;
    // With a schedule, a class only counts when it overlaps a scheduled window
    // (plus/minus the grace). A test at 10 am, or a class on a day off, is ignored.
    const sc = schedulesBy.get(c.course_id);
    if (sc && sc.length) {
      const grace = GRACE_MINUTES * MIN;
      if (!windowsOn(sc, start).some(w => start < w.to + grace && end > w.from - grace)) continue;
    }
    const key = `${c.course_id}|${dayKeyPP(start)}`;
    if (!sessionsByKey.has(key)) sessionsByKey.set(key, { id: c.id, course_id: c.course_id, start, end, classIds: [], spans: [] });
    const ses = sessionsByKey.get(key);
    ses.classIds.push(c.id);
    ses.spans.push([start, end]);
    ses.start = Math.min(ses.start, start);
    ses.end = Math.max(ses.end, end);
    bounds.set(c.id, [start, end]);
  }
  const held = [];
  const heldByClassId = new Map();   // any class id -> its session
  for (const ses of sessionsByKey.values()) {
    ses.minutes = unionMinutes(ses.spans);   // real teaching time, restarts and gaps included once
    held.push(ses);
    ses.classIds.forEach(id => heldByClassId.set(id, ses));
  }
  held.sort((a, b) => a.start - b.start);

  // Minutes each student spent in each session (every class of it, clipped to that class).
  const intervals = new Map();   // `${sessionId}|${userId}` -> [[a,b]...]
  for (const p of participants) {
    const ses = heldByClassId.get(p.live_class_id);
    if (!ses || !studentById.has(p.user_id)) continue;
    const [cs, ce] = bounds.get(p.live_class_id);
    const a = Math.max(toMs(p.joined_at) ?? cs, cs);
    const b = Math.min(toMs(p.left_at) ?? ce, ce);
    const key = `${ses.id}|${p.user_id}`;
    if (!intervals.has(key)) intervals.set(key, []);
    intervals.get(key).push([a, b, p.live_class_id]);
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
      const pc = a.perCourse[cls.course_id] || (a.perCourse[cls.course_id] = { minutes: 0, attended: 0, eligible: 0, held: 0, missRun: 0, lastSession: null, last: null });
      pc.eligible += 1;
      pc.lastSession = cls.start;
      pc.missRun += 1;   // reset below when they attend; what is left is the run of most recent misses
      pc.held += cls.minutes;
      a.eligibleMinutes += cls.minutes;
      const mins = presenceMinutes(intervals.get(`${cls.id}|${studentId}`) || []);
      a.minutes += mins;
      a.byCourse[cls.course_id] = (a.byCourse[cls.course_id] || 0) + mins;
      pc.minutes += mins;
      if (mins >= threshold) {
        a.attended += 1;
        pc.attended += 1;
        pc.missRun = 0;
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
      by_course: Object.fromEntries(Object.entries(a.perCourse).map(([k, v]) => [k, { minutes: Math.round(v.minutes), attended: v.attended, eligible: v.eligible, held_minutes: Math.round(v.held), missed_in_a_row: v.missRun, last_session_at: v.lastSession == null ? null : toIso(v.lastSession), last_attended: v.last == null ? null : toIso(v.last) }])),
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
