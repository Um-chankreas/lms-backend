# FINAL 4-TAB NAVIGATION STRUCTURE

## Layout

```
┌──────────────────────────────────────┐
│ 🎓 Grade 12 App    🔔  👤          │
├──────────────────────────────────────┤
│                                      │
│       [TAB CONTENT AREA]             │
│                                      │
├──────────────────────────────────────┤
│ 🏠  📚  📝  👥                       │
│ Home Class Assign Friend             │
└──────────────────────────────────────┘
```

---

## 🏠 TAB 1: HOME (Dashboard)

**Purpose:** Overview & Quick Stats

**Content:**
```
┌──────────────────────────────────────┐
│ HOME                                 │
├──────────────────────────────────────┤
│                                      │
│ 📊 QUICK STATS                       │
│ ├─ Level: 5                          │
│ ├─ XP: 2,450 / 3,000 (81%)          │
│ └─ Progress: ▓▓▓▓▓░░░░░             │
│                                      │
│ 🔥 TODAY'S STREAK                    │
│ ├─ Current: 7 Days 🔥               │
│ ├─ Best: 14 Days                    │
│                                      │
│ 📈 THIS WEEK                         │
│ ├─ XP Earned: 850 XP                │
│ ├─ Quizzes: 5 completed             │
│ ├─ Assignments: 2 completed         │
│                                      │
│ 👥 FRIEND ACTIVITY                   │
│ ├─ Alex earned 50 XP                │
│ ├─ Sam reached Level 4! 🎉          │
│ └─ Jordan on 10-day streak 🔥       │
│                                      │
└──────────────────────────────────────┘
```

**Features:**
- [ ] Current level & XP progress
- [ ] Streak counter
- [ ] Weekly stats (XP, quizzes, assignments)
- [ ] Friend activity feed (latest 3-5 activities)

---

## 📚 TAB 2: CLASS (Course Content with Drawer)

**Purpose:** Access lessons, quizzes, assignments, live classes by subject

**Structure:**

### Drawer Closed (Default):
```
┌──────────────────────────────────────┐
│ ☰ CLASS          History (50%)       │
├──────────────────────────────────────┤
│                                      │
│ 📚 LESSONS (History)                 │
│                                      │
│ 📖 Lesson 1: Ancient Egypt ✓         │
│ Duration: 15 min | Status: Complete  │
│ XP Earned: 15 XP                    │
│ [View Lesson]                       │
│                                      │
│ 📖 Lesson 2: Pyramids (60%)         │
│ Duration: 20 min | In Progress      │
│ [Continue Lesson]                   │
│                                      │
│ 📖 Lesson 3: Pharaohs 🔒            │
│ Duration: 25 min | Locked           │
│ Requirement: Complete Lesson 2      │
│                                      │
└──────────────────────────────────────┘
```

### Drawer Open (Slide from Left):
```
┌─────────────────┬──────────────────┐
│ SUBJECTS        │ ☰ CLASS          │
├─────────────────┤──────────────────┤
│ 📚 HISTORY      │ [Main dims 40%]  │
│ ├─ Lessons      │                  │
│ ├─ Quizzes      │                  │
│ ├─ Assign.      │                  │
│ └─ Live Classes │                  │
│                 │                  │
│ 🔢 MATH         │                  │
│ ├─ Lessons      │                  │
│ ├─ Quizzes      │                  │
│ ├─ Assign.      │                  │
│ └─ Live Classes │                  │
│                 │                  │
└─────────────────┴──────────────────┘
```

**Drawer Features:**
- [ ] Subject selection (History/Math)
- [ ] 4 content types per subject:
  - 📖 Lessons (with progress count)
  - 🎯 Quizzes (with pending count)
  - 📝 Assignments (with count)
  - 🎥 Live Classes (with next schedule)
- [ ] Smooth slide from left
- [ ] Main content dims when open
- [ ] Tap outside to close

**Content Views Under Each Type:**

### LESSONS View:
```
📖 LESSONS (History)
├─ Lesson 1: Ancient Egypt ✓
│  Duration: 15 min
│  Status: Completed | XP Earned: 15
│  [View/Review Lesson]
│
├─ Lesson 2: Pyramids (60%)
│  Duration: 20 min | In Progress
│  [Continue Lesson]
│
└─ Lesson 3: Pharaohs 🔒
   Duration: 25 min | Locked
   Requirement: Complete Lesson 2
```

