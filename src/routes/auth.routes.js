const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../config/supabase');
const { generateToken } = require('../utils/jwt');
const { authenticateToken } = require('../middleware/auth');
const { normalizePhone, isValidPhone } = require('../utils/phone');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const AVATAR_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (AVATAR_ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, or WEBP images are allowed'));
    }
  }
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_HELP = 'Enter a valid phone number, e.g. 092123456 or +85592123456';

const normalizeEmail = (email) => String(email).trim().toLowerCase();

const sanitizeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone || null,
  role: user.role,
  avatar_url: user.avatar_url || null,
  bio: user.bio || null,
  created_at: user.created_at
});

/**
 * Checks whether an authenticated user (correct password / verified OTP) is
 * actually allowed to start a session. Returns { status, body } to send when
 * they are blocked, or null when the login may proceed.
 */
const accountLoginGate = (user) => {
  if (user.deleted_at) {
    return { status: 410, body: { success: false, error: 'This account has been permanently deleted' } };
  }
  if (user.deletion_scheduled_at) {
    return {
      status: 403,
      body: {
        success: false,
        code: 'ACCOUNT_PENDING_DELETION',
        error: `This account is scheduled for deletion on ${String(user.deletion_scheduled_at).slice(0, 10)}. `
          + 'Restore it via POST /api/auth/account/restore to cancel.',
        data: { deletion_scheduled_at: user.deletion_scheduled_at }
      }
    };
  }
  if (user.is_active === false && !user.deactivated_at) {
    return { status: 403, body: { success: false, error: 'This account has been deactivated. Contact your administrator.' } };
  }
  return null;
};

/**
 * A user who deactivated their own account reactivates it just by
 * authenticating again (password or OTP). Mutates `user` in place.
 */
const reactivateIfSelfDeactivated = async (user) => {
  if (user.is_active === false && user.deactivated_at) {
    await supabase
      .from('users')
      .update({ is_active: true, deactivated_at: null })
      .eq('id', user.id);
    user.is_active = true;
    user.deactivated_at = null;
  }
};

/**
 * POST /api/auth/signup
 * Register a new user (teacher or student).
 * Students must provide a phone number so they can later log in with it.
 */
router.post('/signup', async (req, res) => {
  try {
    let { name, email, phone, password, role } = req.body;
    role = role || 'student';

    if (!['teacher', 'student'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Role must be either "teacher" or "student"'
      });
    }

    if (!name || !password) {
      return res.status(400).json({
        success: false,
        error: 'Name and password are required'
      });
    }

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        error: 'Email or phone number is required'
      });
    }

    if (role === 'teacher' && !email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required for teacher signup'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    let normalizedEmail = null;
    if (email) {
      normalizedEmail = normalizeEmail(email);
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email address'
        });
      }
    }

    let normalizedPhone = null;
    if (phone) {
      normalizedPhone = normalizePhone(phone);
      if (!isValidPhone(normalizedPhone)) {
        return res.status(400).json({
          success: false,
          error: PHONE_HELP
        });
      }
    }

    // Check if email already exists
    if (normalizedEmail) {
      const { data: existingEmail } = await supabase
        .from('users')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (existingEmail) {
        return res.status(409).json({
          success: false,
          error: 'Email already registered'
        });
      }
    }

    // Check if phone already exists
    if (normalizedPhone) {
      const { data: existingPhone } = await supabase
        .from('users')
        .select('id')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (existingPhone) {
        return res.status(409).json({
          success: false,
          error: 'Phone number already registered'
        });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const userId = uuidv4();
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        id: userId,
        name,
        email: normalizedEmail,
        phone: normalizedPhone,
        password: hashedPassword,
        role,
        created_at: new Date()
      })
      .select()
      .single();

    if (createError) throw createError;

    // Generate JWT token
    const token = generateToken(newUser.id, newUser.role);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        user: sanitizeUser(newUser),
        token
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Signup failed: ' + error.message
    });
  }
});

/**
 * POST /api/auth/login
 * Login with { identifier, password } where identifier is an email or phone number.
 * Also accepts { email, password } for backward compatibility.
 */
