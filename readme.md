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

Config is loaded by `src/config/loadEnv.js` from a single **`.env`** file in the
project root (real host env vars — systemd / pm2 / Docker — always take priority).

**One `.env` per machine:**

| Machine | `.env` contents |
|---|---|
| your laptop | `NODE_ENV=development` + **your personal Supabase project** |
| production server | `NODE_ENV=production` + **the company Supabase project** |

```bash
cp .env.example .env     # then fill in the values for this machine
```

`.env` is gitignored; only `.env.example` is committed. Using a different
Supabase project on each machine keeps dev data/tests away from production.

Variables:

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
POST   /api/auth/signup              - Register new user (email/password or phone/password)
POST   /api/auth/login               - Login user ({ identifier, password }; identifier = email or phone)
GET    /api/auth/profile             - Get user profile (Protected)
PUT    /api/auth/profile             - Update profile (Protected)
POST   /api/auth/deactivate          - Deactivate own account, reversible by logging back in (Protected, needs { password })
DELETE /api/auth/account             - Request permanent deletion, 30-day grace period (Protected, needs { password })
POST   /api/auth/account/restore     - Cancel deletion / reactivate within the grace period ({ identifier, password })
```

**Phone numbers** — users may type a local number (`092123456`, `92123456`) or
an international one (`+85592123456`). The API normalizes everything to E.164
(`src/utils/phone.js`): no `+` means Cambodia (`+855`) is assumed and the
leading `0` is dropped, so all forms map to the same stored value and
signup/login always match. Override the assumed country with
`PHONE_DEFAULT_COUNTRY_CODE` in `.env`. Login is via password — no SMS
verification.

Note: `admin.routes.js` still uses the older loose phone validation for
portal-created students — align it with `utils/phone.js` if admins enter
numbers in local format.

**Account deactivation & deletion (mobile app-store requirement)**

- `POST /api/auth/deactivate` — sets `is_active = false` + `deactivated_at`. The
  user is signed out and blocked from logging in; the next successful login
  automatically reactivates the account. Body: `{ "password": "..." }`.
- `DELETE /api/auth/account` — sets `deletion_requested_at` and
  `deletion_scheduled_at = now + 30 days` and disables the account. Body:
  `{ "password": "..." }`. Returns `deletion_scheduled_at`.
- `POST /api/auth/account/restore` — reactivates a self-deactivated or
  pending-deletion account before the grace period ends. Body:
  `{ "identifier": "<email or phone>", "password": "..." }`. Returns a fresh token.
- `login` returns `403` with `code: "ACCOUNT_PENDING_DELETION"` while a deletion
  is pending, and `410` once the account has been purged.
- Run `node scripts/purge-deleted-accounts.js` on a daily schedule. After the
  grace period it scrubs PII from the `users` row (name/email/phone/password/
  avatar/bio) and stamps `deleted_at`; learning history is kept but anonymized.
- Migration: `sql/017_account_lifecycle.sql`.

### Courses
```
POST   /api/courses                  - Create course (Teacher)
GET    /api/courses                  - List user's courses (Protected)
GET    /api/courses/:id              - Get course details (Protected)
PUT    /api/courses/:id              - Update course (Teacher)
DELETE /api/courses/:id              - Delete course (Teacher)
POST   /api/courses/:id/enroll       - Enroll in course (Student)
```

### Lessons (chapters) & Units

Content model: **course** (a class) → **lesson** = *chapter* (`ជំពូកទី១ …`) →
**unit** = *section* (`Unit 1: …`). A chapter can carry an optional intro video
(no PDFs). Completion / XP stay at the **chapter** level (`lesson_completions`).

```
POST   /api/lessons                  - Create chapter (Teacher)
GET    /api/lessons/:id              - Get chapter details (Protected)
GET    /api/lessons/course/:courseId - Get all course chapters (Protected)
PUT    /api/lessons/:id              - Update chapter (Teacher)
DELETE /api/lessons/:id              - Delete chapter (Teacher)
POST   /api/lessons/:id/mark-complete - Mark chapter complete (Student)