### QUIZZES View:
```
🎯 QUIZZES (History)
├─ Quiz 1: Egypt Facts ✓
│  Score: 95% | XP Earned: 50
│  [Review Answers]
│
├─ Quiz 2: Timeline
│  Status: Available | Due: Sept 20
│  XP Reward: 50 | [Start Quiz]
│
└─ Quiz 3: Culture 🔒
   Locked | Requirement: Complete Lesson 3
```

### ASSIGNMENTS View:
```
📝 ASSIGNMENTS (History)
├─ Essay: Ancient Egypt ✓
│  Status: Submitted | XP Earned: 75
│  [View Feedback]
│
├─ Project: Pyramid Model (40%)
│  Due: Sept 22 | XP Reward: 75
│  [Continue Work]
│
└─ Analysis: Hieroglyphics 🔒
   Due: Sept 28 | Locked
   Requirement: Complete Lesson 3
```

### LIVE CLASSES View:
```
🎥 LIVE CLASSES (History)
Class: Ancient Civilizations
Instructor: Mr. Smith

SCHEDULE:
├─ Monday 3:00 PM - 3:30 PM
├─ Wednesday 3:00 PM - 3:30 PM
└─ Friday 2:00 PM - 3:30 PM

UPCOMING:
├─ Tomorrow (Wed) 3:00 PM [Join Now]
├─ Friday 2:00 PM [Remind Me]
└─ Next Monday 3:00 PM [Remind Me]

RECORDINGS:
├─ Class Sept 13 [Watch Recording]
└─ Class Sept 11 [Watch Recording]
```

**Key Features:**
- [ ] Duolingo-style drawer for subject selection
- [ ] 4 organized content types
- [ ] Progress indicators
- [ ] Status badges (✓, ⏰, 🔒)
- [ ] Quick action buttons
- [ ] Back navigation

---

## 📝 TAB 3: ASSIGNMENT (Assignment Tracker)

**Purpose:** View all assignments in one place, submit work, track progress

**Structure:**
```
ASSIGNMENT Tab
├─ Filter: All | History | Math
│
└─ Assignments organized by status:
   ├─ NOT STARTED (Gray)
   ├─ IN PROGRESS (Yellow)
   ├─ SUBMITTED (Green)
   └─ OVERDUE (Red)
```

**Full View:**
```
┌──────────────────────────────────────┐
│ ASSIGNMENT                           │
├──────────────────────────────────────┤
│ Filter: All | History | Math         │
├──────────────────────────────────────┤
│                                      │
│ NOT STARTED                          │
│ ─────────────────────────────────    │
│ 📝 Essay: Ancient Egypt              │
│ Class: History                       │
│ Due: 2 days remaining ⏰             │
│ XP Reward: 75 XP (on-time)          │
│ [Start Assignment]                  │
│                                      │
│ IN PROGRESS                          │
│ ─────────────────────────────────    │
│ 📝 Math Problem Set                  │
│ Class: Math                          │
│ Progress: ▓▓▓░░░░░░░ 40%            │
│ Due: 1 day remaining ⏰              │
│ XP Reward: 75 XP (on-time)          │
│ [Continue]                          │
│                                      │
│ SUBMITTED ✓                          │
│ ─────────────────────────────────    │
│ 📝 Document Analysis ✓              │
│ Class: History                       │
│ Submitted: On-time (Sept 15)         │
│ XP Earned: 75 XP                    │
│ [View Feedback]                      │
│                                      │
│ OVERDUE ⚠                            │
│ ─────────────────────────────────    │
│ 📝 Research Paper                    │
│ Class: Math                          │
│ Due: 3 days ago ⚠                   │
│ XP Reward: 50 XP (late penalty)     │
│ [Submit Late]                        │
│                                      │
└──────────────────────────────────────┘
```

**Features:**
- [ ] Filter by subject (All/History/Math)
- [ ] Organized by status (Not Started/In Progress/Submitted/Overdue)
- [ ] Assignment title & class name
- [ ] Due date with countdown
- [ ] XP rewards (on-time vs late)
- [ ] Progress bar (if in progress)
- [ ] Action buttons (Start/Continue/View Feedback/Submit Late)
- [ ] Status indicators (✓, ⏰, ⚠)

---

## 👥 TAB 4: FRIEND (Friends & Leaderboard)

**Purpose:** View friends, friend activity, and compete on leaderboards

**Structure:**
```
FRIEND Tab
├─ Tabs/Sections:
│  ├─ Friends (Friend List)
│  ├─ Activity Feed (What friends did)
│  └─ Leaderboard (Rankings)
│
└─ Filter by:
   ├─ All (Global)
   ├─ History (Subject-specific)
   └─ Math (Subject-specific)
```

