
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { hasActiveSubscription } = require('../utils/access');
const { generateAgoraToken, appId } = require('../utils/agoraToken');
const { generateAgoraUid } = require('../utils/agoraUid');
const {
  getStage,
  emitStageChanged,
  emitParticipantsChanged,
  emitHandRaised,
  emitHandLowered,
  emitHandUpdate,
  emitClassStatus,
  emitForceMute
} = require('../realtime/liveClassSocket');
const { v4: uuidv4 } = require('uuid');

// Mobile deep link the app opens to jump straight into a live class screen.
// The app still has to call POST /:id/token to get the Agora credentials.
const JOIN_URL_BASE = (process.env.LIVE_CLASS_JOIN_URL_BASE || 'lms://live-class').replace(/\/$/, '');
const joinUrlFor = (liveClassId) => `${JOIN_URL_BASE}/${liveClassId}`;

/**
 * Works out whether `user` is allowed to see / join `liveClass`:
 *  - the teacher who owns the class, or
 *  - a student with an active weekly subscription (covers every course),
 *    as long as the course still has live classes enabled by an admin.
 * Returns { allowed, role, reason, code }.
 */
async function resolveLiveClassAccess(liveClass, user) {
  if (!user) return { allowed: false, reason: 'Authentication required' };

  if (user.role === 'teacher') {
    return liveClass.teacher_id === user.userId
      ? { allowed: true, role: 'teacher' }
      : { allowed: false, reason: 'You do not own this live class' };
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

    if (course && course.live_enabled === false) {
      return {
        allowed: false,
        code: 'live_disabled',
        reason: 'Live classes are turned off for this course'
      };
    }

    const subscribed = await hasActiveSubscription({ supabase, studentId: user.userId });

    return subscribed
      ? { allowed: true, role: 'student' }
      : {
          allowed: false,
          code: 'payment_required',
          reason: 'A weekly subscription is required to join live classes'
        };
  }

  return { allowed: false, reason: 'Not allowed' };
}

/**
 * POST /api/live-classes
 * Create a new live class (Teacher only)
 */
router.post('/', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { course_id, title, description, scheduled_at } = req.body;

    if (!course_id || !title) {
      return res.status(400).json({
        success: false,
        error: 'Course ID and title are required'
      });
    }

    // Verify course ownership
    const { data: course } = await supabase
      .from('courses')
      .select('teacher_id')
      .eq('id', course_id)
      .single();

    if (course?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only create live classes for your own courses'
      });
    }

    // Generate unique channel name
    const classId = uuidv4();
    const channelName = `class_${classId}`;

    const { data: newClass, error } = await supabase
      .from('live_classes')
      .insert({
        id: classId,
        course_id,
        teacher_id: req.user.userId,
        title,
        description: description || '',
        channel_name: channelName,
        status: 'scheduled',
        scheduled_at: scheduled_at || new Date(),
        created_at: new Date()
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Live class created successfully',
      data: {
        liveClass: { ...newClass, join_url: joinUrlFor(newClass.id) },
        appId: appId
      }
    });
  } catch (error) {
    console.error('Live class creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create live class: ' + error.message
    });
  }
});

