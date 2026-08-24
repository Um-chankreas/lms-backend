const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();

// ============ Middleware ============
// Dynamically allow requests from localhost, local IP addresses, or any origin in development
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman) or any origin on local network
    callback(null, true);
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
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
const HOST = '0.0.0.0'; // Bind to 0.0.0.0 to accept connections on local IP

const server = app.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🎓 LMS Backend Server Running        ║
╚════════════════════════════════════════╝
 
📍 Local:     http://localhost:${PORT}
📡 Network:   http://0.0.0.0:${PORT}
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