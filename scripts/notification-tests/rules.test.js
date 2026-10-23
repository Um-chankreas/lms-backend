const fake = require('./fake-supabase');
const assert = require('assert');
fake.install({
  'studentProgress': (mod) => ({
    ...mod,
    courseProgress: async ({ courseIds, studentIds }) => ({
      lessonsByCourse: new Map(), unitsByLesson: new Map(),
      get: (sid, cid) => ({ current: { lesson_id: 'L1', lesson_title: sid === 'U2' ? 'Limits' : 'Derivatives', lesson_index: 2 }, last_progress_at: new Date().toISOString() }),
    }),
  }),
});
const ROOT = require('path').join(__dirname, '..', '..', 'src', 'utils') + '/';
const nudges = require(ROOT + 'nudges');
const digest = require(ROOT + 'dailyDigest');
const copy = require(ROOT + 'notificationCopy');

const NOW = new Date('2026-10-23T10:00:00Z');                 // 17:00 in Cambodia
const ago = (days, hours = 0) => new Date(NOW.getTime() - days * 864e5 - hours * 36e5).toISOString();
const notes = () => fake.tables.notifications || [];
const to = (uid) => notes().filter(n => n.user_id === uid);
let pass = 0;
const ok = (name, cond, info) => { if (!cond) { console.log('FAIL', name, info ?? ''); process.exitCode = 1; } else { pass++; console.log('ok  ', name); } };

