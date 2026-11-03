const supabase = require('../config/supabase');
const { notifyAssignmentPublished } = require('./notifyEvents');

// A teacher can publish an assignment with a future `opens_at` (see
// sql/061_assignment_opens_at.sql). Publishing then stays silent; this tick
// sends the usual "new assignment" notification once the opening time passes.
// Same in-process setInterval approach as classScheduler.js.
const POLL_MS = 60 * 1000;

async function openDueAssignments() {
  const { data: due, error } = await supabase
    .from('assignments')
    .select('id, opens_at, published_at')
    .eq('status', 'published')
    .not('opens_at', 'is', null)
    .lte('opens_at', new Date().toISOString())
    .is('opens_notified_at', null);
  if (error) {
    // Migration not run yet: nothing to do.
    return;
  }
  // Only ones scheduled ahead: if it opened before it was published, the
  // publish itself already notified students.
  for (const { id } of (due || []).filter(a => !a.published_at || new Date(a.opens_at) > new Date(a.published_at))) {
    // Claim the row first so two server instances never both notify.
    const { data: claimed } = await supabase
      .from('assignments')
      .update({ opens_notified_at: new Date().toISOString() })
      .eq('id', id)
      .is('opens_notified_at', null)
      .select('id');
    if (claimed?.length) notifyAssignmentPublished(id);
  }
}

let started = false;
function startAssignmentScheduler() {
  if (started) return;
  started = true;
  setInterval(() => openDueAssignments().catch(e => console.warn('assignmentScheduler tick failed:', e.message)), POLL_MS).unref();
}

module.exports = { startAssignmentScheduler };