router.post('/login', async (req, res) => {
  try {
    const { identifier, email, phone, password } = req.body;
    const rawIdentifier = String(identifier || email || phone || '').trim();

    if (!rawIdentifier || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email/phone and password are required'
      });
    }

    const isEmail = rawIdentifier.includes('@');

    let query = supabase.from('users').select('*');
    query = isEmail
      ? query.eq('email', normalizeEmail(rawIdentifier))
      : query.eq('phone', normalizePhone(rawIdentifier));

    const { data: user } = await query.maybeSingle();

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Compare passwords
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const gate = accountLoginGate(user);
    if (gate) return res.status(gate.status).json(gate.body);

    await reactivateIfSelfDeactivated(user);

    // Generate JWT token
    const token = generateToken(user.id, user.role);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: sanitizeUser(user),
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed: ' + error.message
    });
  }
});

/**
 * GET /api/auth/profile
 * Get current user profile (requires authentication)
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, phone, role, avatar_url, bio, created_at')
      .eq('id', req.user.userId)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: { user }
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile: ' + error.message
    });
  }
});

/**
 * PUT /api/auth/profile
 * Update user profile (requires authentication)
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    let { name, email, phone, bio } = req.body;
    const updates = {};

    if (name) updates.name = name;
    if (bio !== undefined) updates.bio = bio;

    if (email) {
      email = normalizeEmail(email);
      if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email address'
        });
      }

      const { data: existingEmail } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', req.user.userId)
        .maybeSingle();

      if (existingEmail) {
        return res.status(409).json({
          success: false,
          error: 'Email already registered'
        });
      }

      updates.email = email;
    }

    if (phone) {
      const normalizedPhone = normalizePhone(phone);
      if (!isValidPhone(normalizedPhone)) {
        return res.status(400).json({
          success: false,
          error: PHONE_HELP
        });
      }

      const { data: existingPhone } = await supabase
        .from('users')
        .select('id')
        .eq('phone', normalizedPhone)
        .neq('id', req.user.userId)
        .maybeSingle();

      if (existingPhone) {
        return res.status(409).json({
          success: false,
          error: 'Phone number already registered'
        });
      }

      updates.phone = normalizedPhone;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nothing to update'
      });
    }

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: sanitizeUser(updatedUser)
      }
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile: ' + error.message
    });
  }
});

/**
 * PUT /api/auth/profile/avatar
 * Upload/replace the current user's profile picture (student or teacher).
 * multipart/form-data with a single "avatar" file field.
 */
router.put('/profile/avatar', authenticateToken, avatarUpload.single('avatar'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'Avatar image is required'
      });
    }

    const { data: currentUser } = await supabase
      .from('users')
      .select('avatar_url')
      .eq('id', req.user.userId)
      .single();

    const ext = file.mimetype.split('/')[1];
    const fileName = `${req.user.userId}-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase
      .storage
      .from('avatars')
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (uploadError) throw uploadError;

    const avatarUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/${fileName}`;

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl })
      .eq('id', req.user.userId)
      .select()
      .single();

    if (error) throw error;

    // Best-effort cleanup of the old file now that the new one is saved
    if (currentUser?.avatar_url) {
      const oldFileName = currentUser.avatar_url.split('/storage/v1/object/public/avatars/')[1];
      if (oldFileName) {
        await supabase.storage.from('avatars').remove([oldFileName]);
      }
    }

    res.json({
      success: true,
      message: 'Avatar updated successfully',
      data: { user: sanitizeUser(updatedUser) }
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update avatar: ' + error.message
    });
  }
});

// Days between requesting deletion and the account being permanently purged.
const DELETION_GRACE_DAYS = 30;

/**
 * Loads the authenticated user's row and checks the supplied password.
 * On failure it sends the error response and returns null.
 */