/**
 * GET /api/live-classes/my
 * List the live classes the current user can join.
 *  - Student: live classes across every course they're enrolled in.
 *  - Teacher: live classes they own.
 * Optional ?status=active,scheduled filter (comma separated).
 * This is what the mobile app renders as the "Live classes" list.
 */
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const statusFilter = (req.query.status || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    let query = supabase
      .from('live_classes')
      .select('*')
      .order('scheduled_at', { ascending: false });

    // course_id -> { joinable, reason }. joinable is false when the student
    // has no active subscription, or the course has live classes disabled.
    const courseGate = new Map();

    if (user.role === 'teacher') {
      query = query.eq('teacher_id', user.userId);
    } else {
      const { data: enrollments } = await supabase
        .from('course_enrollments')
        .select('course_id')
        .eq('student_id', user.userId);

      const courseIds = [...new Set((enrollments || []).map(e => e.course_id))];
      if (courseIds.length === 0) {
        return res.json({ success: true, data: { liveClasses: [] } });
      }

      const [{ data: courses }, subscribed] = await Promise.all([
        supabase.from('courses').select('id, live_enabled').in('id', courseIds),
        hasActiveSubscription({ supabase, studentId: user.userId })
      ]);

      (courses || []).forEach(c => {
        if (c.live_enabled === false) {
          courseGate.set(c.id, { joinable: false, reason: 'live_disabled' });
        } else if (subscribed) {
          courseGate.set(c.id, { joinable: true, reason: null });
        } else {
          courseGate.set(c.id, { joinable: false, reason: 'payment_required' });
        }
      });

      query = query.in('course_id', courseIds);
    }

    if (statusFilter.length > 0) {
      query = query.in('status', statusFilter);
    }

    const { data: liveClasses, error } = await query;
    if (error) throw error;

    const courseIds = [...new Set((liveClasses || []).map(lc => lc.course_id))];
    const teacherIds = [...new Set((liveClasses || []).map(lc => lc.teacher_id))];

    const [{ data: courses }, { data: teachers }] = await Promise.all([
      courseIds.length
        ? supabase.from('courses').select('id, title, color, icon, cover_image').in('id', courseIds)
        : Promise.resolve({ data: [] }),
      teacherIds.length
        ? supabase.from('users').select('id, name, avatar_url').in('id', teacherIds)
        : Promise.resolve({ data: [] })
    ]);

    const courseById = Object.fromEntries((courses || []).map(c => [c.id, c]));
    const teacherById = Object.fromEntries((teachers || []).map(t => [t.id, t]));

    const result = (liveClasses || []).map(lc => {
      const isTeacherView = user.role === 'teacher';
      const gate = courseGate.get(lc.course_id) || { joinable: false, reason: 'payment_required' };
      const locked = !isTeacherView && !gate.joinable;
      return {
        id: lc.id,
        title: lc.title,
        description: lc.description,
        status: lc.status,
        scheduled_at: lc.scheduled_at,
        started_at: lc.started_at,
        ended_at: lc.ended_at,
        course: courseById[lc.course_id] || { id: lc.course_id },
        teacher: teacherById[lc.teacher_id] || { id: lc.teacher_id },
        locked,
        lock_reason: locked ? gate.reason : null,
        // Students may only join once they're subscribed AND the teacher has started.
        can_join: isTeacherView || (!locked && lc.status === 'active'),
        join_url: joinUrlFor(lc.id)
      };
    });

    res.json({ success: true, data: { liveClasses: result } });
  } catch (error) {
    console.error('My live classes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live classes: ' + error.message
    });
  }
});

/**
 * GET /api/live-classes/course/:courseId
 * Get all live classes for a course
 */
router.get('/course/:courseId', authenticateToken, async (req, res) => {
  try {
    const { courseId } = req.params;

    const { data: liveClasses, error } = await supabase
      .from('live_classes')
      .select('*')
      .eq('course_id', courseId)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: {
        liveClasses: (liveClasses || []).map(lc => ({ ...lc, join_url: joinUrlFor(lc.id) }))
      }
    });
  } catch (error) {
    console.error('Course live classes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live classes: ' + error.message
    });
  }
});

/**
 * GET /api/live-classes/:id
 * Get live class details (must own it as teacher, or be enrolled as student)
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Get live class details
    const { data: liveClass, error } = await supabase
      .from('live_classes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !liveClass) {
      return res.status(404).json({
        success: false,
        error: 'Live class not found'
      });
    }

    const access = await resolveLiveClassAccess(liveClass, req.user);
    if (!access.allowed) {
      return res.status(403).json({ success: false, error: access.reason, code: access.code });
    }

    // 2. Get course info
    const { data: course } = await supabase
      .from('courses')
      .select('id, title')
      .eq('id', liveClass.course_id)
      .single();

    // 3. Get all active participants
    const { data: parts, error: partsError } = await supabase
      .from('live_class_participants')
      .select('id, live_class_id, user_id, role, joined_at, users(id, name, email, avatar_url)')
      .eq('live_class_id', id)
      .is('left_at', null);

    if (partsError) {
      console.error('Error fetching participants:', partsError);
    }

    // Stage state (who's speaking / hand up) — merged onto each participant so
    // the client can draw mic icons and floating hands without a second call.
    const stage = await getStage(id);
    const speakerIds = new Set(stage.speakers.map(s => s.user_id));
    const raisedIds = new Set(stage.raised_hands.map(s => s.user_id));

    const formattedParticipants = (parts || []).map(p => ({
      id: p.user_id,
      participant_id: p.id,
      name: p.users?.name || 'Unknown Student',
      email: p.users?.email,
      avatar: p.users?.avatar_url,
      role: p.role,
      joined_at: p.joined_at,
      speaking: speakerIds.has(p.user_id),
      hand_raised: raisedIds.has(p.user_id)
    }));

    res.json({
      success: true,
      data: {
        liveClass: {
          ...liveClass,
          course,
          join_url: joinUrlFor(liveClass.id),
          can_join: access.role === 'teacher' || liveClass.status === 'active',
          participants: formattedParticipants,
          participants_count: formattedParticipants.length,
          stage
        }
      }
    });
  } catch (error) {
    console.error('Live class fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live class: ' + error.message
    });
  }
});

/**
 * POST /api/live-classes/:id/token
 * Get Agora token for joining a live class.
 * Teacher (owner) or an enrolled student only. Students can only join an
 * "active" class.
 */
