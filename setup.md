# ⚡ Quick Setup Guide

## 🚀 Get Your Backend Running in 5 Minutes

### Step 1: Environment Setup
```bash
# You already have:
✅ Node.js installed
✅ Dependencies installed
✅ Project structure created
```

### Step 2: Configure .env
Edit `.env` with your credentials:

1. **Supabase:**
   - Go to https://supabase.com
   - Create project
   - Copy URL and ANON KEY from Project Settings

2. **Agora:**
   - Go to https://agora.io
   - Create app
   - Copy App ID and Certificate

3. **Fill .env:**
```env
PORT=5000
SUPABASE_URL=your_url_here
SUPABASE_ANON_KEY=your_key_here
AGORA_APP_ID=your_app_id_here
AGORA_APP_CERTIFICATE=your_certificate_here
JWT_SECRET=any_random_string_here
```

### Step 3: Create Database
1. Go to your Supabase project
2. SQL Editor → "New Query"
3. Copy entire SQL schema from README.md
4. Run it

### Step 4: Start Server
```bash
npm start
```

You should see:
```
╔════════════════════════════════════════╗
║   🎓 LMS Backend Server Running        ║
╚════════════════════════════════════════╝

📍 URL: http://localhost:5000
```

### Step 5: Test It Works
```bash
# Open browser or curl:
http://localhost:5000

# Should return:
{
  "message": "🎓 LMS Backend API is running!",
  "endpoints": { ... }
}
```

---

## 📝 What Each API Does

| Endpoint | Purpose | User |
|----------|---------|------|
| `/api/auth` | Login/Signup | All |
| `/api/courses` | Create/View courses | All |
| `/api/lessons` | Upload lessons (PDF/Video) | All |
| `/api/quizzes` | Create quizzes | All |
| `/api/assignments` | Assignments + grading | All |
| `/api/live-classes` | Agora integration | All |

---

## 🧪 Test Your API

### Signup
```bash
curl -X POST http://localhost:5000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123",
    "name": "Test User",
    "role": "teacher"
  }'
```

Copy the `token` from response.

### Create Course
```bash
curl -X POST http://localhost:5000/api/courses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
    "title": "My Course",
    "description": "Test course"
  }'
```

---

## 🔗 Connect to Your Vue.js App

Update your Vue app to use this backend:

**Create `src/services/api.js`:**
```javascript
import axios from 'axios'

const API = axios.create({
  baseURL: 'http://localhost:5000/api'
})

// Add token to all requests
API.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export default API
```

**Use in your components:**
```javascript
import API from '@/services/api'

// Signup
const response = await API.post('/auth/signup', {
  email, password, name, role
})
localStorage.setItem('token', response.data.data.token)

// Get courses
const courses = await API.get('/courses')
```

---

## ✅ Checklist

- [ ] `.env` configured with Supabase + Agora
- [ ] Database tables created in Supabase
- [ ] Storage buckets created (`course-materials`, `assignments`)
- [ ] Server running (`npm start`)
- [ ] Can access http://localhost:5000
- [ ] Can signup/login
- [ ] Connected to Vue.js frontend

---

## 🆘 Common Issues

### "Cannot connect to Supabase"
- Check SUPABASE_URL and SUPABASE_ANON_KEY in .env
- Make sure project is active in Supabase
- Restart server

### "File upload fails"
- Verify buckets exist in Supabase Storage
- Check bucket permissions (public access)
- File size under 50MB

### "Agora token error"
- Check AGORA_APP_ID and AGORA_APP_CERTIFICATE
- Make sure Agora account is active
- Token generation requires both credentials

---

## 🚀 Next: Connect to Frontend

Your backend is ready! Now:

1. **Update your Vue.js app** to call these APIs
2. **Replace hardcoded values** with API calls
3. **Use tokens** for authentication

See README.md for full API documentation.

---

**Backend is ready!** 🎉