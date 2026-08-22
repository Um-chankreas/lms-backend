
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isTeacher } = require('../middleware/auth');
const { generateAgoraToken, appId } = require('../utils/agoraToken');
const { v4: uuidv4 } = require('uuid');
 
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
        liveClass: newClass,
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
 * GET /api/live-classes/:id
 * Get live class details
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
 
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
 
    // Get course info
    const { data: course } = await supabase
      .from('courses')
      .select('id, title')
      .eq('id', liveClass.course_id)
      .single();
 
    // Get active participants if class is active
    let participants = [];
    if (liveClass.status === 'active') {
      const { data: parts } = await supabase
        .from('live_class_participants')
        .select('*, users(name)')
        .eq('live_class_id', id)
        .eq('left_at', null); // Only active participants
      participants = parts || [];
    }
 
    res.json({
      success: true,
      data: {
        liveClass: {
          ...liveClass,
          course,
          participants,
          participants_count: participants.length
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
      data: { liveClasses }
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
 * POST /api/live-classes/:id/token
 * Get Agora token for joining live class
 * Both teacher and student use this endpoint
 */
router.post('/:id/token', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
 
    // Get live class
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
 
    // Generate Agora token
    const token = generateAgoraToken(
      liveClass.channel_name,
      req.user.userId.substring(0, 8), // Use first 8 chars of UUID as numeric UID
      req.user.role
    );
 
    // Record participant
    const participantId = uuidv4();
    await supabase
      .from('live_class_participants')
      .insert({
        id: participantId,
        live_class_id: id,
        user_id: req.user.userId,
        role: req.user.role,
        joined_at: new Date()
      })
      .single();
 
    res.json({
      success: true,
      data: {
        token,
        channel: liveClass.channel_name,
        appId: appId,
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
 
    // Verify ownership
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
 
    res.json({
      success: true,
      message: 'Live class started',
      data: { liveClass: updatedClass }
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
 
    // Verify ownership
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
 
    // Mark participant as left
    const { error } = await supabase
      .from('live_class_participants')
      .update({ left_at: new Date() })
      .eq('live_class_id', id)
      .eq('user_id', req.user.userId)
      .is('left_at', null);
 
    if (error) throw error;
 
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
 
module.exports = router;