router.post('/:id/token', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: liveClass, error: classError } = await supabase
      .from('live_classes')
      .select('*')
      .eq('id', id)
      .single();

    if (classError || !liveClass) {
      return res.status(404).json({
        success: false,
        error: 'Live class not found'
      });
    }

    const access = await resolveLiveClassAccess(liveClass, req.user);
    if (!access.allowed) {
      return res.status(403).json({ success: false, error: access.reason, code: access.code });
    }

    if (access.role === 'student' && liveClass.status !== 'active') {
      return res.status(409).json({
        success: false,
        error: liveClass.status === 'completed'
          ? 'This live class has ended'
          : 'This live class has not started yet'
      });
    }

    // A student who is "speaking" joins as a co-host: publisher token so they
    // can turn on mic/camera in the same channel. No teacher approval needed.
    let rtcRole = access.role; // 'teacher' | 'student'
    if (rtcRole === 'student') {
      const { data: hand } = await supabase
        .from('live_class_hand_raises')
        .select('status')
        .eq('live_class_id', id)
        .eq('user_id', req.user.userId)
        .maybeSingle();
      if (hand?.status === 'speaking') rtcRole = 'co_host';
    }

    const numericUid = generateAgoraUid(req.user.userId);

    // generateAgoraToken maps 'teacher' -> PUBLISHER, anything else ->
    // SUBSCRIBER; pass 'teacher' for a co-host so they get a publisher token.
    const token = generateAgoraToken(
      liveClass.channel_name,
      numericUid,
      rtcRole === 'student' ? 'student' : 'teacher'
    );

    // Record the participant, reusing an existing open row so repeated
    // "join" calls (reconnects, app relaunch) don't pile up duplicates.
    const { data: openRow } = await supabase
      .from('live_class_participants')
      .select('id')
      .eq('live_class_id', id)
      .eq('user_id', req.user.userId)
      .is('left_at', null)
      .maybeSingle();

    if (openRow) {
      await supabase
        .from('live_class_participants')
        .update({ joined_at: new Date() })
        .eq('id', openRow.id);
    } else {
      await supabase
        .from('live_class_participants')
        .insert({
          id: uuidv4(),
          live_class_id: id,
          user_id: req.user.userId,
          role: req.user.role,
          joined_at: new Date()
        });
      await emitParticipantsChanged(id);
    }

    res.json({
      success: true,
      data: {
        token,
        channel: liveClass.channel_name,
        appId: appId,
        uid: numericUid,
        role: rtcRole, // 'teacher' | 'student' | 'co_host'
        liveClass: {
          id: liveClass.id,
          title: liveClass.title,
          status: liveClass.status
        }
      }
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate token: ' + error.message
    });
  }
});

/**
 * PUT /api/live-classes/:id/start
 * Start the live class (Teacher only)
 */
router.put('/:id/start', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: liveClass } = await supabase
      .from('live_classes')
      .select('teacher_id')
      .eq('id', id)
      .single();

    if (liveClass?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the teacher can start this class'
      });
    }

    const { data: updatedClass, error } = await supabase
      .from('live_classes')
      .update({
        status: 'active',
        started_at: new Date()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    emitClassStatus(id, 'active');

    res.json({
      success: true,
      message: 'Live class started',
      data: { liveClass: { ...updatedClass, join_url: joinUrlFor(updatedClass.id) } }
    });
  } catch (error) {
    console.error('Start class error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start class: ' + error.message
    });
  }
});

/**
 * PUT /api/live-classes/:id/end
 * End the live class (Teacher only)
 */
