const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { generateToken } = require('../utils/jwt');
const { authenticateToken } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
 
/**
 * POST /api/auth/signup
 * Register a new user (teacher or student)
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
 
    // Validation
    if (!email || !password || !name || !role) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, name, and role are required'
      });
    }
 
    if (!['teacher', 'student'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Role must be either "teacher" or "student"'
      });
    }
 
    // Check if email already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();
 
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered'
      });
    }
 
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
 
    // Create user
    const userId = uuidv4();
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        id: userId,
        email,
        password: hashedPassword,
        name,
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
      message: 'User registered successfully',
      data: {
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role
        },
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
 * Login user with email and password
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
 
    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }
 
    // Find user
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
 
    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }
 
    // Compare passwords
    const passwordMatch = await bcrypt.compare(password, user.password);
 
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }
 
    // Generate JWT token
    const token = generateToken(user.id, user.role);
 
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
        },
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
      .select('id, email, name, role, created_at')
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
    const { name, email } = req.body;
 
    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({ name, email })
      .eq('id', req.user.userId)
      .select()
      .single();
 
    if (error) throw error;
 
    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          name: updatedUser.name,
          role: updatedUser.role
        }
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
 
module.exports = router;