const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../config/supabase');
const { generateToken } = require('../utils/jwt');
const { authenticateToken } = require('../middleware/auth');
const { normalizePhone, isValidPhone } = require('../utils/phone');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { rateLimit } = require('express-rate-limit');

// Brute-force protection, per client IP. Limits are generous because a whole
// classroom can share one IP: login/restore only count FAILED attempts, so
// students signing in successfully never use up the budget.
const rateLimitResponse = (message) => ({ success: false, code: 'RATE_LIMITED', error: message });
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: rateLimitResponse('Too many failed attempts. Please wait 15 minutes and try again.')
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: rateLimitResponse('Too many accounts created from this network. Please try again later.')
});

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
  notification_style: user.notification_style || 'balanced',
  language: user.language || 'km',   // which language notifications are written in
  created_at: user.created_at,
  // Self-service account state — lets the client show a "reactivate" /
  // "cancel deletion" banner instead of forcing a logout.
  deactivated_at: user.deactivated_at || null,
  deletion_scheduled_at: user.deletion_scheduled_at || null
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
  // A pending self-deletion no longer blocks login: the user keeps full access
  // during the 30-day grace window and the app shows a "cancel deletion"
  // banner. Only once the grace window has elapsed (purge hasn't run yet) do
  // we refuse — the account is effectively gone.
  if (user.deletion_scheduled_at && new Date(user.deletion_scheduled_at) <= new Date()) {
    return { status: 410, body: { success: false, error: 'This account has been permanently deleted' } };
  }
  if (user.is_active === false && !user.deactivated_at && !user.deletion_scheduled_at) {
    return { status: 403, body: { success: false, error: 'This account has been deactivated. Contact your administrator.' } };
  }
  return null;
};

/**
 * A user who deactivated their own account reactivates it just by
 * authenticating again (password or OTP). Mutates `user` in place.
 */
const reactivateIfSelfDeactivated = async (user) => {
  // Leave a pending-deletion account alone — that's undone explicitly from the
  // "cancel deletion" banner, not implicitly by logging in.
  if (user.deletion_scheduled_at) return;
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
router.post('/signup', signupLimiter, async (req, res) => {
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
router.post('/login', credentialLimiter, async (req, res) => {
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
 * POST /api/auth/google
 * Sign in with Google. The app gets a Google ID token on the phone and sends it
 * here; we verify it with Google's public keys, then issue the same JWT as a
 * password login. Body: { idToken }.
 *
 * Accepted audiences: GOOGLE_CLIENT_IDS (comma-separated OAuth client ids: the
 * Web client, plus the iOS / Android clients). Only verified Google emails are
 * accepted.
 *
 * Matching: a returning Google user is found by google_sub. Otherwise a student
 * account with the same verified email is linked to this Google account and
 * signed in (its password keeps working). Otherwise a new student account is
 * created. Google sign-in never creates or logs in teachers/admins.
 */
let googleClient = null;
const googleAudiences = () => String(process.env.GOOGLE_CLIENT_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

router.post('/google', credentialLimiter, async (req, res) => {
  try {
    const audiences = googleAudiences();
    if (audiences.length === 0) {
      return res.status(503).json({ success: false, error: 'Google sign-in is not configured' });
    }
    const idToken = String(req.body?.idToken || '');
    if (!idToken || idToken.length > 4096) {
      return res.status(400).json({ success: false, error: 'Google token is required' });
    }

    if (!googleClient) {
      const { OAuth2Client } = require('google-auth-library');
      googleClient = new OAuth2Client();
    }
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Google sign-in failed. Please try again.' });
    }
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({ success: false, error: 'Your Google email is not verified' });
    }

    const email = normalizeEmail(payload.email);
    let { data: user } = await supabase
      .from('users').select('*').eq('google_sub', payload.sub).maybeSingle();
    let isNew = false;

    if (!user) {
      // Same verified email as an existing account: that person signs in to it,
      // and Google is linked so next time it is matched by google_sub. The
      // password stays valid, so password login keeps working.
      const { data: sameEmail } = await supabase
        .from('users').select('*').eq('email', email).maybeSingle();
      if (sameEmail) {
        if (sameEmail.google_sub && sameEmail.google_sub !== payload.sub) {
          return res.status(409).json({
            success: false,
            code: 'GOOGLE_ACCOUNT_MISMATCH',
            error: 'This account is linked to a different Google account. Sign in with your password instead.'
          });
        }
        if (sameEmail.role === 'student' && !sameEmail.google_sub) {
          const { error: linkError } = await supabase
            .from('users').update({ google_sub: payload.sub }).eq('id', sameEmail.id);
          if (linkError) throw linkError;
          sameEmail.google_sub = payload.sub;
        }
        user = sameEmail;
      }
    }

    if (!user) {
      const name = String(payload.name || email.split('@')[0]).trim().slice(0, 100) || 'Student';
      // No one can sign in with a password they don't know; "forgot password"
      // style flows can set a real one later.
      const unusablePassword = await bcrypt.hash(uuidv4() + uuidv4(), 10);
      const { data: created, error: createError } = await supabase
        .from('users')
        .insert({
          id: uuidv4(),
          name,
          email,
          phone: null,
          password: unusablePassword,
          role: 'student',
          google_sub: payload.sub,
          created_at: new Date()
        })
        .select()
        .single();
      if (createError) throw createError;
      user = created;
      isNew = true;
    }

    if (user.role !== 'student') {
      return res.status(403).json({ success: false, error: 'Google sign-in is for student accounts only' });
    }
    const gate = accountLoginGate(user);
    if (gate) return res.status(gate.status).json(gate.body);
    await reactivateIfSelfDeactivated(user);

    const token = generateToken(user.id, user.role);
    res.json({
      success: true,
      message: 'Login successful',
      data: { user: sanitizeUser(user), token, is_new: isNew }
    });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ success: false, error: 'Google sign-in failed' });
  }
});

/**
 * Forgotten password, in two steps. No SMS: the code goes to the person's
 * connected Telegram and/or their email address.
 *
 *   POST /api/auth/password-reset/request  { identifier }
 *   POST /api/auth/password-reset/confirm  { identifier, code, newPassword }
 *
 * `request` answers the same way whether or not the account exists or has a
 * channel, so it can't be used to find out who has an account.
 */
const crypto = require('crypto');
const telegram = require('../utils/telegram');
const mailer = require('../utils/email');

const RESET_TTL_MS = 10 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_GAP_MS = 60 * 1000;
const RESET_MAX_PER_HOUR = 5;

const resetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: rateLimitResponse('Too many reset requests. Please try again later.')
});

