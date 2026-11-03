const supabase = require('../config/supabase');
const { endLiveClassRecord } = require('./liveClassEnd');
const {
  connectedCount, emitClassStatus, emitStageChanged, emitParticipantsChanged
} = require('../realtime/liveClassSocket');

// A class can stay "active" in the database after it really ended: the
// teacher's browser crashed, the laptop slept, or the End request never
// arrived. The course then shows as live and nobody can start a new class.
// This sweeper closes those leftovers. It is the same in-process interval
// approach as classScheduler.js.
const POLL_MS = 60 * 1000;
const EMPTY_GRACE_MS = 3 * 60 * 1000;          // nobody connected for this long -> abandoned
const MAX_LIVE_MS = 12 * 60 * 60 * 1000;       // no class legitimately runs longer than this

const emptySince = new Map();                   // live_class_id -> ms first seen empty

/** Nobody is in the room and no participant row is still open. */
async function isRoomEmpty(liveClassId) {
  const connected = await connectedCount(liveClassId);
  if (connected === null || connected > 0) return false;   // realtime off, or someone is there
  const { data: open } = await supabase
    .from('live_class_participants')
    .select('id')
    .eq('live_class_id', liveClassId)
    .is('left_at', null)
    .limit(1);
  return !(open && open.length);
}

/** End a class and tell anyone still looking at it. */
async function closeClass(liveClassId) {
  const ended = await endLiveClassRecord(liveClassId);
  emptySince.delete(liveClassId);
  emitClassStatus(liveClassId, 'completed');
  await emitStageChanged(liveClassId);
  await emitParticipantsChanged(liveClassId);
  return ended;
}

async function sweepStaleClasses() {
  const { data: active } = await supabase
    .from('live_classes')
    .select('id, started_at')
    .eq('status', 'active');
  const now = Date.now();
  const ids = new Set((active || []).map(c => c.id));
  for (const id of emptySince.keys()) if (!ids.has(id)) emptySince.delete(id);

  for (const lc of active || []) {
    const age = lc.started_at ? now - new Date(lc.started_at).getTime() : 0;
    if (age > MAX_LIVE_MS) {
      await closeClass(lc.id);
      continue;
    }
    if (!(await isRoomEmpty(lc.id))) { emptySince.delete(lc.id); continue; }
    if (!emptySince.has(lc.id)) emptySince.set(lc.id, now);
    if (now - emptySince.get(lc.id) >= EMPTY_GRACE_MS) await closeClass(lc.id);
  }
}

let started = false;
function startLiveClassSweeper() {
  if (started) return;
  started = true;
  setInterval(() => sweepStaleClasses().catch(e => console.warn('liveClassSweeper tick failed:', e.message)), POLL_MS).unref();
}

module.exports = { startLiveClassSweeper, sweepStaleClasses, isRoomEmpty, closeClass };
