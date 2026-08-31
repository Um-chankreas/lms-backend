const { Server } = require('socket.io');
const supabase = require('../config/supabase');
const { verifyToken } = require('../utils/jwt');
const { generateAgoraUid } = require('../utils/agoraUid');

/**
 * Realtime layer for live classes (Google-Meet-style). No approval / request
 * queue: a student opens their own voice, and a raised hand is just a signal.
 *
 * REST endpoints in liveClass.routes.js are the source of truth and do every
 * write; afterwards they call the emit* helpers here and this module pushes
 * the change to connected clients. Clients subscribe once and never poll.
 *
 * live_class_hand_raises.status:
 *   "raised"    -> hand up, shown floating on that student's tile (like Meet)
 *   "speaking"  -> student is a co-host, shown in the participant list w/ a
 *                  mic icon the teacher can mute
 *
 * Rooms per live class `:id`:
 *   lc:<id>            everyone in the call
 *   lc:<id>:u:<userId> one student's sockets (private status sync)
 *
 * Client -> server:
 *   "live-class:subscribe"    { liveClassId }
 *       ack: { ok, role, state: { status, stage, participants, hand? } }
 *   "live-class:unsubscribe"  { liveClassId }
 *
 * Server -> client:
 *   "participants:changed" { liveClassId, participants:[...] }            -> lc:<id>
 *   "stage:changed"        { liveClassId, speakers:[...], raised_hands:[...] } -> lc:<id>
 *   "hand:raised"          { liveClassId, user_id, name }                 -> lc:<id>  (transient toast)
 *   "hand:lowered"         { liveClassId, user_id }                       -> lc:<id>
 *   "hand:update"          { liveClassId, status }                        -> lc:<id>:u:<userId>  ('none'|'raised'|'speaking')
 *   "speaker:mute"         { liveClassId, user_id }                       -> lc:<id>:u:<userId>  (teacher asked you to mute; not strict)
 *   "class:status"         { liveClassId, status }                       -> lc:<id>
 *
 * participants[] items:            { user_id, name, avatar_url, agora_uid, role, joined_at, speaking, hand_raised }
 * speakers[] / raised_hands[] items: { user_id, name, avatar_url, agora_uid }
 */

let io = null;

const roomAll = (id) => `lc:${id}`;
const roomUser = (id, userId) => `lc:${id}:u:${userId}`;

async function loadLiveClass(id) {
  const { data } = await supabase
    .from('live_classes')
    .select('*')
    .eq('id', id)
    .single();
  return data || null;
}

// Same guard the REST routes use, duplicated here to keep this module free of
// a circular require on the routes file.
async function resolveAccess(liveClass, user) {
  if (!user) return { allowed: false };
  if (user.role === 'teacher') {
    return liveClass.teacher_id === user.userId
      ? { allowed: true, role: 'teacher' }
      : { allowed: false };
  }
  if (user.role === 'admin') {
    return { allowed: true, role: 'admin' };
  }
  if (user.role === 'student') {
    const { data: course } = await supabase
      .from('courses')
      .select('live_enabled')
      .eq('id', liveClass.course_id)
      .maybeSingle();

    if (course && course.live_enabled === false) return { allowed: false, code: 'live_disabled' };

    const { data: me } = await supabase
      .from('users')
      .select('paid_until')
      .eq('id', user.userId)
      .maybeSingle();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const active = me?.paid_until && new Date(me.paid_until) >= today;

    return active ? { allowed: true, role: 'student' } : { allowed: false, code: 'payment_required' };
  }
  return { allowed: false };
}

/**
 * Current "stage" of a class: who's speaking (co-hosts) and whose hand is up.
 * This drives both the participant mic icons and the floating hands.
 */
async function getStage(liveClassId) {
  const { data: rows, error } = await supabase
    .from('live_class_hand_raises')
    .select('user_id, status, created_at, users(name, avatar_url)')
    .eq('live_class_id', liveClassId)
    .in('status', ['raised', 'speaking'])
    .order('created_at', { ascending: true });

  if (error) {
    console.error('getStage error:', error.message);
    return { speakers: [], raised_hands: [] };
  }

  const map = (r) => ({
    user_id: r.user_id,
    name: r.users?.name || 'Student',
    avatar_url: r.users?.avatar_url || null,
    agora_uid: generateAgoraUid(r.user_id)
  });

  return {
    speakers: (rows || []).filter(r => r.status === 'speaking').map(map),
    raised_hands: (rows || []).filter(r => r.status === 'raised').map(map)
  };
}

/** Everyone currently in the call (left_at IS NULL), with stage flags merged. */
async function getParticipants(liveClassId) {
  const { data: parts, error } = await supabase
    .from('live_class_participants')
    .select('user_id, role, joined_at, users(name, avatar_url)')
    .eq('live_class_id', liveClassId)
    .is('left_at', null)
    .order('joined_at', { ascending: true });

  if (error) {
    console.error('getParticipants error:', error.message);
    return [];
  }

  const stage = await getStage(liveClassId);
  const speaking = new Set(stage.speakers.map(s => s.user_id));
  const raised = new Set(stage.raised_hands.map(s => s.user_id));

  // De-dupe by user_id (a reconnect can briefly leave two open rows).
  const seen = new Set();
  const out = [];
  for (const p of parts || []) {
    if (seen.has(p.user_id)) continue;
    seen.add(p.user_id);
    out.push({
      user_id: p.user_id,
      name: p.users?.name || 'Student',
      avatar_url: p.users?.avatar_url || null,
      agora_uid: generateAgoraUid(p.user_id),
      role: p.role,
      joined_at: p.joined_at,
      speaking: speaking.has(p.user_id),
      hand_raised: raised.has(p.user_id)
    });
  }
  return out;
}