router.put('/:id/end', authenticateToken, isTeacher, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: liveClass } = await supabase
      .from('live_classes')
      .select('teacher_id')
      .eq('id', id)
      .single();

    if (liveClass?.teacher_id !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the teacher can end this class'
      });
    }

    const { data: updatedClass, error } = await supabase
      .from('live_classes')
      .update({
        status: 'completed',
        ended_at: new Date()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Mark all participants as left
    await supabase
      .from('live_class_participants')
      .update({ left_at: new Date() })
      .eq('live_class_id', id)
      .is('left_at', null);

    // Clear all hand-raise / co-host requests for the finished class.
    await supabase
      .from('live_class_hand_raises')
      .delete()
      .eq('live_class_id', id);

    // "End class" is also the teacher's "leave" — everyone is now out.
    emitClassStatus(id, 'completed');
    await emitStageChanged(id);
    await emitParticipantsChanged(id);

    res.json({
      success: true,
      message: 'Live class ended',
      data: { liveClass: updatedClass }
    });
  } catch (error) {
    console.error('End class error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to end class: ' + error.message
    });
  }
});

/**
 * POST /api/live-classes/:id/leave
 * Student/Teacher leave the live class
 */
router.post('/:id/leave', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('live_class_participants')
      .update({ left_at: new Date() })
      .eq('live_class_id', id)
      .eq('user_id', req.user.userId)
      .is('left_at', null);

    if (error) throw error;

    // Drop any stage state so a student who leaves stops showing as a speaker
    // / hand-raiser in the web portal.
    await supabase
      .from('live_class_hand_raises')
      .delete()
      .eq('live_class_id', id)
      .eq('user_id', req.user.userId);

    emitHandUpdate(id, req.user.userId, 'none');
    await emitStageChanged(id);
    await emitParticipantsChanged(id);

    res.json({
      success: true,
      message: 'Left the live class'
    });
  } catch (error) {
    console.error('Leave class error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to leave class: ' + error.message
    });
  }
});

// ============================================================================
// Raise hand / co-host
//
// Writes go through these REST endpoints; realtime fan-out to the other
// participants happens over Socket.IO (src/realtime/liveClassSocket.js). The
// client subscribes once on entering the call and never polls.
// ============================================================================

/** Load a live class + resolve the caller's access in one step. */
async function loadClassWithAccess(id, user) {
  const { data: liveClass } = await supabase
    .from('live_classes')
    .select('*')
    .eq('id', id)
    .single();

  if (!liveClass) return { error: { status: 404, message: 'Live class not found' } };

  const access = await resolveLiveClassAccess(liveClass, user);
  if (!access.allowed) return { error: { status: 403, message: access.reason, code: access.code }, liveClass };

  return { liveClass, access };
}

/** One student's current stage status: 'none' | 'raised' | 'speaking'. */
async function readStatus(liveClassId, userId) {
  const { data } = await supabase
    .from('live_class_hand_raises')
    .select('status')
    .eq('live_class_id', liveClassId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.status || 'none';
}

/**
 * POST /api/live-classes/:id/hand
 * body: { mode: "raise" | "speak" }   (default "speak")
 *
 *   "raise" -> status "raised":  a floating hand appears on the student's tile
 *              for everyone (Google-Meet style). Not a request queue, no
 *              approval — the teacher just sees it.
 *   "speak" -> status "speaking": the student becomes a co-host and may
 *              publish mic/camera. Any raised hand is cleared automatically.
 *              The client then calls POST /:id/token for the publisher token.
 */
router.post('/:id/hand', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const mode = req.body?.mode === 'raise' ? 'raise' : 'speak';
    const status = mode === 'raise' ? 'raised' : 'speaking';

    const { liveClass, access, error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });

    if (access.role !== 'student') {
      return res.status(403).json({ success: false, error: 'Only students can do this' });
    }
    if (liveClass.status !== 'active') {
      return res.status(409).json({ success: false, error: 'This live class is not active' });
    }

    const { error: upsertError } = await supabase
      .from('live_class_hand_raises')
      .upsert({
        live_class_id: id,
        user_id: req.user.userId,
        status,
        updated_at: new Date()
      }, { onConflict: 'live_class_id,user_id' });

    if (upsertError) throw upsertError;

    if (status === 'raised') {
      const { data: me } = await supabase
        .from('users').select('name').eq('id', req.user.userId).single();
      emitHandRaised(id, req.user.userId, me?.name || 'Student');
    }
    emitHandUpdate(id, req.user.userId, status);
    await emitStageChanged(id);

    res.json({ success: true, data: { status } });
  } catch (err) {
    console.error('Hand/voice error:', err);
    res.status(500).json({ success: false, error: 'Failed: ' + err.message });
  }
});