async function verifyCurrentPassword(req, res) {
  const { password } = req.body;
  if (!password) {
    res.status(400).json({ success: false, error: 'Current password is required' });
    return null;
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', req.user.userId)
    .single();

  if (error || !user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return null;
  }

  const passwordMatch = await bcrypt.compare(password, user.password);
  if (!passwordMatch) {
    res.status(401).json({ success: false, error: 'Incorrect password' });
    return null;
  }

  return user;
}

/**
 * POST /api/auth/deactivate
 * Temporarily disable the current user's account. They are signed out and
 * can't log in until they reactivate — which happens automatically the next
 * time they log in with the correct credentials. No data is removed.
 * Body: { password }
 */
router.post('/deactivate', authenticateToken, async (req, res) => {
  try {
    const user = await verifyCurrentPassword(req, res);
    if (!user) return;

    if (user.deletion_scheduled_at) {
      return res.status(409).json({
        success: false,
        error: 'This account is already scheduled for deletion'
      });
    }

    const { error } = await supabase
      .from('users')
      .update({ is_active: false, deactivated_at: new Date() })
      .eq('id', user.id);
    if (error) throw error;

    res.json({
      success: true,
      message: 'Your account has been deactivated. Log in again anytime to reactivate it.'
    });
  } catch (error) {
    console.error('Deactivate account error:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate account: ' + error.message });
  }
});

/**
 * DELETE /api/auth/account
 * Request permanent deletion of the current user's account. It is disabled
 * immediately and permanently erased after a 30-day grace period
 * (scripts/purge-deleted-accounts.js). The user can cancel any time before
 * then via POST /api/auth/account/restore.
 * Body: { password }
 */
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    const user = await verifyCurrentPassword(req, res);
    if (!user) return;

    if (user.deletion_scheduled_at) {
      return res.json({
        success: true,
        message: 'This account is already scheduled for deletion',
        data: { deletion_scheduled_at: user.deletion_scheduled_at }
      });
    }

    const now = new Date();
    const scheduledAt = new Date(now.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);

    const { error } = await supabase
      .from('users')
      .update({
        is_active: false,
        deactivated_at: user.deactivated_at || now,
        deletion_requested_at: now,
        deletion_scheduled_at: scheduledAt
      })
      .eq('id', user.id);
    if (error) throw error;

    res.json({
      success: true,
      message: `Your account has been scheduled for deletion and will be permanently erased on `
        + `${scheduledAt.toISOString().slice(0, 10)}. Log in and restore it before then to cancel.`,
      data: { deletion_scheduled_at: scheduledAt.toISOString() }
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete account: ' + error.message });
  }
});

/**
 * POST /api/auth/account/restore
 * Reactivate an account the user deactivated or scheduled for deletion,
 * provided the 30-day grace period hasn't elapsed. No token required — the
 * user can't log in while the account is disabled.
 * Body: { identifier | email | phone, password }
 */
router.post('/account/restore', async (req, res) => {
  try {
    const { identifier, email, phone, password } = req.body;
    const rawIdentifier = String(identifier || email || phone || '').trim();

    if (!rawIdentifier || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email/phone and password are required'
      });
    }

    const isEmail = rawIdentifier.includes('@');
    let query = supabase.from('users').select('*');
    query = isEmail
      ? query.eq('email', normalizeEmail(rawIdentifier))
      : query.eq('phone', normalizePhone(rawIdentifier));

    const { data: user } = await query.maybeSingle();

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (user.deleted_at) {
      return res.status(410).json({
        success: false,
        error: 'This account has already been permanently deleted'
      });
    }

    const selfDisabled = !!user.deactivated_at || !!user.deletion_scheduled_at;
    if (user.is_active === false && !selfDisabled) {
      return res.status(403).json({
        success: false,
        error: 'This account has been deactivated by an administrator. Please contact support.'
      });
    }

    if (user.is_active !== false && !user.deletion_scheduled_at) {
      // Nothing to restore — hand back a fresh token so the client can just log in.
      const token = generateToken(user.id, user.role);
      return res.json({
        success: true,
        message: 'Account is already active',
        data: { user: sanitizeUser(user), token }
      });
    }

    const { data: restored, error } = await supabase
      .from('users')
      .update({
        is_active: true,
        deactivated_at: null,
        deletion_requested_at: null,
        deletion_scheduled_at: null
      })
      .eq('id', user.id)
      .select()
      .single();
    if (error) throw error;

    const token = generateToken(restored.id, restored.role);
    res.json({
      success: true,
      message: 'Your account has been restored.',
      data: { user: sanitizeUser(restored), token }
    });
  } catch (error) {
    console.error('Restore account error:', error);
    res.status(500).json({ success: false, error: 'Failed to restore account: ' + error.message });
  }
});

module.exports = router;
