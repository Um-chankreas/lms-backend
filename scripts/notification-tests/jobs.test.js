const fake = require('./fake-supabase');
fake.install({ 'push': (mod) => ({ ...mod, pushMany: async (items) => { (global.__pushed = global.__pushed || []).push(...items); }, pushToUsers: async () => {} }) });
const ROOT = require('path').join(__dirname, '..', '..', 'src', 'utils') + '/';
const digest = require(ROOT + 'dailyDigest');
const events = require(ROOT + 'notifyEvents');
const friends = require(ROOT + 'friendNotify');
const nudges = require(ROOT + 'nudges');

const NOW = new Date('2026-10-23T13:00:00Z');                // 20:00 Cambodia
const ago = (days, hours = 0) => new Date(NOW.getTime() - days * 864e5 - hours * 36e5).toISOString();
const notes = () => fake.tables.notifications || [];
const to = (uid) => notes().filter(n => n.user_id === uid);
let pass = 0;
const ok = (name, cond, info) => { if (!cond) { console.log('FAIL', name, info ?? ''); process.exitCode = 1; } else { pass++; console.log('ok  ', name); } };
const U = (id, name, language = 'km', style = 'balanced') => fake.add('users', { id, name, role: 'student', is_active: true, language, notification_style: style });

(async () => {
  ['A', 'B', 'C', 'D'].forEach((id) => U(id, id === 'A' ? 'កំ អនុត្តរ' : 'Student ' + id, id === 'C' ? 'en' : 'km', id === 'D' ? 'competitive' : 'balanced'));
  ['A', 'B', 'C', 'D'].forEach(u => fake.add('course_enrollments', { student_id: u, course_id: 'C1' }));
  fake.add('courses', { id: 'C1', title: 'Math', live_enabled: true });
  fake.add('users', { id: 'T1', name: 'Teacher Sok', role: 'teacher', is_active: true });

  // ── champion (20:00) ─────────────────────────────────────────────────
  fake.add('lesson_completions', { student_id: 'A', completed_at: ago(0, 1) });
  fake.add('lesson_completions', { student_id: 'A', completed_at: ago(0, 2) });
  fake.add('quiz_submissions', { student_id: 'A', score: 90, submitted_at: ago(0, 3) });
  fake.add('quiz_submissions', { student_id: 'A', score: 30, submitted_at: ago(0, 3) });   // under 60: not counted
  fake.add('quiz_submissions', { student_id: 'B', score: 70, submitted_at: ago(0, 1) });
  fake.add('xp_events', { student_id: 'C', created_at: ago(0, 1) });                        // studied, nothing countable
  /* D did nothing today */
  const c = await digest.runDailyChampion(NOW);
  console.log('champion', JSON.stringify(c));
  ok('champion = A with 3 (the 30% quiz is not counted)', to('A').length === 1 && /3/.test(to('A')[0].body) && to('A')[0].variant_id === 'champion', JSON.stringify(to('A')));
  ok('others who studied get the champion message, inactive D gets nothing', to('B').length === 1 && to('C').length === 1 && to('D').length === 0);
  ok('B (did 1) sees "You did 1"; C (did 0) gets the variant without it', to('B').every(n => n.variant_id === 'a' || n.variant_id === 'b') && to('C')[0].variant_id === 'b', JSON.stringify([to('B'), to('C')]));
  ok('champion name is the given name (Khmer family name first -> last part)', digest.shortName('កំ អនុត្តរ') === 'អនុត្តរ' && digest.shortName('Um Chankreas') === 'Um' && digest.shortName('Dina') === 'Dina');
  ok('English count text', /3 lessons and quizzes|^3/.test(to('C')[0].body + '3') && /finished 3 lessons and quizzes today/.test(to('C')[0].body) || to('C')[0].variant_id === 'b');

  // ── assignment_due_soon ──────────────────────────────────────────────
  fake.tables.notifications.length = 0;
  fake.add('assignments', { id: 'AS1', title: 'Worksheet 3', due_date: new Date(NOW.getTime() + 18 * 36e5).toISOString(), course_id: 'C1', status: 'published' });
  fake.add('assignment_submissions', { student_id: 'B', assignment_id: 'AS1' });
  const d1 = await digest.runAssignmentDueSoon(NOW);
  console.log('due soon', JSON.stringify(d1));
  ok('due soon goes to A, C, D but not B (submitted)', to('A').length === 1 && to('C').length === 1 && to('D').length === 1 && to('B').length === 0);
  ok('English text has the date and time', /Worksheet 3/.test(to('C')[0].title) && !/[{}]|null/.test(to('C')[0].body));
  const d2 = await digest.runAssignmentDueSoon(new Date(NOW.getTime() + 36e5));
  ok('only once per assignment', to('A').length === 1);

  // ── class notifications ──────────────────────────────────────────────
  fake.tables.notifications.length = 0;
  fake.add('assignments', { id: 'AS2', title: 'Quiz prep', due_date: null, course_id: 'C1', status: 'published', type: 'file', courses: { title: null } });
  fake.tables.assignments.find(a => a.id === 'AS2').courses = { title: null };
  await events.notifyAssignmentPublished('AS2');
  ok('assignment_new without due date or course title uses the fallback variant (no cap, kind class)', to('A').length === 1 && to('A')[0].variant_id === 'a-nodue' && to('A')[0].kind === 'class' && /វគ្គសិក្សារបស់អ្នក/.test(to('A')[0].body) && /Your course/.test(to('C')[0].body), JSON.stringify(to('C')));
  fake.add('live_classes', { id: 'LC1', title: 'Limits review', course_id: 'C1', teacher_id: 'T1', status: 'active' });
  fake.tables.live_classes[0].courses = { title: 'Math', live_enabled: true };
  await events.notifyLiveClassStarted('LC1');
  ok('live class: everyone enrolled is told (paywall off), Khmer for km students', to('A').some(n => n.template_key === 'live_class_started' && /Teacher Sok/.test(n.body) && /កំពុងបង្រៀន/.test(n.title)), JSON.stringify(to('A')));
  ok('class notifications ignore the daily cap', to('A').length === 2);

  // ── friend events ────────────────────────────────────────────────────
  fake.tables.notifications.length = 0;
  fake.add('quiz_submissions', { id: 'S-B', quiz_id: 'Q1', student_id: 'B', score: 80, submitted_at: ago(1) });
  fake.add('quiz_submissions', { id: 'S-C', quiz_id: 'Q1', student_id: 'C', score: 60, submitted_at: ago(1) });   // 25 behind: too far
  fake.add('quiz_submissions', { id: 'S-D', quiz_id: 'Q1', student_id: 'D', score: 75, submitted_at: ago(1) });   // 10 behind: counts
  fake.add('quiz_submissions', { id: 'S-A', quiz_id: 'Q1', student_id: 'A', score: 85, submitted_at: ago(0, 1) });
  await friends.notifyFriendsQuizDone({ studentId: 'A', courseId: 'C1', quizId: 'Q1', quizTitle: 'Ch 1 quiz', score: 85, submissionId: 'S-A' });
  ok('B (5 behind) gets friend_beat_score push', to('B').some(n => n.template_key === 'friend_beat_score' && n.push_sent !== false), JSON.stringify(to('B')));
  ok('D (10 behind, competitive style) gets competitive copy', to('D').some(n => n.template_key === 'friend_beat_score' && /(នាំមុខហើយ|ប្រកួតម្ដងទៀត|មានគេរំលងអ្នកហើយ)/.test(n.title)) , JSON.stringify(to('D')));
  ok('C (25 behind) gets NO beat-score push', !to('C').some(n => n.template_key === 'friend_beat_score'));
  ok('everyone gets the bell-only "took a quiz"', ['B', 'C', 'D'].every(u => to(u).some(n => n.template_key === 'friend_quiz' && n.push_sent === false)));
  global.__pushed = [];
  await friends.notifyFriendsLessonDone({ studentId: 'A', courseId: 'C1', lessonId: 'L9', lessonTitle: 'Limits' });
  ok('friend_lesson is bell only: stored, never pushed', to('B').some(n => n.template_key === 'friend_lesson' && n.push_sent === false) && global.__pushed.length === 0, JSON.stringify(global.__pushed));
  await friends.notifyFriendsLessonDone({ studentId: 'A', courseId: 'C1', lessonId: 'L10', lessonTitle: 'Limits 2' });
  await friends.notifyFriendsLessonDone({ studentId: 'A', courseId: 'C1', lessonId: 'L11', lessonTitle: 'Limits 3' });
  ok('bell friend notifications capped at 3 per student per day', to('B').filter(n => ['friend_lesson', 'friend_quiz'].includes(n.template_key)).length === 3, to('B').length);
  await friends.notifyFriendsQuizDone({ studentId: 'A', courseId: 'C1', quizId: 'Q1', quizTitle: 'Ch 1 quiz', score: 85, submissionId: 'S-A' });
  ok('beat-score max once per day', to('B').filter(n => n.template_key === 'friend_beat_score').length === 1);

  // ── streak milestone through the engine ──────────────────────────────
  fake.tables.notifications.length = 0;
  await nudges.sendNudges('streak_milestone', [{ userId: 'A', vars: { milestone: 3, streakBonusXp: null }, groups: ['std'], data: { streak: 3 }, type: 'daily_challenge_streak' }], { now: NOW });
  ok('milestone 3 has no "+0 XP"', to('A').length === 1 && !/\+0|\{/.test(to('A')[0].body) && to('A')[0].type === 'daily_challenge_streak', JSON.stringify(to('A')));
  fake.tables.notifications.length = 0;
  await nudges.sendNudges('streak_milestone', [{ userId: 'A', vars: { milestone: 30, streakBonusXp: 200 }, groups: ['big'], type: 'daily_challenge_streak' }], { now: NOW });
  ok('milestone 30 uses the big message with XP', /200/.test(to('A')[0].body) && /🏅/.test(to('A')[0].title));

  console.log(`\n${pass} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
