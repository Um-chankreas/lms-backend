// Open progression + test-out tests. Plain Node, no database/network: uses the
// in-memory Supabase stand-in from the notification tests.
//   node scripts/progression-tests/progression.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-0123456789';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
const path = require('path');
const express = require('express');
const fake = require('../notification-tests/fake-supabase');

// Every request is the student named in the x-user header (no JWT needed).
fake.install({
  'middleware/auth': (mod) => {
    const asUser = (req, _res, next) => { if (req.headers['x-user']) req.user = { userId: req.headers['x-user'], role: 'student' }; next(); };
    return { ...mod, optionalAuth: asUser, authenticateToken: asUser };
  },
});

const SRC = path.join(__dirname, '..', '..', 'src') + '/';
let pass = 0;
const ok = (name, cond, info) => {
  if (!cond) { console.log('FAIL', name, info !== undefined ? JSON.stringify(info) : ''); process.exitCode = 1; } else { pass++; console.log('ok  ', name); }
};

// Load the routers fresh so the OPEN_PROGRESSION env var is re-read.
function load(open) {
  process.env.OPEN_PROGRESSION = open ? 'true' : 'false';
  Object.keys(require.cache).filter(k => k.startsWith(SRC)).forEach(k => delete require.cache[k]);
  const app = express();
  app.use('/api/courses', require(SRC + 'routes/courses.routes'));
  app.use('/api/lessons', require(SRC + 'routes/lessons.routes'));
  return app;
}
async function get(app, url, user) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers: user ? { 'x-user': user } : {} });
    return (await res.json()).data;
  } finally { server.close(); }
}

function seed({ category = 'Math' } = {}) {
  fake.reset();
  fake.add('users', { id: 'S1', role: 'student', is_active: true, xp: 0 });
  const course = { id: 'C1', title: 'Course', is_free: true, category };
  fake.add('courses', course);
  // The stand-in has no joins, so embed the `courses(*)` relation on each lesson.
  ['L1', 'L2', 'L3'].forEach((id, i) => fake.add('lessons', { id, course_id: 'C1', title: id, order_number: i + 1, is_free: true, courses: course }));
  // L2 has two units, each with a published practice quiz.
  fake.add('lesson_units', { id: 'U1', lesson_id: 'L2', title: 'U1', order_number: 1 });
  fake.add('lesson_units', { id: 'U2', lesson_id: 'L2', title: 'U2', order_number: 2 });
  fake.add('quizzes', { id: 'Q1', course_id: 'C1', lesson_id: 'L2', unit_id: 'U1', status: 'published', created_at: '2026-01-01' });
  fake.add('quizzes', { id: 'Q2', course_id: 'C1', lesson_id: 'L2', unit_id: 'U2', status: 'published', created_at: '2026-01-01' });
}
const statuses = (nodes, type) => nodes.filter(n => n.type === type).map(n => n.status);

