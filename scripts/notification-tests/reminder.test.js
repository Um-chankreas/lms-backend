const fake = require('./fake-supabase');
fake.install({ 'push': (mod) => ({ ...mod, pushMany: async () => {}, pushToUsers: async () => {} }) });
const events = require(require('path').join(__dirname, '..', '..', 'src', 'utils') + '/notifyEvents');

let pass = 0;
const ok = (name, cond, info) => { if (!cond) { console.log('FAIL', name, info ?? ''); process.exitCode = 1; } else { pass++; console.log('ok  ', name); } };
const notes = () => (fake.tables.notifications || []).filter(n => n.type === 'assignment_reminder');

(async () => {
  fake.add('courses', { id: 'C1', title: 'Math' });
  [['A', 'km'], ['B', 'en'], ['C', 'km']].forEach(([id, language]) =>
    fake.add('users', { id, name: id, role: 'student', is_active: true, language }));
  fake.add('users', { id: 'D', name: 'D', role: 'student', is_active: false, language: 'km' });
  ['A', 'B', 'C', 'D'].forEach(s => fake.add('course_enrollments', { student_id: s, course_id: 'C1' }));
  fake.add('assignment_submissions', { assignment_id: 'S1', student_id: 'A' });

  const future = new Date(Date.now() + 2 * 864e5).toISOString();
  fake.add('assignments', { id: 'S1', title: 'Limit', course_id: 'C1', type: 'quiz', due_date: future });
  const r = await events.notifyAssignmentReminder('S1');
  ok('only students who have not submitted are pending', r.pending === 3, JSON.stringify(r));
  ok('inactive student is skipped, active non-submitters notified', r.sent === 2 && notes().length === 2, JSON.stringify(r));
  ok('submitted student A gets nothing', !notes().some(n => n.user_id === 'A'));
  ok('upcoming due date uses the "due" variant, in the student language',
    notes().find(n => n.user_id === 'B').variant_id === 'due' && /Reminder: Limit/.test(notes().find(n => n.user_id === 'B').title));
  ok('Khmer student gets Khmer text', /រំលឹក/.test(notes().find(n => n.user_id === 'C').title));

  fake.tables.notifications.length = 0;
  fake.add('assignments', { id: 'S2', title: 'Old', course_id: 'C1', type: 'file', due_date: new Date(Date.now() - 864e5).toISOString() });
  await events.notifyAssignmentReminder('S2');
  ok('past due uses the "overdue" variant', notes().length > 0 && notes().every(n => n.variant_id === 'overdue'), JSON.stringify(notes().map(n => n.variant_id)));

  fake.tables.notifications.length = 0;
  fake.add('assignments', { id: 'S3', title: 'Open', course_id: 'C1', type: 'file', due_date: null });
  await events.notifyAssignmentReminder('S3');
  ok('no due date uses the "nodue" variant', notes().length > 0 && notes().every(n => n.variant_id === 'nodue'));

  const none = await events.notifyAssignmentReminder('missing');
  ok('unknown assignment sends nothing', none.sent === 0 && none.pending === 0);
  console.log(`${pass} checks passed`);
})();
