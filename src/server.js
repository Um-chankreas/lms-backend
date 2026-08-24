const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();

// ============ Middleware ============
// app.use(cors({
//   origin: process.env.CORS_ORIGIN?.split(',') || 'http://localhost:5173',
//   credentials: true
// }));
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, mobile apps, curl) OR allowed web origins
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS Policy: Origin not allowed'), false);
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============ Routes ============
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/courses', require('./routes/courses.routes'));
app.use('/api/lessons', require('./routes/lessons.routes'));
app.use('/api/quizzes', require('./routes/quizzes.routes'));
app.use('/api/assignments', require('./routes/assignments.routes'));
app.use('/api/live-classes', require('./routes/liveClass.routes'));

// ============ Health Check ============
app.get('/', (req, res) => {
  res.json({
    message: '🎓 LMS Backend API is running!',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      courses: '/api/courses',
      lessons: '/api/lessons',
      quizzes: '/api/quizzes',
      assignments: '/api/assignments',
      liveClasses: '/api/live-classes'
    }
  });
});

// ============ Error Handling ============
app.use((error, req, res, next) => {
  console.error('Error:', error);

  res.status(error.status || 500).json({
    success: false,
    error: error.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

// ============ 404 Handler ============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// ============ Start Server ============
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🎓 LMS Backend Server Running        ║
╚════════════════════════════════════════╝
 
📍 URL: http://localhost:${PORT}
🔧 Environment: ${process.env.NODE_ENV}
📊 Database: Supabase
🎥 Video: Agora
 
✅ Press Ctrl+C to stop the server
  `);
});

// ============ Graceful Shutdown ============
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;