/**
 * DELETE /api/live-classes/:id/hand
 * Student lowers their hand AND/OR stops speaking -> "none".
 */
router.delete('/:id/hand', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });

    const prev = await readStatus(id, req.user.userId);

    const { error: delError } = await supabase
      .from('live_class_hand_raises')
      .delete()
      .eq('live_class_id', id)
      .eq('user_id', req.user.userId);

    if (delError) throw delError;

    if (prev === 'raised') emitHandLowered(id, req.user.userId);
    emitHandUpdate(id, req.user.userId, 'none');
    await emitStageChanged(id);

    res.json({ success: true, data: { status: 'none' } });
  } catch (err) {
    console.error('Lower hand error:', err);
    res.status(500).json({ success: false, error: 'Failed to lower hand: ' + err.message });
  }
});

/**
 * GET /api/live-classes/:id/hand
 * Student's own status — socket-down fallback.
 */
router.get('/:id/hand', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });

    res.json({ success: true, data: { status: await readStatus(id, req.user.userId) } });
  } catch (err) {
    console.error('Hand status error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch hand status: ' + err.message });
  }
});

/**
 * GET /api/live-classes/:id/stage
 * Current speakers + raised hands — socket-down fallback for both roles.
 * (Replaces the old /hands "request list".)
 */
router.get('/:id/stage', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });

    res.json({ success: true, data: { stage: await getStage(id) } });
  } catch (err) {
    console.error('Stage error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch stage: ' + err.message });
  }
});

/**
 * POST /api/live-classes/:id/speakers/:userId/invite
 * Teacher invites a student to speak (optional; students self-start too).
 */
router.post('/:id/speakers/:userId/invite', authenticateToken, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { access, error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    if (access.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Teacher only' });
    }

    const { error: upsertError } = await supabase
      .from('live_class_hand_raises')
      .upsert({
        live_class_id: id,
        user_id: userId,
        status: 'speaking',
        updated_at: new Date()
      }, { onConflict: 'live_class_id,user_id' });

    if (upsertError) throw upsertError;

    emitHandUpdate(id, userId, 'speaking');
    await emitStageChanged(id);

    res.json({ success: true });
  } catch (err) {
    console.error('Invite speaker error:', err);
    res.status(500).json({ success: false, error: 'Failed to invite: ' + err.message });
  }
});

/**
 * POST /api/live-classes/:id/speakers/:userId/mute
 * Teacher mutes a speaker — NOT strict. The student stays a co-host; their app
 * just turns the mic off on the "speaker:mute" event and the student can
 * unmute themselves again immediately. No DB change.
 */
router.post('/:id/speakers/:userId/mute', authenticateToken, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { access, error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    if (access.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Teacher only' });
    }

    emitForceMute(id, userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Mute speaker error:', err);
    res.status(500).json({ success: false, error: 'Failed to mute: ' + err.message });
  }
});

/**
 * POST /api/live-classes/:id/speakers/:userId/remove
 * Teacher removes a student from the stage -> "none". They drop back to
 * audience. NOT a ban — they can raise a hand / open voice again later.
 * (Aliases kept: /hands/:userId/revoke, /hands/:userId/remove)
 */
async function removeSpeaker(req, res) {
  try {
    const { id, userId } = req.params;
    const { access, error } = await loadClassWithAccess(id, req.user);
    if (error) return res.status(error.status).json({ success: false, error: error.message, code: error.code });
    if (access.role !== 'teacher') {
      return res.status(403).json({ success: false, error: 'Teacher only' });
    }

    const prev = await readStatus(id, userId);

    const { error: delErr } = await supabase
      .from('live_class_hand_raises')
      .delete()
      .eq('live_class_id', id)
      .eq('user_id', userId);

    if (delErr) throw delErr;

    if (prev === 'raised') emitHandLowered(id, userId);
    emitHandUpdate(id, userId, 'none');
    await emitStageChanged(id);

    res.json({ success: true });
  } catch (err) {
    console.error('Remove speaker error:', err);
    res.status(500).json({ success: false, error: 'Failed to remove: ' + err.message });
  }
}

router.post('/:id/speakers/:userId/remove', authenticateToken, removeSpeaker);
router.post('/:id/hands/:userId/remove', authenticateToken, removeSpeaker);
router.post('/:id/hands/:userId/revoke', authenticateToken, removeSpeaker);

module.exports = router;
