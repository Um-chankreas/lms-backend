// Must be first: loads .env.<NODE_ENV> then .env before anything reads process.env
require('./config/loadEnv');

const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
const { initLiveClassRealtime } = require('./realtime/liveClassSocket');

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
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/leaderboard', require('./routes/leaderboard.routes'));
app.use('/api/profile', require('./routes/profile.routes'));
app.use('/api/admin', require('./routes/admin.routes'));

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
      liveClasses: '/api/live-classes',
      dashboard: '/api/dashboard'
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

const httpServer = http.createServer(app);

// Attach the live-class realtime (Socket.IO) layer to the same HTTP server.
initLiveClassRealtime(httpServer);

const server = httpServer.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🎓 LMS Backend Server Running        ║
╚════════════════════════════════════════╝
 
📍 Local:     http://localhost:${PORT}
📡 Network:   http://0.0.0.0:${PORT}
🔧 Environment: ${process.env.NODE_ENV}
📊 Database: Supabase
🎥 Video: Agora
🔌 Realtime: Socket.IO (/socket.io)
 
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