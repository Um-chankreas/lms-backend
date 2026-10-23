const supabase = require('../config/supabase');
const { courseProgress, fetchAllIn, toMs } = require('./studentProgress');
const { XP_VALUES } = require('./xp');
const { formatDay, formatClock } = require('./notificationCopy');
const {
  sendNudges, cambodiaNow, cambodiaDateOf, daysBetween, loadActivity, loadStreaks,
} = require('./nudges');

// The automatic nudge jobs (Notification System v2). Each one finds the
// students it applies to and hands them to nudges.sendNudges(), which enforces
// quiet hours, the daily cap, priority, rotation and back-off.
// Timing lives in dailyDigestScheduler.js.

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const COMEBACK_DAYS = [3, 7, 14];
const REMINDER_MAX_DAYS = 13;       // studied within the last 14 days (day 14 gets the last comeback)
const CHAMPION_MIN_SCORE = 60;      // only work finished with 60%+ counts for the champion
const DUE_SOON_FROM_H = 12;
const DUE_SOON_TO_H = 24;

const activeStudents = async () => {
  const { data } = await supabase.from('users').select('id, name').eq('role', 'student').eq('is_active', true);
  return data || [];
};

/**
 * Given name for display. Khmer names are written family name first, so for a
 * Khmer-script name with several parts the last part is used; otherwise the
 * first part (the spec's "first name only").
 */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  return /[ក-៿]/.test(parts[0]) ? parts[parts.length - 1] : parts[0];
}

// ── 3.4 assignment_due_soon: every hour, due 12-24h from now ────────────
async function runAssignmentDueSoon(now = new Date()) {
  const from = new Date(now.getTime() + DUE_SOON_FROM_H * HOUR_MS).toISOString();
  const to = new Date(now.getTime() + DUE_SOON_TO_H * HOUR_MS).toISOString();
  const { data: assignments } = await supabase
    .from('assignments')
    .select('id, title, due_date, course_id')
    .eq('status', 'published')
    .gt('due_date', from)
    .lte('due_date', to);
  if (!assignments || assignments.length === 0) return { sent: 0 };

  const courseIds = [...new Set(assignments.map(a => a.course_id))];
  const [enrollments, submissions] = await Promise.all([
    fetchAllIn(courseIds, chunk => supabase.from('course_enrollments').select('id, student_id, course_id').in('course_id', chunk).order('id', { ascending: true })),
    fetchAllIn(assignments.map(a => a.id), chunk => supabase.from('assignment_submissions').select('id, student_id, assignment_id').in('assignment_id', chunk).order('id', { ascending: true })),
  ]);
  const submitted = new Set(submissions.map(s => `${s.student_id}:${s.assignment_id}`));

  // Who we already told about which assignment (it is only ever sent once).
  const studentIds = [...new Set(enrollments.map(e => e.student_id))];
  const told = await fetchAllIn(studentIds, chunk => supabase
    .from('notifications')
    .select('id, user_id, data')
    .in('user_id', chunk)
    .eq('template_key', 'assignment_due_soon')
    .gte('created_at', new Date(now.getTime() - 3 * DAY_MS).toISOString())
    .order('id', { ascending: true }));
  const toldKeys = new Set(told.map(t => `${t.user_id}:${t.data?.assignment_id}`));

  // One per student: the assignment due soonest that they haven't submitted.
  const byAssignment = new Map(assignments.map(a => [a.id, a]));
  const pick = new Map();
  enrollments.forEach(e => {
    byAssignment.forEach(a => {
      if (a.course_id !== e.course_id) return;
      const key = `${e.student_id}:${a.id}`;
      if (submitted.has(key) || toldKeys.has(key)) return;
      const cur = pick.get(e.student_id);
      if (!cur || toMs(a.due_date) < toMs(cur.due_date)) pick.set(e.student_id, a);
    });
  });

  const todayDate = cambodiaNow(now).dateStr;
  const items = [...pick].map(([userId, a]) => ({
    userId,
    type: 'assignment_due_soon',
    vars: (lang) => ({ assignmentTitle: a.title, xp: XP_VALUES.ASSIGNMENT_ONTIME, dueDate: formatDay(a.due_date, lang), time: formatClock(a.due_date) }),
    groups: cambodiaDateOf(toMs(a.due_date)) === todayDate ? ['today'] : ['tomorrow'],
    data: { assignment_id: a.id, assignment_title: a.title, course_id: a.course_id, due_date: a.due_date },
  }));
  return sendNudges('assignment_due_soon', items, { now });
}

