const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');

const {
  authenticateToken,
  isTeacher
} = require('../middleware/auth');

const {
  generateAgoraToken,
  appId
} = require('../utils/agoraToken');

const {
  generateAgoraUid
} = require('../utils/agoraUid');

const {
  v4: uuidv4
} = require('uuid');


/**
 * =========================================================
 * CREATE LIVE CLASS
 * POST /api/live-classes
 * Teacher only
 * =========================================================
 */
router.post(
  '/',
  authenticateToken,
  isTeacher,
  async (req, res) => {
    try {
      const {
        course_id,
        title,
        description,
        scheduled_at
      } = req.body;

      if (!course_id || !title) {
        return res.status(400).json({
          success: false,
          error: 'Course ID and title are required'
        });
      }

      // Check course ownership
      const {
        data: course,
        error: courseError
      } = await supabase
        .from('courses')
        .select('id, teacher_id, title')
        .eq('id', course_id)
        .single();

      if (courseError || !course) {
        return res.status(404).json({
          success: false,
          error: 'Course not found'
        });
      }

      if (course.teacher_id !== req.user.userId) {
        return res.status(403).json({
          success: false,
          error: 'You can only create live classes for your own courses'
        });
      }

      const classId = uuidv4();

      const channelName = `class_${classId}`;

      const {
        data: newClass,
        error
      } = await supabase
        .from('live_classes')
        .insert({
          id: classId,
          course_id,
          teacher_id: req.user.userId,
          title,
          description: description || '',
          channel_name: channelName,
          status: 'scheduled',
          scheduled_at:
            scheduled_at || new Date().toISOString(),
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return res.status(201).json({
        success: true,
        message: 'Live class created successfully',
        data: {
          liveClass: newClass,
          appId
        }
      });

    } catch (error) {
      console.error(
        'Live class creation error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to create live class: ' +
          error.message
      });
    }
  }
);


/**
 * =========================================================
 * GET LIVE CLASS
 * GET /api/live-classes/:id
 * =========================================================
 */
router.get(
  '/:id',
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      const {
        data: liveClass,
        error
      } = await supabase
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

      const {
        data: course
      } = await supabase
        .from('courses')
        .select('id, title')
        .eq('id', liveClass.course_id)
        .single();

      let participants = [];

      if (liveClass.status === 'active') {
        const {
          data: parts
        } = await supabase
          .from('live_class_participants')
          .select(`
            *,
            users (
              id,
              name
            )
          `)
          .eq('live_class_id', id)
          .is('left_at', null);

        participants = parts || [];
      }

      return res.json({
        success: true,
        data: {
          liveClass: {
            ...liveClass,
            course,
            participants,
            participants_count:
              participants.length
          }
        }
      });

    } catch (error) {
      console.error(
        'Live class fetch error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to fetch live class: ' +
          error.message
      });
    }
  }
);


/**
 * =========================================================
 * GET LIVE CLASSES BY COURSE
 * GET /api/live-classes/course/:courseId
 * =========================================================
 */
router.get(
  '/course/:courseId',
  authenticateToken,
  async (req, res) => {
    try {
      const { courseId } = req.params;

      const {
        data: liveClasses,
        error
      } = await supabase
        .from('live_classes')
        .select('*')
        .eq('course_id', courseId)
        .order('scheduled_at', {
          ascending: false
        });

      if (error) {
        throw error;
      }

      return res.json({
        success: true,
        data: {
          liveClasses: liveClasses || []
        }
      });

    } catch (error) {
      console.error(
        'Course live classes error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to fetch live classes: ' +
          error.message
      });
    }
  }
);


/**
 * =========================================================
 * GET AGORA TOKEN
 * POST /api/live-classes/:id/token
 * Teacher + Student
 * =========================================================
 */