GET    /api/units?lesson_id=         - List a chapter's units (title + preview; content if unlocked)
GET    /api/units/search?q=&course_id= - Browse/search units the caller can see
GET    /api/units/:id               - One unit, full Markdown content (Protected)
POST   /api/units                   - Add a unit { lesson_id, title, content, is_free? } (Teacher)
POST   /api/units/bulk              - Import { lesson_id, markdown, replace? } — splits on each `## ` (Teacher)
POST   /api/units/reorder           - { lesson_id, order: [unitId, ...] } (Teacher)
PUT    /api/units/:id               - Edit a unit (Teacher)
DELETE /api/units/:id               - Remove a unit (Teacher)
```

**Unit content format** — Markdown, one column for every subject:
- history etc. → plain Markdown prose (`##` units, `**bold**`, paragraphs) — no LaTeX
- maths only → the same Markdown, with `$ … $` / `$$ … $$` where a formula is needed

The client should render with a math-aware Markdown pipeline (`markdown-it` +
`markdown-it-katex`, or `remark-math` + `rehype-katex`) so maths units display
correctly; history content is unaffected either way.

**Upload flow (portal)** — teacher picks course + chapter, pastes the chapter's
`.md`, `POST /api/units/bulk` splits it on `## ` headings into units (text before
the first `##` — the `#` title, `---` rules — is ignored). Migration:
`sql/018_lesson_units.sql`.

### Quizzes

A quiz attaches to a **course**, optionally a **chapter** (`lesson_id`), and
optionally a **unit** (`unit_id` — implies its chapter). So a chapter can have
its overall quiz *and* each unit its own practice quiz.

```
POST   /api/quizzes                  - Create quiz { course_id, lesson_id?, unit_id?, ... } (Teacher)
POST   /api/quizzes/:id/questions    - Add question (Teacher)
POST   /api/quizzes/:id/questions/import - Import questions into THIS quiz from CSV (Teacher)
GET    /api/quizzes/questions/import/template - Download the question CSV template (Teacher)
GET    /api/quizzes/:id              - Get quiz with questions (Protected)
GET    /api/quizzes/lesson/:lessonId - Get a chapter's quizzes (Protected)
GET    /api/quizzes/unit/:unitId     - Get a unit's quizzes (Protected)
GET    /api/quizzes/course/:courseId - Get course quizzes (Protected)
POST   /api/quizzes/:id/submit       - Submit quiz (Student)
GET    /api/quizzes/:id/results      - Get quiz results (Protected)

GET    /api/quizzes/import/units/template - Download the chapter-wide CSV template (Teacher)
POST   /api/quizzes/import/units     - Import a chapter's whole practice bank, split per unit (Teacher)
```

**CSV format** — one clean layout, used by both importers:

| column | required | notes |
|---|---|---|
| `question` | yes | the stem; wrap maths in `$…$` |
| `question_type` | no | `QCM` or `number_input`. Omit to infer (has options → `QCM`, none → `number_input`) |
| `option_a` … `option_f` | 2+ for `QCM` | leave all blank for `number_input` |
| `correct` | for `QCM` | a letter (`A`/`B`/…) **or** the full option text |
| `input_answer` | for `number_input` | the number the student must type (falls back to `correct` if empty) |
| `tier` | no | `Easy` / `Medium` / `Hard` → `quiz_questions.difficulty` |
| `explanation` | no | shown after the student answers |
| `unit` | only for the chapter-wide import | `U1`, `U2`, … → the unit's position in the chapter |

Both `correct` and `input_answer` end up in the one `quiz_questions.correct_answer`
column. `quiz_questions.question_type` is stored as `QCM` or `number_input`;
aliases accepted in the CSV: `MCQ` / `MCQ-4` / `multiple_choice` → `QCM`;
`numeric` / `numeric entry` / `number` → `number_input`. Older column names
(`stem in khmer`, `option a`, `correct answer`, `what each wrong option
catches`, `unit id`) are also accepted.

- **Per-quiz** (`POST /api/quizzes/:id/questions/import`) — the portal picks the
  chapter/unit; the CSV just needs `question, option_*, correct, tier, explanation`.
- **Chapter-wide** (`POST /api/quizzes/import/units`, multipart: `file`,
  `lesson_id`, `publish?`, `replace?`, `pass_percentage?`, `time_limit?`) — one
  CSV with a `unit` column; creates/reuses one quiz per unit.
- Migration: `sql/019_unit_quizzes.sql`. Note: imported unit quizzes are normal
  graded quizzes — passing awards QUIZ_PASS XP like any other.

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