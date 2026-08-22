# 🎓 LMS Backend API

Complete Learning Management System backend built with **Node.js + Express** and **Supabase**.

Features:
- ✅ User Authentication (Teachers & Students)
- ✅ Course Management
- ✅ Lessons with PDF/Video Upload
- ✅ Quiz System
- ✅ Assignments with Grading
- ✅ Live Classes with Agora Integration
- ✅ PDF Text Extraction for Search

---

## 📋 Prerequisites

- **Node.js** v14+ installed
- **npm** or yarn
- **Supabase** account (free at supabase.co)
- **Agora** account (free at agora.io)

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment Variables

Copy `.env` file and fill in your credentials:

```bash
cp .env .env.local
```

Edit `.env` with:

```env
# Server
PORT=5000
NODE_ENV=development

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key

# JWT
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRE=7d

# Agora
AGORA_APP_ID=your_app_id
AGORA_APP_CERTIFICATE=your_app_certificate

# CORS
CORS_ORIGIN=http://localhost:5173,http://localhost:3000
```

### 3. Setup Supabase Database

1. Go to your Supabase project
2. Open SQL Editor
3. Run this script to create all tables:

```sql
-- Users Table
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- 'teacher' or 'student'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Courses Table
CREATE TABLE courses (
  id UUID PRIMARY KEY,
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Lessons Table
CREATE TABLE lessons (
  id UUID PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  file_url VARCHAR(500),
  file_type VARCHAR(50), -- 'video', 'pdf', etc
  text_content TEXT, -- Extracted PDF text for search
  order_number INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Lesson Completions
CREATE TABLE lesson_completions (
  id UUID PRIMARY KEY,
  lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(lesson_id, student_id)
);

-- Quizzes Table
CREATE TABLE quizzes (
  id UUID PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  pass_percentage INT DEFAULT 70,
  time_limit INT, -- in minutes
  created_at TIMESTAMP DEFAULT NOW()
);

-- Quiz Questions
CREATE TABLE quiz_questions (
  id UUID PRIMARY KEY,
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB NOT NULL, -- ["A", "B", "C", "D"]
  correct_answer VARCHAR(1) NOT NULL,
  question_type VARCHAR(50) DEFAULT 'multiple_choice',
  order_number INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Quiz Submissions
CREATE TABLE quiz_submissions (
  id UUID PRIMARY KEY,
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL,
  score INT,
  passed BOOLEAN,
  submitted_at TIMESTAMP DEFAULT NOW()
);

-- Assignments Table
CREATE TABLE assignments (
  id UUID PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  due_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Assignment Submissions
CREATE TABLE assignment_submissions (
  id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_text TEXT,
  file_url VARCHAR(500),
  grade INT,
  feedback TEXT,
  submitted_at TIMESTAMP DEFAULT NOW(),
  graded_at TIMESTAMP
);

-- Live Classes
CREATE TABLE live_classes (
  id UUID PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  channel_name VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) DEFAULT 'scheduled', -- scheduled, active, completed
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Live Class Participants
CREATE TABLE live_class_participants (
  id UUID PRIMARY KEY,
  live_class_id UUID NOT NULL REFERENCES live_classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50), -- 'teacher' or 'student'
  joined_at TIMESTAMP DEFAULT NOW(),
  left_at TIMESTAMP
);

-- Course Enrollments
CREATE TABLE course_enrollments (
  id UUID PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(course_id, student_id)
);
```

### 4. Create Storage Buckets

In Supabase Storage, create these buckets:

- `course-materials` (for PDFs and videos)
- `assignments` (for assignment submissions)

### 5. Start the Server

```bash
npm start
```

Server runs on: **http://localhost:5000**

---

## 📚 API Endpoints

### Authentication
```
POST   /api/auth/signup              - Register new user
POST   /api/auth/login               - Login user
GET    /api/auth/profile             - Get user profile (Protected)
PUT    /api/auth/profile             - Update profile (Protected)
```

### Courses
```
POST   /api/courses                  - Create course (Teacher)
GET    /api/courses                  - List user's courses (Protected)
GET    /api/courses/:id              - Get course details (Protected)
PUT    /api/courses/:id              - Update course (Teacher)
DELETE /api/courses/:id              - Delete course (Teacher)
POST   /api/courses/:id/enroll       - Enroll in course (Student)
```

### Lessons
```
POST   /api/lessons                  - Create lesson with file (Teacher)
GET    /api/lessons/:id              - Get lesson details (Protected)
GET    /api/lessons/course/:courseId - Get all course lessons (Protected)
PUT    /api/lessons/:id              - Update lesson (Teacher)
DELETE /api/lessons/:id              - Delete lesson (Teacher)
POST   /api/lessons/:id/mark-complete - Mark lesson complete (Student)
```