router.post(
  '/:id/token',
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Get live class
      const {
        data: liveClass,
        error: classError
      } = await supabase
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

      /**
       * -----------------------------------------------
       * Check class status
       * -----------------------------------------------
       */
      if (
        liveClass.status !== 'active' &&
        req.user.role !== 'teacher'
      ) {
        return res.status(400).json({
          success: false,
          error: 'This live class is not active yet'
        });
      }

      /**
       * -----------------------------------------------
       * Generate stable numeric Agora UID
       * -----------------------------------------------
       */
      const agoraUid = generateAgoraUid(
        req.user.userId
      );

      console.log(
        'Generating Agora token:',
        {
          userId: req.user.userId,
          agoraUid,
          role: req.user.role,
          channel: liveClass.channel_name,
          appId
        }
      );

      /**
       * -----------------------------------------------
       * Generate token
       * -----------------------------------------------
       */
      const token = generateAgoraToken(
        liveClass.channel_name,
        agoraUid,
        req.user.role
      );

      /**
       * -----------------------------------------------
       * Record participant
       * -----------------------------------------------
       */

      // Check if already joined
      const {
        data: existingParticipant
      } = await supabase
        .from('live_class_participants')
        .select('id')
        .eq('live_class_id', id)
        .eq('user_id', req.user.userId)
        .is('left_at', null)
        .maybeSingle();

      if (!existingParticipant) {
        await supabase
          .from('live_class_participants')
          .insert({
            id: uuidv4(),
            live_class_id: id,
            user_id: req.user.userId,
            role: req.user.role,
            joined_at: new Date().toISOString()
          });
      }

      return res.json({
        success: true,
        data: {
          token,
          channel: liveClass.channel_name,
          appId,

          // VERY IMPORTANT
          uid: agoraUid,

          liveClass: {
            id: liveClass.id,
            title: liveClass.title,
            status: liveClass.status
          }
        }
      });

    } catch (error) {
      console.error(
        'Token generation error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to generate token: ' +
          error.message
      });
    }
  }
);


/**
 * =========================================================
 * START LIVE CLASS
 * PUT /api/live-classes/:id/start
 * Teacher only
 * =========================================================
 */
router.put(
  '/:id/start',
  authenticateToken,
  isTeacher,
  async (req, res) => {
    try {
      const { id } = req.params;

      const {
        data: liveClass
      } = await supabase
        .from('live_classes')
        .select('teacher_id, status')
        .eq('id', id)
        .single();

      if (!liveClass) {
        return res.status(404).json({
          success: false,
          error: 'Live class not found'
        });
      }

      if (
        liveClass.teacher_id !==
        req.user.userId
      ) {
        return res.status(403).json({
          success: false,
          error:
            'Only the teacher can start this class'
        });
      }

      const {
        data: updatedClass,
        error
      } = await supabase
        .from('live_classes')
        .update({
          status: 'active',
          started_at:
            new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return res.json({
        success: true,
        message: 'Live class started',
        data: {
          liveClass: updatedClass
        }
      });

    } catch (error) {
      console.error(
        'Start class error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to start class: ' +
          error.message
      });
    }
  }
);


/**
 * =========================================================
 * END LIVE CLASS
 * PUT /api/live-classes/:id/end
 * Teacher only
 * =========================================================
 */
router.put(
  '/:id/end',
  authenticateToken,
  isTeacher,
  async (req, res) => {
    try {
      const { id } = req.params;

      const {
        data: liveClass
      } = await supabase
        .from('live_classes')
        .select('teacher_id')
        .eq('id', id)
        .single();

      if (!liveClass) {
        return res.status(404).json({
          success: false,
          error: 'Live class not found'
        });
      }

      if (
        liveClass.teacher_id !==
        req.user.userId
      ) {
        return res.status(403).json({
          success: false,
          error:
            'Only the teacher can end this class'
        });
      }

      const {
        data: updatedClass,
        error
      } = await supabase
        .from('live_classes')
        .update({
          status: 'completed',
          ended_at:
            new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      await supabase
        .from('live_class_participants')
        .update({
          left_at:
            new Date().toISOString()
        })
        .eq('live_class_id', id)
        .is('left_at', null);

      return res.json({
        success: true,
        message: 'Live class ended',
        data: {
          liveClass: updatedClass
        }
      });

    } catch (error) {
      console.error(
        'End class error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to end class: ' +
          error.message
      });
    }
  }
);


/**
 * =========================================================
 * LEAVE LIVE CLASS
 * POST /api/live-classes/:id/leave
 * =========================================================
 */
router.post(
  '/:id/leave',
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      const {
        error
      } = await supabase
        .from('live_class_participants')
        .update({
          left_at:
            new Date().toISOString()
        })
        .eq('live_class_id', id)
        .eq('user_id', req.user.userId)
        .is('left_at', null);

      if (error) {
        throw error;
      }

      return res.json({
        success: true,
        message: 'Left the live class'
      });

    } catch (error) {
      console.error(
        'Leave class error:',
        error
      );

      return res.status(500).json({
        success: false,
        error:
          'Failed to leave class: ' +
          error.message
      });
    }
  }
);


module.exports = router;