### FRIENDS List View:
```
┌──────────────────────────────────────┐
│ FRIEND                               │
├──────────────────────────────────────┤
│ Section: Friends List                │
├──────────────────────────────────────┤
│                                      │
│ 👤 Alex                              │
│ ├─ Level: 5                          │
│ ├─ Current Streak: 12 Days 🔥       │
│ ├─ This Week: 950 XP                │
│ └─ [View Profile] [Remove Friend]   │
│                                      │
│ 👤 Sam                               │
│ ├─ Level: 4                          │
│ ├─ Current Streak: 8 Days 🔥        │
│ ├─ This Week: 750 XP                │
│ └─ [View Profile] [Remove Friend]   │
│                                      │
│ 👤 Jordan                            │
│ ├─ Level: 4                          │
│ ├─ Current Streak: 5 Days 🔥        │
│ ├─ This Week: 620 XP                │
│ └─ [View Profile] [Remove Friend]   │
│                                      │
│ 👤 Maria                             │
│ ├─ Level: 3                          │
│ ├─ Current Streak: 3 Days 🔥        │
│ ├─ This Week: 400 XP                │
│ └─ [View Profile] [Remove Friend]   │
│                                      │
└──────────────────────────────────────┘
```

### ACTIVITY FEED View:
```
┌──────────────────────────────────────┐
│ FRIEND > ACTIVITY FEED               │
├──────────────────────────────────────┤
│                                      │
│ 👤 Alex earned 50 XP                │
│ ✓ Completed History Quiz (95%)      │
│ Just now                            │
│                                      │
│ 👤 Sam reached Level 4! 🎉          │
│ 🎖️ Promotion milestone              │
│ 2 hours ago                         │
│                                      │
│ 👤 Jordan on 10-day streak 🔥      │
│ 🔥 Streak milestone                 │
│ 3 hours ago                         │
│                                      │
│ 👤 Maria submitted assignment        │
│ ✓ Completed Math Assignment         │
│ Today at 2:30 PM                    │
│                                      │
│ 👤 Alex started new course           │
│ 📚 Enrolled in Calculus 101         │
│ Yesterday                           │
│                                      │
└──────────────────────────────────────┘
```

### LEADERBOARD View (All):
```
┌──────────────────────────────────────┐
│ FRIEND > LEADERBOARD                 │
├──────────────────────────────────────┤
│ Filter: All | History | Math         │
│ Sort By: XP | Streak | Weekly       │
├──────────────────────────────────────┤
│                                      │
│ RANK BY TOTAL XP                    │
│                                      │
│ 🥇 1. Alex                           │
│    Level: 5 | XP: 3,200             │
│    Streak: 12 Days 🔥               │
│                                      │
│ 🥈 2. Sam                            │
│    Level: 4 | XP: 2,900             │
│    Streak: 8 Days 🔥                │
│                                      │
│ 🥉 3. Jordan                         │
│    Level: 4 | XP: 2,450             │
│    Streak: 5 Days 🔥                │
│                                      │
│ 4️⃣ 4. Maria                          │
│    Level: 3 | XP: 2,100             │
│    Streak: 3 Days 🔥                │
│                                      │
│ 5️⃣ 5. You                            │
│    Level: 5 | XP: 2,450             │
│    Streak: 7 Days 🔥                │
│    📍 Your Position                  │
│                                      │
│ 6️⃣ 6. Chris                          │
│    Level: 3 | XP: 1,800             │
│    Streak: 2 Days 🔥                │
│                                      │
└──────────────────────────────────────┘
```

### LEADERBOARD View (Subject-Specific):
```
┌──────────────────────────────────────┐
│ LEADERBOARD > HISTORY                │
├──────────────────────────────────────┤
│ Filter: History | Math               │
│ Sort By: XP | Streak | Weekly       │
├──────────────────────────────────────┤
│                                      │
│ 🥇 1. Sam (History)                  │
│    Level: 5 | XP: 1,500 (History)   │
│    Streak: 10 Days 🔥               │
│                                      │
│ 🥈 2. You                            │
│    Level: 4 | XP: 1,200 (History)   │
│    Streak: 7 Days 🔥                │
│    📍 Your Position                  │
│                                      │
│ 🥉 3. Alex                           │
│    Level: 4 | XP: 1,100 (History)   │
│    Streak: 8 Days 🔥                │
│                                      │
└──────────────────────────────────────┘
```