### Quizzes
```
POST   /api/quizzes                  - Create quiz (Teacher)
POST   /api/quizzes/:id/questions    - Add question (Teacher)
GET    /api/quizzes/:id              - Get quiz with questions (Protected)
GET    /api/quizzes/course/:courseId - Get course quizzes (Protected)
POST   /api/quizzes/:id/submit       - Submit quiz (Student)
GET    /api/quizzes/:id/results      - Get quiz results (Protected)
```

### Assignments
```
POST   /api/assignments              - Create assignment (Teacher)
GET    /api/assignments/course/:courseId - Get course assignments (Protected)
GET    /api/assignments/:id          - Get assignment with submissions (Protected)
POST   /api/assignments/:id/submit   - Submit assignment (Student)
PUT    /api/assignments/:id/submissions/:submissionId/grade - Grade (Teacher)
```

### Live Classes
```
POST   /api/live-classes             - Create live class (Teacher)
GET    /api/live-classes/:id         - Get class details (Protected)
GET    /api/live-classes/course/:courseId - Get course live classes (Protected)
POST   /api/live-classes/:id/token   - Get Agora token (Protected)
PUT    /api/live-classes/:id/start   - Start class (Teacher)
PUT    /api/live-classes/:id/end     - End class (Teacher)
POST   /api/live-classes/:id/leave   - Leave class (Protected)
```

---

## 🔐 Authentication

All protected endpoints require JWT token in Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

### Get Token:
1. Sign up or login at `/api/auth/signup` or `/api/auth/login`
2. Response includes `token`
3. Use token for all subsequent requests

---

## 📁 Project Structure

```
lms-backend/
├── src/
│   ├── config/
│   │   └── supabase.js          # Supabase client
│   ├── routes/
│   │   ├── auth.routes.js       # Auth endpoints
│   │   ├── courses.routes.js    # Course endpoints
│   │   ├── lessons.routes.js    # Lesson endpoints
│   │   ├── quizzes.routes.js    # Quiz endpoints
│   │   ├── assignments.routes.js # Assignment endpoints
│   │   └── liveClass.routes.js  # Live class endpoints
│   ├── middleware/
│   │   └── auth.js              # JWT verification
│   ├── utils/
│   │   ├── jwt.js               # JWT utilities
│   │   └── agoraToken.js        # Agora token generation
│   └── server.js                # Main server file
├── .env                          # Environment variables
├── package.json
└── README.md
```

---

## 💡 Usage Examples

### 1. Signup & Login

```bash
# Signup
curl -X POST http://localhost:5000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "teacher@example.com",
    "password": "password123",
    "name": "John Teacher",
    "role": "teacher"
  }'

# Response:
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": { ... },
    "token": "eyJhbGc..."
  }
}
```

### 2. Create Course

```bash
curl -X POST http://localhost:5000/api/courses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "title": "Web Development 101",
    "description": "Learn web development",
    "category": "Programming"
  }'
```

### 3. Upload Lesson with PDF

```bash
curl -X POST http://localhost:5000/api/lessons \
  -H "Authorization: Bearer <token>" \
  -F "course_id=course-uuid" \
  -F "title=Lesson 1: Basics" \
  -F "description=Introduction to web development" \
  -F "file=@lesson.pdf" \
  -F "order_number=1"
```

### 4. Create Quiz with Questions

```bash
# Create quiz
curl -X POST http://localhost:5000/api/quizzes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "course_id": "course-uuid",
    "title": "Quiz 1",
    "pass_percentage": 70,
    "time_limit": 30
  }'

# Add question
curl -X POST http://localhost:5000/api/quizzes/quiz-uuid/questions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "question": "What is 2+2?",
    "options": ["3", "4", "5", "6"],
    "correct_answer": "4"
  }'
```

### 5. Live Class with Agora

```bash
# Create live class
curl -X POST http://localhost:5000/api/live-classes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "course_id": "course-uuid",
    "title": "Live Session 1"
  }'

# Get Agora token to join
curl -X POST http://localhost:5000/api/live-classes/class-uuid/token \
  -H "Authorization: Bearer <token>"

# Response includes:
# - token (Agora token)
# - channel (channel name)
# - appId (Agora app ID)
```

---

## 🔧 Troubleshooting

### "Cannot find module 'agora-token'"
```bash
npm install agora-token
```

### "SUPABASE_URL not configured"
- Check `.env` file
- Make sure you've added Supabase credentials
- Restart the server

### "Invalid token"
- Token expired (default 7 days)
- Login again to get new token

### File upload fails
- Check file size (max 50MB)
- Verify bucket exists in Supabase Storage
- Check storage permissions

---

## 🎯 Next Steps

1. ✅ Backend is ready
2. ⭕ Connect your Vue.js web app
3. ⭕ Build React Native mobile app
4. ⭕ Add advanced features (notifications, chat, etc)

---

## 📞 Support

Check these files:
- `src/routes/*.js` - Endpoint implementations
- `.env` - Configuration
- Supabase docs: https://supabase.com/docs

---

**Made with ❤️ for your LMS project**