/** One student's own status: 'none' | 'raised' | 'speaking'. */
async function getHandStatus(liveClassId, userId) {
  const { data } = await supabase
    .from('live_class_hand_raises')
    .select('status')
    .eq('live_class_id', liveClassId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.status || 'none';
}

function initLiveClassRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    path: '/socket.io'
  });

  // JWT handshake — same token the REST API uses.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    const decoded = token && verifyToken(token);
    if (!decoded) return next(new Error('unauthorized'));
    socket.user = decoded;              // { userId, role } — for handler code
    socket.data.user = decoded;         // survives into RemoteSocket (fetchSockets)
    next();
  });

  io.on('connection', (socket) => {
    socket.data.liveClassIds = new Set();

    socket.on('live-class:subscribe', async ({ liveClassId } = {}, ack) => {
      try {
        if (!liveClassId) return ack?.({ ok: false, error: 'liveClassId required' });

        const liveClass = await loadLiveClass(liveClassId);
        if (!liveClass) return ack?.({ ok: false, error: 'not found' });

        const access = await resolveAccess(liveClass, socket.user);
        if (!access.allowed) return ack?.({ ok: false, error: 'forbidden' });

        socket.join(roomAll(liveClassId));
        socket.data.liveClassIds.add(liveClassId);

        const state = {
          status: liveClass.status,
          stage: await getStage(liveClassId),
          participants: await getParticipants(liveClassId)
        };

        if (access.role === 'teacher') {
          ack?.({ ok: true, role: 'teacher', state });
        } else {
          socket.join(roomUser(liveClassId, socket.user.userId));
          state.hand = await getHandStatus(liveClassId, socket.user.userId);
          ack?.({ ok: true, role: 'student', state });
        }
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('live-class:unsubscribe', ({ liveClassId } = {}) => {
      if (!liveClassId) return;
      socket.leave(roomAll(liveClassId));
      socket.leave(roomUser(liveClassId, socket.user.userId));
      socket.data.liveClassIds.delete(liveClassId);
      scheduleLeaveCheck(liveClassId, socket.user.userId);
    });

    // App closed / lost connection without calling POST /:id/leave — after a
    // short grace (reconnect window) mark the user as left so the web portal's
    // participant list clears them.
    socket.on('disconnect', () => {
      for (const liveClassId of socket.data.liveClassIds) {
        scheduleLeaveCheck(liveClassId, socket.user.userId);
      }
    });
  });

  return io;
}

const LEAVE_GRACE_MS = 8000;

function scheduleLeaveCheck(liveClassId, userId) {
  setTimeout(() => markLeftIfGone(liveClassId, userId).catch(() => {}), LEAVE_GRACE_MS);
}

/** If `userId` has no socket left in the class room, mark them left + clear stage. */
async function markLeftIfGone(liveClassId, userId) {
  if (!io) return;

  const sockets = await io.in(roomAll(liveClassId)).fetchSockets();
  if (sockets.some(s => s.data?.user?.userId === userId)) return; // still connected elsewhere

  const { data: open } = await supabase
    .from('live_class_participants')
    .select('id')
    .eq('live_class_id', liveClassId)
    .eq('user_id', userId)
    .is('left_at', null);

  if (!open || open.length === 0) return; // already left via REST

  await supabase
    .from('live_class_participants')
    .update({ left_at: new Date() })
    .eq('live_class_id', liveClassId)
    .eq('user_id', userId)
    .is('left_at', null);

  await supabase
    .from('live_class_hand_raises')
    .delete()
    .eq('live_class_id', liveClassId)
    .eq('user_id', userId);

  await emitStageChanged(liveClassId);
  await emitParticipantsChanged(liveClassId);
}

// ---- emit helpers, called by the REST routes after a successful write ----

async function emitStageChanged(liveClassId) {
  if (!io) return;
  io.to(roomAll(liveClassId)).emit('stage:changed', {
    liveClassId,
    ...(await getStage(liveClassId))
  });
}

async function emitParticipantsChanged(liveClassId) {
  if (!io) return;
  io.to(roomAll(liveClassId)).emit('participants:changed', {
    liveClassId,
    participants: await getParticipants(liveClassId)
  });
}

function emitHandRaised(liveClassId, userId, name) {
  if (!io) return;
  io.to(roomAll(liveClassId)).emit('hand:raised', { liveClassId, user_id: userId, name });
}

function emitHandLowered(liveClassId, userId) {
  if (!io) return;
  io.to(roomAll(liveClassId)).emit('hand:lowered', { liveClassId, user_id: userId });
}

function emitHandUpdate(liveClassId, userId, status) {
  if (!io) return;
  io.to(roomUser(liveClassId, userId)).emit('hand:update', { liveClassId, status });
}

/**
 * Teacher asks a speaker to mute — NOT strict. The student's app turns its
 * mic off but stays a co-host and can unmute itself again immediately.
 */
function emitForceMute(liveClassId, userId) {
  if (!io) return;
  io.to(roomUser(liveClassId, userId)).emit('speaker:mute', { liveClassId, user_id: userId });
}

function emitClassStatus(liveClassId, status) {
  if (!io) return;
  io.to(roomAll(liveClassId)).emit('class:status', { liveClassId, status });
}

module.exports = {
  initLiveClassRealtime,
  getStage,
  getParticipants,
  emitStageChanged,
  emitParticipantsChanged,
  emitHandRaised,
  emitHandLowered,
  emitHandUpdate,
  emitForceMute,
  emitClassStatus
};
