// Skip test ("test out") rules. Plain Node, no database/network: uses the
// in-memory Supabase stand-in from the notification tests.
//   node scripts/skip-tests/skipTests.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-0123456789';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
const path = require('path');
const express = require('express');
const fake = require('../notification-tests/fake-supabase');

fake.install({
  'middleware/auth': (mod) => {
    const asUser = (req, _res, next) => { if (req.headers['x-user']) req.user = { userId: req.headers['x-user'], role: req.headers['x-role'] || 'student' }; next(); };
    return { ...mod, optionalAuth: asUser, authenticateToken: asUser };
  },
});

const SRC = path.join(__dirname, '..', '..', 'src') + '/';
let pass = 0;
const ok = (name, cond, info) => {
  if (!cond) { console.log('FAIL', name, info !== undefined ? JSON.stringify(info) : ''); process.exitCode = 1; } else { pass++; console.log('ok  ', name); }
};

Object.keys(require.cache).filter(k => k.startsWith(SRC)).forEach(k => delete require.cache[k]);
const app = express();
app.use(express.json());
app.use('/api/skip-tests', require(SRC + 'routes/skipTests.routes'));

async function call(method, url, body, headers = { 'x-user': 'S1' }) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...(await res.json()) };
  } finally { server.close(); }
}

const opts = ['A', 'B', 'C', 'D'];
function addQuestions(quizId, hard, easy) {
  for (let i = 0; i < hard; i++) fake.add('quiz_questions', { id: `${quizId}-h${i}`, quiz_id: quizId, question: `q ${quizId} hard ${i}`, options: JSON.stringify(opts), correct_answer: 'A', explanation: 'because', question_type: 'QCM', difficulty: 'Hard' });
  for (let i = 0; i < easy; i++) fake.add('quiz_questions', { id: `${quizId}-e${i}`, quiz_id: quizId, question: `q ${quizId} easy ${i}`, options: JSON.stringify(opts), correct_answer: 'A', explanation: '', question_type: 'QCM', difficulty: 'Easy' });
}

function seed({ hardPerUnit = [0, 2, 2, 0, 4] } = {}) {
  fake.reset();
  fake.add('users', { id: 'S1', role: 'student', is_active: true, xp: 0, gold: 0 });
  const course = { id: 'C1', title: 'Course', is_free: true, teacher_id: 'T1' };
  fake.add('courses', course);
  fake.add('lessons', { id: 'L1', course_id: 'C1', title: 'Chapter 1', order_number: 1, courses: course });
  hardPerUnit.forEach((hard, i) => {
    const n = i + 1;
    fake.add('lesson_units', { id: `U${n}`, lesson_id: 'L1', title: `Unit ${n}`, order_number: n });
    fake.add('quizzes', { id: `Q${n}`, course_id: 'C1', lesson_id: 'L1', unit_id: `U${n}`, status: 'published', created_at: '2026-01-01' });
    addQuestions(`Q${n}`, hard, 3);
  });
}
const attempts = () => fake.tables.skip_test_attempts || [];
const done = (t, key, val) => (fake.tables[t] || []).filter(r => r[key] === val);