const resetCodeHash = (userId, code) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev').update(`${userId}:${code}`).digest('hex');

const findUserByIdentifier = async (identifier) => {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  const q = supabase.from('users').select('*');
  const { data } = await (raw.includes('@')
    ? q.eq('email', normalizeEmail(raw))
    : q.eq('phone', normalizePhone(raw))).maybeSingle();
  return data || null;
};

const RESET_SENT = {
  success: true,
  message: 'If this account exists and has Telegram or email connected, a code has been sent.'
};

router.post('/password-reset/request', resetRequestLimiter, async (req, res) => {
  try {
    const user = await findUserByIdentifier(req.body?.identifier);
    if (!user || user.deleted_at) return res.json(RESET_SENT);

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('password_reset_codes').select('created_at')
      .eq('user_id', user.id).gte('created_at', since)
      .order('created_at', { ascending: false });
    if (recent?.length >= RESET_MAX_PER_HOUR) return res.json(RESET_SENT);
    if (recent?.[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESET_RESEND_GAP_MS) {
      return res.json(RESET_SENT);
    }

    // Channels this person can actually receive a code on.
    let chatId = null;
    if (user.role === 'student' && telegram.enabled()) {
      const { data: priv } = await supabase
        .from('student_private').select('telegram_chat_id, telegram_blocked_at')
        .eq('user_id', user.id).maybeSingle();
      if (priv?.telegram_chat_id && !priv.telegram_blocked_at) chatId = priv.telegram_chat_id;
    }
    const emailTo = user.email && mailer.enabled() ? user.email : null;
    if (!chatId && !emailTo) return res.json(RESET_SENT);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const { error: insertError } = await supabase.from('password_reset_codes').insert({
      user_id: user.id,
      code_hash: resetCodeHash(user.id, code),
      expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString()
    });
    if (insertError) throw insertError;

    const kh = user.language !== 'en';
    const text = kh
      ? `រំដួល ស្កូឡារ៍: លេខកូដកំណត់ពាក្យសម្ងាត់ថ្មីរបស់អ្នកគឺ ${code}\nវាផុតកំណត់ក្នុង ១០ នាទី។ បើអ្នកមិនបានស្នើសុំ សូមមិនអើពើសារនេះ។`
      : `Romduol Scholars: your password reset code is ${code}\nIt expires in 10 minutes. If you did not ask for it, ignore this message.`;
    if (chatId) await telegram.sendPlain(chatId, text);
    if (emailTo) await mailer.sendEmail({ to: emailTo, subject: 'Romduol Scholars password reset code', text });

    res.json(RESET_SENT);
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ success: false, error: 'Could not send a reset code. Please try again.' });
  }
});