// ── 3.1 daily_reminder / 3.6 comeback: 17:00 ────────────────────────────
/**
 * Where each of these students should continue: { nextLessonTitle, lessonMinutes }
 * from the first unfinished chapter of the course they were most recently
 * working in. Either value can be null (finished course, no video length).
 */
async function nextLessons(studentIds) {
  const out = new Map();
  if (studentIds.length === 0) return out;
  const enrollments = await fetchAllIn(studentIds, chunk => supabase
    .from('course_enrollments').select('id, student_id, course_id').in('student_id', chunk).order('id', { ascending: true }));
  const courseIds = [...new Set(enrollments.map(e => e.course_id))];
  if (courseIds.length === 0) return out;
  const progress = await courseProgress({ courseIds, studentIds });

  const pickedLesson = new Map();   // student -> { lessonId, title }
  studentIds.forEach(sid => {
    let best = null;
    enrollments.filter(e => e.student_id === sid).forEach(e => {
      const p = progress.get(sid, e.course_id);
      if (!p || !p.current) return;
      const at = toMs(p.last_progress_at) ?? 0;
      if (!best || at > best.at) best = { at, lessonId: p.current.lesson_id, title: p.current.lesson_title };
    });
    if (best) pickedLesson.set(sid, best);
  });

  const lessonIds = [...new Set([...pickedLesson.values()].map(b => b.lessonId))];
  const lessons = lessonIds.length
    ? await fetchAllIn(lessonIds, chunk => supabase.from('lessons').select('id, duration_seconds').in('id', chunk).order('id', { ascending: true }))
    : [];
  const seconds = new Map(lessons.map(l => [l.id, l.duration_seconds]));
  pickedLesson.forEach((b, sid) => {
    const s = seconds.get(b.lessonId);
    out.set(sid, { nextLessonTitle: b.title || null, lessonMinutes: s && s > 0 ? Math.max(1, Math.ceil(s / 60)) : null });
  });
  return out;
}

async function runDailyReminders(now = new Date()) {
  const cn = cambodiaNow(now);
  const students = await activeStudents();
  const ids = students.map(s => s.id);
  if (ids.length === 0) return { sent: 0 };

  const [activity, streaks] = await Promise.all([
    loadActivity(ids, now.getTime() - 35 * DAY_MS),
    loadStreaks(ids, now),
  ]);

  // Day-of-silence per student: 0 = studied today.
  const silence = new Map();
  ids.forEach(id => {
    const list = activity.get(id);
    if (!list || list.length === 0) return;   // never studied: no reminders
    silence.set(id, daysBetween(cambodiaDateOf(list[list.length - 1]), cn.dateStr));
  });

  const comebackIds = ids.filter(id => COMEBACK_DAYS.includes(silence.get(id)));
  const reminderIds = ids.filter(id => {
    const d = silence.get(id);
    return d != null && d >= 1 && d <= REMINDER_MAX_DAYS && !COMEBACK_DAYS.includes(d);
  });

  const where = await nextLessons([...comebackIds, ...reminderIds]);
  const lessonVars = (id) => ({
    nextLessonTitle: where.get(id)?.nextLessonTitle ?? null,
    lessonMinutes: where.get(id)?.lessonMinutes ?? null,
  });

  const comeback = await sendNudges('comeback', comebackIds.map(userId => ({
    userId,
    vars: { ...lessonVars(userId) },
    // Day 3 / 7 / 14 copy; the plain variants cover a missing lesson title or length.
    groups: [String(silence.get(userId))],
    data: { days_inactive: silence.get(userId) },
  })), { now });

  const reminder = await sendNudges('daily_reminder', reminderIds.map(userId => {
    const st = streaks.get(userId);
    const streak = st && st.alive ? st.streak : 0;
    return {
      userId,
      vars: { ...lessonVars(userId), streak: streak || null, streakNext: streak + 1, curiosityQuestion: null },
      groups: streak >= 1 ? ['A'] : ['B'],
      data: { streak, day: cn.dateStr },
    };
  }), { now });

  return { comeback, reminder };
}

