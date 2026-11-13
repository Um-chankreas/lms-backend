/**
 * Teaching progress of one class: how many of its lessons the teacher has taught.
 * Pure (no DB) so it can be tested; courses.routes.js loads the rows and calls summarize().
 *
 *   lessons : [{ id, title, order_number, created_at }]   (any order)
 *   taught  : [{ lesson_id, taught_on, live_class_id }]
 */
function orderLessons(lessons) {
  return [...lessons].sort((a, b) =>
    (a.order_number ?? 0) - (b.order_number ?? 0) ||
    String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
    String(a.title || '').localeCompare(String(b.title || '')));
}

function summarize(lessons, taught) {
  const byLesson = new Map((taught || []).map(t => [t.lesson_id, t]));
  const ordered = orderLessons(lessons || []).map(l => {
    const t = byLesson.get(l.id);
    return { id: l.id, title: l.title, order_number: l.order_number ?? 0, taught_on: t?.taught_on || null, live_class_id: t?.live_class_id || null };
  });
  const done = ordered.filter(l => l.taught_on);
  const next = ordered.find(l => !l.taught_on) || null;
  const last = done.reduce((m, l) => (!m || l.taught_on > m ? l.taught_on : m), null);
  return {
    lessons: ordered,
    total: ordered.length,
    taught_count: done.length,
    pace_pct: ordered.length ? Math.round((done.length / ordered.length) * 100) : null,
    next_lesson_id: next ? next.id : null,
    last_taught_on: last,
  };
}

module.exports = { summarize, orderLessons };