(async () => {
  // users
  const U = (id, name, language = 'km', style = 'balanced') => fake.add('users', { id, name, role: 'student', is_active: true, language, notification_style: style });
  ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10'].forEach((id, i) => U(id, 'Student ' + id, id === 'U2' ? 'en' : 'km'));
  const act = (uid, ts) => fake.add('lesson_completions', { student_id: uid, completed_at: ts });
  fake.add('course_enrollments', { student_id: 'U1', course_id: 'C' });
  ['U1', 'U2', 'U6', 'U7', 'U8', 'U9', 'U10'].forEach(u => fake.add('course_enrollments', { student_id: u, course_id: 'C' }));
  fake.add('lessons', { id: 'L1', duration_seconds: 600 });
  act('U1', ago(1)); fake.add('daily_challenge_streaks', { student_id: 'U1', current_streak: 4, last_completed_date: '2026-10-22' });
  act('U2', ago(3));
  act('U3', ago(20));
  /* U4 never */
  act('U5', ago(0, 2));                                         // studied 2h ago (today)
  act('U6', ago(2));
  act('U7', ago(1)); fake.add('daily_challenge_streaks', { student_id: 'U7', current_streak: 5, last_completed_date: '2026-10-22' });
  act('U8', ago(1)); fake.add('daily_challenge_streaks', { student_id: 'U8', current_streak: 5, last_completed_date: '2026-10-22' });
  fake.add('notifications', { user_id: 'U8', kind: 'nudge', template_key: 'assignment_due_soon', variant_id: 'a', push_sent: true, created_at: ago(0, 5), data: { assignment_id: 'A0' } });
  // U9: ignored its last 5 nudges, newest 3 days ago.  U10: same, newest 20 hours ago... but unresolved <24h -> not backed off; make it 30h ago
  act('U9', ago(1)); act('U10', ago(1));
  [3, 4, 5, 6, 7].forEach(d => fake.add('notifications', { user_id: 'U9', kind: 'nudge', template_key: 'daily_reminder', variant_id: 'B2', push_sent: true, created_at: ago(d), data: {} }));
  [1.25, 2, 3, 4, 5].forEach(d => fake.add('notifications', { user_id: 'U10', kind: 'nudge', template_key: 'daily_reminder', variant_id: 'B1', push_sent: true, created_at: ago(d), data: {} }));
  // U9/U10 studied "1 day ago" which is AFTER some nudges; make them silent since the newest nudge so back-off applies
  fake.tables.lesson_completions = fake.tables.lesson_completions.filter(r => !(['U9', 'U10'].includes(r.student_id)));
  act('U9', ago(8)); act('U10', ago(8));

  // ── 17:00 job ────────────────────────────────────────────────────────
  const r = await digest.runDailyReminders(NOW);
  console.log('17:00 result', JSON.stringify(r));
  ok('U1 gets a daily_reminder in Khmer (streak group A)', to('U1').length === 1 && to('U1')[0].template_key === 'daily_reminder' && /^A/.test(to('U1')[0].variant_id) && /[ក-៿]/.test(to('U1')[0].title), JSON.stringify(to('U1')));
  ok('U2 (3 days silent, English) gets comeback d3 / d3-plain', to('U2').length === 1 && to('U2')[0].template_key === 'comeback' && /Derivatives|Limits|spot/.test(to('U2')[0].title + to('U2')[0].body) && !/[ក-៿]/.test(to('U2')[0].title), JSON.stringify(to('U2')));
  ok('U3 silent 20 days gets nothing', to('U3').length === 0);
  ok('U4 never studied gets nothing', to('U4').length === 0);
  ok('U5 studied today gets nothing', to('U5').length === 0);
  ok('U6 (no streak) gets group B', to('U6').length === 1 && /^B/.test(to('U6')[0].variant_id), JSON.stringify(to('U6')));
  ok('U7 (streak 5, challenge not done) still gets 17:00 reminder', to('U7').length === 1 && to('U7')[0].template_key === 'daily_reminder');
  ok('U8 already has 1 nudge today + streak slot reserved -> reminder blocked by cap', to('U8').filter(n => n.template_key === 'daily_reminder').length === 0, JSON.stringify(to('U8').map(n => n.template_key)));
  ok('U9 backed off but last nudge 3 days ago -> may get one', to('U9').filter(n => n.created_at && n.template_key === 'daily_reminder').length === 6, to('U9').length);
  ok('U10 backed off and last nudge < 2 days ago -> nothing new', to('U10').length === 5, to('U10').length);
  ok('no variant text contains null/undefined/curly', notes().every(n => !/null|undefined|[{}]/.test(n.title + n.body)), JSON.stringify(notes().filter(n => /null|undefined|[{}]/.test(n.title + n.body))));
  ok('no long dashes', notes().every(n => !/—/.test(n.title + n.body)));
  ok('every new row has template_key, variant_id, kind=nudge', notes().filter(n => n.created_at && typeof n.created_at !== 'string').every(n => n.template_key && n.variant_id && n.kind === 'nudge'));

  // ── 20:30 streak_at_risk ────────────────────────────────────────────
  const NIGHT = new Date('2026-10-23T13:30:00Z');               // 20:30 in Cambodia
  const s = await digest.runStreakAtRisk(NIGHT);
  console.log('20:30 result', JSON.stringify(s));
  ok('U7 (1 nudge today) gets streak_at_risk', to('U7').some(n => n.template_key === 'streak_at_risk'));
  ok('U8 (1 nudge today) gets streak_at_risk', to('U8').some(n => n.template_key === 'streak_at_risk'));
  ok('U1 gets streak_at_risk (that makes its 2nd nudge)', to('U1').filter(n => n.template_key === 'streak_at_risk').length === 1);
  ok('streak_at_risk skipped for streak < 3 (U6)', !to('U6').some(n => n.template_key === 'streak_at_risk'));
  const again = await digest.runStreakAtRisk(NIGHT);
  ok('cap: nobody exceeds 2 nudges today', ['U1', 'U7', 'U8'].every(u => to(u).filter(n => typeof n.created_at !== 'string' || n.created_at >= '2026-10-22T17:00').length <= 2), JSON.stringify(['U1', 'U7', 'U8'].map(u => to(u).length)));

  // ── quiet hours ─────────────────────────────────────────────────────
  const before = notes().length;
  const q = await digest.runStreakAtRisk(new Date('2026-10-23T15:00:00Z'));   // 22:00
  ok('quiet hours: nothing is sent at 22:00', notes().length === before && q.skipped.quiet >= 0, JSON.stringify(q));
  ok('quiet hours edge: 06:29 quiet, 06:30 not', nudges.isQuietHours(new Date('2026-10-22T23:29:00Z')) && !nudges.isQuietHours(new Date('2026-10-22T23:30:00Z')) && nudges.isQuietHours(new Date('2026-10-23T14:30:00Z')) && !nudges.isQuietHours(new Date('2026-10-23T14:29:00Z')));

  // ── rotation ────────────────────────────────────────────────────────
  const ids = new Set();
  for (let i = 0; i < 40; i++) ids.add(copy.renderTemplate('daily_reminder', 'km', { streak: 3, streakNext: 4, nextLessonTitle: 'X', lessonMinutes: 5 }, { groups: ['A'], recentIds: ['A1', 'A2', 'A3'] }).id);
  ok('rotation: only A4 left when A1-A3 were recent', ids.size === 1 && ids.has('A4'), [...ids]);
  const miss = copy.renderTemplate('daily_reminder', 'km', { streak: 3, streakNext: 4 }, { groups: ['A'] });
  ok('missing nextLessonTitle/minutes: only A1/A3 can be picked', ['A1', 'A3'].includes(miss.id), miss.id);
  ok('nothing eligible -> null (quiz group without quiz data)', copy.renderTemplate('daily_reminder', 'km', { streak: 3 }, { groups: ['C'] }) === null);

  // ── success marking ─────────────────────────────────────────────────
  fake.add('notifications', { id: 'N-win', user_id: 'U1', kind: 'nudge', push_sent: true, success: null, created_at: ago(0, 5), template_key: 'daily_reminder', variant_id: 'A1', data: {} });
  fake.add('lesson_completions', { student_id: 'U1', completed_at: ago(0, 4) });   // 1h after the nudge
  fake.add('notifications', { id: 'N-lose', user_id: 'U2', kind: 'nudge', push_sent: true, success: null, created_at: ago(0, 6), template_key: 'comeback', variant_id: 'd3', data: {} });
  await nudges.markNudgeOutcomes(NOW);
  ok('success=true when studied within 2h', notes().find(n => n.id === 'N-win').success === true);
  ok('success=false when not', notes().find(n => n.id === 'N-lose').success === false);

  console.log(`\n${pass} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