(async () => {
  // ── offer after a good practice ────────────────────────────────────
  seed();
  let r = await call('GET', '/api/skip-tests/offer?unit_id=U1');
  ok('offer after unit 1: skip the next two unread units (3 and 4 are not offered)', r.data.offer && r.data.offer.scope === 'units' && r.data.offer.unit_ids.join() === 'U2,U3', r.data);
  ok('offer: 3 questions, at most 1 mistake', r.data.offer.question_count === 3 && r.data.offer.max_mistakes === 1, r.data.offer);

  r = await call('GET', '/api/skip-tests/offer?unit_id=U5');
  ok('no offer when nothing is left after the unit', r.data.offer === null, r.data);

  r = await call('GET', '/api/skip-tests/offer?lesson_id=L1');
  ok('chapter offer needs 10 hard questions: none with only 8', r.data.offer === null, r.data);
  seed({ hardPerUnit: [2, 2, 2, 2, 4] });
  r = await call('GET', '/api/skip-tests/offer?lesson_id=L1');
  ok('chapter offer: 10 questions, at most 3 mistakes (70% to pass)', r.data.offer && r.data.offer.scope === 'chapter' && r.data.offer.question_count === 10 && r.data.offer.max_mistakes === 3, r.data);

  r = await call('GET', '/api/skip-tests/offer?lesson_id=L1', null, { 'x-user': 'T1', 'x-role': 'teacher' });
  ok('teachers get no skip tests', r.status === 403, r);

  // ── start ──────────────────────────────────────────────────────────
  r = await call('POST', '/api/skip-tests/start', { scope: 'units', lesson_id: 'L1', unit_ids: ['U2', 'U3', 'U4'] });
  ok('start: serves 3 hard questions, no answers leaked', r.status === 201 && r.data.questions.length === 3 && r.data.questions.every(q => q.difficulty === 'Hard' && q.correct_answer === undefined), r);
  ok('start: only units 2 and 3 (max two)', attempts()[0].unit_ids.join() === 'U2,U3', attempts()[0]);
  ok('start: questions come from the target units only', attempts()[0].question_ids.every(id => /^Q[23]-h/.test(id)), attempts()[0].question_ids);
  const qs = r.data.questions;
  const attemptId = r.data.attempt_id;

  // ── 1 mistake passes ───────────────────────────────────────────────
  const pass1 = { [qs[0].id]: 'A', [qs[1].id]: 'A', [qs[2].id]: 'B' };
  r = await call('POST', `/api/skip-tests/${attemptId}/submit`, { answers: pass1 });
  ok('1 mistake out of 3 passes', r.data.passed === true && r.data.mistakes === 1 && r.data.correct === 2, r.data);
  ok('passed: units 2 and 3 are marked done', done('unit_completions', 'student_id', 'S1').map(c => c.unit_id).sort().join() === 'U2,U3', fake.tables.unit_completions);
  ok('passed: their practice quizzes count as passed', done('quiz_submissions', 'student_id', 'S1').map(c => c.quiz_id).sort().join() === 'Q2,Q3', fake.tables.quiz_submissions);
  ok('passed: no unit-read XP was awarded', !(fake.tables.xp_events || []).some(e => e.reason === 'unit_complete'), fake.tables.xp_events);
  ok('passed: bonus gold + Test-Out badge', fake.tables.users[0].gold >= 10 && (fake.tables.achievements || []).some(a => a.badge_code === 'first_skip'), { gold: fake.tables.users[0].gold, ach: fake.tables.achievements });
  ok('review lists every question with the correct answer', r.data.review.length === 3 && r.data.review.every(x => x.correct_answer === 'A'), r.data.review);

  r = await call('POST', `/api/skip-tests/${attemptId}/submit`, { answers: pass1 });
  ok('a second submit is refused', r.status === 409, r);

  r = await call('GET', '/api/skip-tests/offer?unit_id=U1');
  ok('after skipping 2 and 3, the next offer moves on to units 4 and 5', r.data.offer && r.data.offer.unit_ids.join() === 'U4,U5', r.data);

  // ── 2 mistakes fails, nothing changes ──────────────────────────────
  seed();
  r = await call('POST', '/api/skip-tests/start', { scope: 'units', lesson_id: 'L1', unit_ids: ['U2', 'U3'] });
  const q2 = r.data.questions;
  r = await call('POST', `/api/skip-tests/${r.data.attempt_id}/submit`, { answers: { [q2[0].id]: 'A', [q2[1].id]: 'B', [q2[2].id]: 'C' } });
  ok('2 mistakes out of 3 fails', r.data.passed === false && r.data.mistakes === 2, r.data);
  ok('failed: nothing is marked done', !(fake.tables.unit_completions || []).length && !(fake.tables.quiz_submissions || []).length, fake.tables);
  ok('failed: no gold', fake.tables.users[0].gold === 0, fake.tables.users[0]);

  // ── unanswered questions are mistakes ──────────────────────────────
  seed();
  r = await call('POST', '/api/skip-tests/start', { scope: 'units', lesson_id: 'L1', unit_ids: ['U2', 'U3'] });
  const q3 = r.data.questions;
  r = await call('POST', `/api/skip-tests/${r.data.attempt_id}/submit`, { answers: { [q3[0].id]: 'A' } });
  ok('answering only one question fails (the others count as mistakes)', r.data.passed === false && r.data.mistakes === 2, r.data);

  // ── chapter skip ───────────────────────────────────────────────────
  const answerWithMistakes = (qs, mistakes) => Object.fromEntries(qs.map((q, i) => [q.id, i < mistakes ? 'B' : 'A']));
  seed({ hardPerUnit: [2, 2, 2, 2, 4] });
  r = await call('POST', '/api/skip-tests/start', { scope: 'chapter', lesson_id: 'L1' });
  ok('chapter test serves 10 hard questions', r.status === 201 && r.data.questions.length === 10, r);
  const qc = r.data.questions;
  r = await call('POST', `/api/skip-tests/${r.data.attempt_id}/submit`, { answers: answerWithMistakes(qc, 3) });
  ok('chapter: 7 of 10 correct (70%) passes', r.data.passed === true && r.data.mistakes === 3 && r.data.correct === 7, r.data);
  ok('chapter: every unit marked done and the chapter completes', done('unit_completions', 'student_id', 'S1').length === 5 && r.data.chapter_completed === true && done('lesson_completions', 'student_id', 'S1').length === 1, { c: fake.tables.unit_completions, r: r.data });

  seed({ hardPerUnit: [2, 2, 2, 2, 4] });
  r = await call('POST', '/api/skip-tests/start', { scope: 'chapter', lesson_id: 'L1' });
  const qd = r.data.questions;
  r = await call('POST', `/api/skip-tests/${r.data.attempt_id}/submit`, { answers: answerWithMistakes(qd, 4) });
  ok('chapter: 6 of 10 correct (60%) fails', r.data.passed === false && r.data.mistakes === 4, r.data);

  // ── not enough hard questions ──────────────────────────────────────
  seed({ hardPerUnit: [0, 1, 1, 0, 0] });
  r = await call('GET', '/api/skip-tests/offer?unit_id=U1');
  ok('no offer when the next two units have fewer than 3 hard questions between them', r.data.offer === null, r.data);
  seed({ hardPerUnit: [0, 1, 1, 0, 0] });
  r = await call('POST', '/api/skip-tests/start', { scope: 'units', lesson_id: 'L1', unit_ids: ['U2', 'U3'] });
  ok('start is refused when there are not enough hard questions', r.status === 409, r);

  console.log(`\n${pass} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