**Features:**
- [ ] Friends list with stats (Level, Streak, Weekly XP)
- [ ] Friend activity feed (recent actions)
- [ ] Global leaderboard (top 10 by XP)
- [ ] Subject-specific leaderboards (History/Math)
- [ ] Sort by: Total XP, Current Streak, Weekly XP
- [ ] Filter by: All, History, Math
- [ ] Your ranking position highlighted
- [ ] Remove friend option
- [ ] View friend profile

---

## AUTO-FRIENDING SYSTEM

When student enrolls in a course:
```
✓ Automatically becomes friends with all students in that course
✓ Can see their activity in ACTIVITY FEED
✓ Can compete on LEADERBOARDS
✓ Can remove/block friends if desired
```

---

## GAMIFICATION FEATURES (All Tabs)

### XP Earning:
```
🎯 Quiz Completion: 10-50 XP (by score)
📖 Lesson Completion: 15 XP
📝 Assignment Submission: 25-75 XP (on-time bonus)
🎥 Live Class Attendance: 20 XP
⚡ Daily Practice: 50 XP
```

### Streaks:
```
🔥 Consecutive days of quiz attempts
🔥 Displayed on HOME tab
🔥 Milestone badges (7 days, 14 days, 30 days)
🔥 Tracked on FRIEND leaderboard
```

### Progress:
```
📊 Level system (1-N levels)
📊 XP progress bar (current level)
📊 Subject breakdown (History XP vs Math XP)
📊 Displayed on HOME & FRIEND tabs
```

### Achievements:
```
🏆 Badges for milestones
🏆 First 100 XP
🏆 7-Day Streak 🔥
🏆 Quiz Master (10+ quizzes)
🏆 Assignment Champion
🏆 Level Up rewards
```

---

## HEADER FEATURES (All Tabs)

```
LEFT: [Menu/Logo]          CENTER: [Current Tab]     RIGHT: [🔔] [👤]
                                                    Notifications  Profile
```

**Top Header:**
- [ ] App logo/name (tap to go HOME)
- [ ] Notification bell (🔔) with badge count
- [ ] Profile avatar (👤) with dropdown menu
  - View Profile
  - Account Settings
  - Help & FAQ
  - Logout

---

## FINAL SUMMARY TABLE

| Tab | Icon | Purpose | Main Content |
|-----|------|---------|--------------|
| **HOME** | 🏠 | Dashboard | Stats, Streak, Weekly Activity, Friend Activity |
| **CLASS** | 📚 | Course Content | Lessons, Quizzes, Assignments, Live Classes (Drawer for subject selection) |
| **ASSIGNMENT** | 📝 | Assignment Tracker | All assignments, Status, Due dates, Submit/Track |
| **FRIEND** | 👥 | Social & Competition | Friend list, Activity feed, Leaderboards (Global/Subject), Rankings |

---

## NAVIGATION FLOW

```
App Opens
    ↓
HOME Tab (Default)
    ↓
├─ Tap 🏠 → HOME (Dashboard)
│
├─ Tap 📚 → CLASS (Drawer opens for subject)
│  ├─ Select History → Show History content
│  ├─ Tap Lessons → Show lessons list
│  ├─ Tap Quizzes → Show quizzes list
│  ├─ Tap Assignments → Show assignments
│  └─ Tap Live Classes → Show schedule
│
├─ Tap 📝 → ASSIGNMENT (All assignments)
│  ├─ Filter by subject
│  ├─ View by status
│  └─ Submit/track work
│
└─ Tap 👥 → FRIEND (Social)
   ├─ View friends list
   ├─ See activity feed
   ├─ View leaderboards
   └─ Sort/filter rankings
```

---

## KEY UPDATES FROM PREVIOUS VERSION

✅ **Removed:**
- DAILY tab (Duolingo-style practice moved to CLASS)
- PROGRESS tab (stats distributed to HOME & FRIEND tabs)

✅ **Updated:**
- CLASS tab: Now uses Duolingo-style drawer for subject selection
- FRIEND tab: Combined Friends + Leaderboard + Activity Feed

✅ **Added:**
- Drawer navigation in CLASS tab
- Activity feed in FRIEND tab
- Subject-specific leaderboards in FRIEND tab

✅ **Simplified to 4 Essential Tabs:**
- 🏠 HOME (Overview)
- 📚 CLASS (Content)
- 📝 ASSIGNMENT (Submissions)
- 👥 FRIEND (Social & Competition)