router.post('/password-reset/confirm', credentialLimiter, async (req, res) => {
  try {
    const { identifier, newPassword } = req.body || {};
    const code = String(req.body?.code || '').trim();
    const bad = () => res.status(400).json({ success: false, code: 'RESET_CODE_INVALID', error: 'The code is wrong or has expired. Ask for a new one.' });

    if (!/^\d{6}$/.test(code)) return bad();
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    if (newPassword.length > 200) return res.status(400).json({ success: false, error: 'Password is too long' });

    const user = await findUserByIdentifier(identifier);
    if (!user || user.deleted_at) return bad();

    const { data: row } = await supabase
      .from('password_reset_codes').select('*')
      .eq('user_id', user.id).is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!row || row.attempts >= RESET_MAX_ATTEMPTS) return bad();

    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(resetCodeHash(user.id, code), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      await supabase.from('password_reset_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
      return bad();
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabase.from('users').update({ password: hashed }).eq('id', user.id);
    if (updateError) throw updateError;
    // One use only, and any other outstanding codes die with it.
    await supabase.from('password_reset_codes').delete().eq('user_id', user.id);

    res.json({ success: true, message: 'Password updated. You can sign in now.' });
  } catch (error) {
    console.error('Password reset confirm error:', error);
    res.status(500).json({ success: false, error: 'Could not reset the password. Please try again.' });
  }
});

/**
 * GET /api/auth/profile
 * Get current user profile (requires authentication)
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const profileColumns = 'id, name, email, phone, role, avatar_url, bio, notification_style, created_at, deactivated_at, deletion_scheduled_at';
    let { data: user, error } = await supabase
      .from('users')
      .select(`${profileColumns}, language`)
      .eq('id', req.user.userId)
      .single();
    // users.language comes from sql/055; until it exists, load the profile without it.
    if (error && (error.code === '42703' || /language/.test(error.message || ''))) {
      ({ data: user, error } = await supabase.from('users').select(profileColumns).eq('id', req.user.userId).single());
    }

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
    let { name, email, phone, bio, notification_style, language } = req.body;
    const updates = {};

    if (name) updates.name = name;
    if (bio !== undefined) updates.bio = bio;
    if (notification_style !== undefined) {
      if (!['balanced', 'competitive'].includes(notification_style)) {
        return res.status(400).json({ success: false, error: 'Invalid notification_style' });
      }
      updates.notification_style = notification_style;
    }
    if (language !== undefined) {
      if (!['km', 'en'].includes(language)) {
        return res.status(400).json({ success: false, error: 'Invalid language' });
      }
      updates.language = language;
    }

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
      message: 'Your account is now deactivated — you are hidden from other students. '
        + 'Reactivate it any time from the banner or Settings.',
      data: { deactivated_at: new Date().toISOString() }
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

    // The account keeps working normally during the 30-day grace window — we
    // only stamp the deletion timestamps. The app shows a "cancel deletion"
    // banner; purge-deleted-accounts.js anonymizes the row once the window
    // elapses. (is_active / deactivated_at are left untouched.)
    const { error } = await supabase
      .from('users')
      .update({
        deletion_requested_at: now,
        deletion_scheduled_at: scheduledAt
      })
      .eq('id', user.id);
    if (error) throw error;

    res.json({
      success: true,
      message: `Your account is scheduled to be permanently deleted on `
        + `${scheduledAt.toISOString().slice(0, 10)}. You can keep using it until then — `
        + `cancel the deletion any time before that date to keep your account.`,
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
router.post('/account/restore', credentialLimiter, async (req, res) => {
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

/**
 * POST /api/auth/account/reactivate
 * Undo a self-deactivation and/or a pending self-deletion for the CURRENT
 * (still logged-in) user — this is what the in-app "Reactivate" / "Cancel
 * deletion" banner calls. No password needed: they already hold a valid token.
 */
router.post('/account/reactivate', authenticateToken, async (req, res) => {
  try {
    const { data: user, error: loadErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();
    if (loadErr || !user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.deleted_at) {
      return res.status(410).json({ success: false, error: 'This account has already been permanently deleted' });
    }

    // Admin-disabled (not self): the user can't lift this themselves.
    if (user.is_active === false && !user.deactivated_at && !user.deletion_scheduled_at) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        error: 'This account has been deactivated by an administrator. Please contact support.'
      });
    }

    if (user.is_active !== false && !user.deactivated_at && !user.deletion_scheduled_at) {
      return res.json({ success: true, message: 'Account is already active', data: { user: sanitizeUser(user) } });
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

    res.json({
      success: true,
      message: 'Your account is active again.',
      data: { user: sanitizeUser(restored) }
    });
  } catch (error) {
    console.error('Reactivate account error:', error);
    res.status(500).json({ success: false, error: 'Failed to reactivate account: ' + error.message });
  }
});

module.exports = router;
// Shared with the Telegram sign-in flow (routes/telegram.routes.js).
module.exports.helpers = { sanitizeUser, accountLoginGate, reactivateIfSelfDeactivated };