// ── 3.2 streak_at_risk: 20:30 ───────────────────────────────────────────
async function runStreakAtRisk(now = new Date()) {
  const students = await activeStudents();
  const ids = students.map(s => s.id);
  const streaks = await loadStreaks(ids, now);
  const items = ids
    .filter(id => { const st = streaks.get(id); return st && st.alive && st.streak >= 3 && !st.doneToday; })
    .map(userId => ({
      userId,
      vars: { streak: streaks.get(userId).streak },
      groups: ['std'],   // there is no streak pass / freeze yet, so the "pass" copy never applies
      data: { streak: streaks.get(userId).streak },
    }));
  return sendNudges('streak_at_risk', items, { now });
}

// ── 3.7 daily_champion: 20:00 ───────────────────────────────────────────
/** Lessons + quizzes + practice sets finished today with 60%+, per student. */
async function countChampionWork(startMs) {
  const since = new Date(startMs).toISOString();
  const [lessons, quizzes, attempts] = await Promise.all([
    supabase.from('lesson_completions').select('student_id').gte('completed_at', since),
    supabase.from('quiz_submissions').select('student_id, score').gte('submitted_at', since),
    supabase.from('daily_challenge_attempts').select('student_id, score').gte('created_at', since),
  ]);
  const counts = new Map();
  const bump = (id) => { if (id) counts.set(id, (counts.get(id) || 0) + 1); };
  (lessons.data || []).forEach(r => bump(r.student_id));
  (quizzes.data || []).forEach(r => { if (Number(r.score) >= CHAMPION_MIN_SCORE) bump(r.student_id); });
  (attempts.data || []).forEach(r => { if (Number(r.score) >= CHAMPION_MIN_SCORE) bump(r.student_id); });
  return counts;
}

async function runDailyChampion(now = new Date()) {
  const cn = cambodiaNow(now);
  const students = await activeStudents();
  const ids = students.map(s => s.id);
  const [counts, activity] = await Promise.all([
    countChampionWork(cn.startMs),
    loadActivity(ids, cn.startMs),
  ]);

  const studiedToday = new Set(ids.filter(id => (activity.get(id) || []).length > 0));
  const eligible = [...counts].filter(([id, n]) => n > 0 && studiedToday.has(id));
  if (eligible.length === 0) return { sent: 0 };
  const nameOf = new Map(students.map(s => [s.id, s.name]));
  eligible.sort((a, b) => b[1] - a[1] || String(nameOf.get(a[0])).localeCompare(String(nameOf.get(b[0]))));
  const [championId, championCount] = eligible[0];
  const championName = shortName(nameOf.get(championId));

  try {
    await supabase.from('daily_digest_log').upsert({ day: cn.dateStr, champion_student_id: championId, champion_count: championCount }, { onConflict: 'day' });
  } catch { /* the log is only a record */ }

  const countText = (lang, n) => (lang === 'en' ? (n === 1 ? '1 lesson or quiz' : `${n} lessons and quizzes`) : String(n));
  const items = [
    { userId: championId, groups: ['champion'], vars: { count: championCount }, data: { student_id: championId, count: championCount, day: cn.dateStr } },
    ...[...studiedToday].filter(id => id !== championId).map(userId => ({
      userId,
      groups: ['others'],
      vars: (lang) => ({
        championName,
        countText: countText(lang, championCount),
        myCount: counts.get(userId) || null,   // 0 -> the "you did N" line is skipped
      }),
      data: { student_id: championId, count: championCount, day: cn.dateStr },
    })),
  ];
  return sendNudges('daily_champion', items, { now });
}

module.exports = { runAssignmentDueSoon, runDailyReminders, runStreakAtRisk, runDailyChampion, shortName, nextLessons };