(async () => {
  // ── course path ────────────────────────────────────────────────────
  seed();
  let d = await get(load(true), '/api/courses/C1/path', 'S1');
  ok('open: lesson 1 is current', statuses(d.nodes, 'lesson')[0] === 'current', statuses(d.nodes, 'lesson'));
  ok('open: lessons 2+ are available, not locked', statuses(d.nodes, 'lesson').slice(1).every(s => s === 'available'), statuses(d.nodes, 'lesson'));
  ok('open: chests stay locked until the lesson is completed', statuses(d.nodes, 'chest').every(s => s === 'locked'), statuses(d.nodes, 'chest'));

  d = await get(load(false), '/api/courses/C1/path', 'S1');
  ok('flag off: lessons 2+ locked (old behaviour)', statuses(d.nodes, 'lesson').slice(1).every(s => s === 'locked'), statuses(d.nodes, 'lesson'));

  // ── lesson (chapter) path ──────────────────────────────────────────
  seed();
  d = await get(load(true), '/api/lessons/L2/path', 'S1');
  const steps = d.nodes.filter(n => n.type !== 'chest');
  ok('open: L2 reachable although L1 is not done', d.lesson.locked === false, d.lesson);
  ok('open: no step is locked', steps.every(n => n.status !== 'locked'), steps.map(n => n.status));
  ok('open: exactly one current step', steps.filter(n => n.status === 'current').length === 1);
  ok('open: chest locked', d.nodes.at(-1).status === 'locked');

  d = await get(load(false), '/api/lessons/L2/path', 'S1');
  ok('flag off: L2 locked while L1 is not done', d.lesson.locked === true, d.lesson);
  ok('flag off: every L2 step locked', d.nodes.filter(n => n.type !== 'chest').every(n => n.status === 'locked'));

  seed();
  fake.add('lesson_completions', { lesson_id: 'L1', student_id: 'S1' });
  d = await get(load(false), '/api/lessons/L2/path', 'S1');
  ok('flag off: finishing L1 opens L2; only the first step is current', d.nodes[0].status === 'current' && d.nodes[1].status === 'locked', d.nodes.map(n => n.status));

  // ── test-out: passing a unit quiz skips its reading ────────────────
  seed();
  fake.add('quiz_submissions', { quiz_id: 'Q1', student_id: 'S1', score: 90, passed: true });
  d = await get(load(true), '/api/lessons/L2/path', 'S1');
  let u1 = d.nodes.find(n => n.type === 'unit' && n.unit_id === 'U1');
  let u2 = d.nodes.find(n => n.type === 'unit' && n.unit_id === 'U2');
  ok('skip: passed quiz marks its unit completed + skipped', u1.status === 'completed' && u1.skipped === true, u1);
  ok('skip: other unit untouched', u2.status !== 'completed' && !u2.skipped, u2);
  ok('skip: progress counts the skipped unit and its quiz', d.progress.completed_steps === 2, d.progress);

  seed();
  fake.add('unit_completions', { unit_id: 'U1', student_id: 'S1' });
  fake.add('quiz_submissions', { quiz_id: 'Q1', student_id: 'S1', score: 90, passed: true });
  d = await get(load(true), '/api/lessons/L2/path', 'S1');
  u1 = d.nodes.find(n => n.type === 'unit' && n.unit_id === 'U1');
  ok('read + passed is not flagged skipped', u1.status === 'completed' && !u1.skipped, u1);

  seed();
  fake.add('quiz_submissions', { quiz_id: 'Q1', student_id: 'S1', score: 20, passed: false });
  d = await get(load(true), '/api/lessons/L2/path', 'S1');
  u1 = d.nodes.find(n => n.type === 'unit' && n.unit_id === 'U1');
  ok('failed quiz does not skip the unit', u1.status !== 'completed', u1);

  // ── chapter auto-complete with skipped units ───────────────────────
  const xpOf = () => (fake.tables.xp_events || []).map(e => e.reason ?? e.source ?? e.event_type);
  seed({ category: 'Math' });
  load(true);
  const { checkChapterAutoComplete } = require(SRC + 'utils/progress');
  fake.add('quiz_submissions', { quiz_id: 'Q1', student_id: 'S1', score: 90, passed: true });
  ok('one quiz passed: chapter not complete', (await checkChapterAutoComplete({ lessonId: 'L2', studentId: 'S1' })) === false);
  fake.add('quiz_submissions', { quiz_id: 'Q2', student_id: 'S1', score: 80, passed: true });
  ok('all unit quizzes passed, nothing read: chapter completes (non-History)', (await checkChapterAutoComplete({ lessonId: 'L2', studentId: 'S1' })) === true);
  ok('lesson_completions row written', (fake.tables.lesson_completions || []).some(c => c.lesson_id === 'L2' && c.student_id === 'S1'));
  ok('second call is a no-op', (await checkChapterAutoComplete({ lessonId: 'L2', studentId: 'S1' })) === false);
  ok('no UNIT_COMPLETE XP was granted for skipped units', !xpOf().includes('unit_complete'), xpOf());

  seed({ category: 'History' });
  load(true);
  const p2 = require(SRC + 'utils/progress');
  fake.add('quiz_submissions', { quiz_id: 'Q1', student_id: 'S1', score: 90, passed: true });
  fake.add('quiz_submissions', { quiz_id: 'Q2', student_id: 'S1', score: 90, passed: true });
  ok('History still completes by quiz pass alone', (await p2.checkChapterAutoComplete({ lessonId: 'L2', studentId: 'S1' })) === true);

  seed();
  load(true);
  const p3 = require(SRC + 'utils/progress');
  fake.add('unit_completions', { unit_id: 'U1', student_id: 'S1' });
  fake.add('unit_completions', { unit_id: 'U2', student_id: 'S1' });
  fake.add('quiz_submissions', { quiz_id: 'Q1', student_id: 'S1', score: 90, passed: true });
  ok('read everything but one quiz unpassed: not complete', (await p3.checkChapterAutoComplete({ lessonId: 'L2', studentId: 'S1' })) === false);

  console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
