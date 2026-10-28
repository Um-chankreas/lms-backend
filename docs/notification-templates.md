# Notification Templates

Every notification text the backend creates. Each one is saved to the in-app bell
(`notifications` table) and sent as a push (Expo). `{curly}` parts are filled in at send time.

Source files are noted per section, so edit the text there.

---

## Active notifications (currently sent)

### 1. New assignment — `assignment_new`
Source: `src/utils/notifyEvents.js` (`notifyAssignmentPublished`)
Sent to: every student enrolled in the course, when a teacher publishes an assignment.

- **Title:** `📚 New Assignment Unlocked!`
- **Body:** `{courseTitle}: "{assignmentTitle}" · Due {Mon D} · Earn {ASSIGNMENT_ONTIME}+ XP!`
  - `· Due …` is left out when there is no due date.
  - `courseTitle` falls back to `Your course`.

### 1b. Assignment reminder — `assignment_reminder`
Source: `src/utils/notificationCopy.js`, sent by `notifyAssignmentReminder` in `src/utils/notifyEvents.js`
Sent to: students enrolled in the course who have not submitted, when a teacher (or admin) taps "Remind students" on the assignment. Limited to one send per assignment every 2 hours.

- **Title:** `⏰ Reminder: {assignmentTitle}` (past due: `⏰ Still open: {assignmentTitle}`)
- **Body:** `{courseTitle} · Due {dueDate} · You have not submitted yet. Finish it for {xp}+ XP`
  - Past due: `{courseTitle} · Was due {overdueDate} · Submit it now so you do not fall behind`
  - No due date: the `Due …` part is left out.

### 2. Live class started — `live_class_started`
Source: `src/utils/notifyEvents.js` (`notifyLiveClassStarted`)
Sent to: students with an active subscription for the course (skipped if live classes are disabled for the course).

- **Title:** `🔴 Live now: {liveClassTitle}`
- **Body:** `{teacherName} just started a live class in {courseTitle}. Tap to join.`
  - `in {courseTitle}` is left out if there is no course title.
  - `teacherName` falls back to `Your teacher`.

### 3. Live class reminder — `live_class_reminder`
Source: `src/utils/notifyEvents.js` (`notifyClassScheduleReminder`), triggered by `src/utils/classScheduler.js`
Sent to: students with an active subscription for the course, about 15 minutes before a scheduled slot.

- **Title:** `⏰ Starting soon: {courseTitle}`
- **Body:** `Your live class starts in 15 minutes.`

### 4. Daily champion — `daily_champion`
Source: `src/utils/dailyDigest.js` (`sendDailyChampionShoutout`)
Sent to: every active student, once a day after 7 PM Cambodia time. Not sent if nobody studied.

- **Title:** `🏆 Today's most active: {championName}`
- **Body:** `{championName} finished {count} {lesson or quiz | lessons and quizzes} today. Can you top that tomorrow?`
  - Uses `lesson or quiz` when count is 1, otherwise `lessons and quizzes`.

### 5. Daily reminder — `daily_reminder`
Source: `src/utils/dailyDigest.js` (`sendInactivityReminders`)
Sent to: every active student with no activity today, same daily run as the champion alert.

- **Title:** `📚 Come learn something today!`
- **Body:** `You haven't studied yet today — even 10 minutes keeps your streak alive.`

### 6. Daily Challenge streak — `daily_challenge_streak`
Source: `src/routes/dailyChallenge.routes.js` (around line 249)
Sent to: the student who reaches a streak milestone.

- **Title:** `🔥 {milestone}-day streak!`
- **Body:** `You've completed the Daily Challenge {milestone} days in a row — +{streakBonusXp} XP!`

---

## Defined but not used (friend activity)

Source: `src/utils/notificationTemplates.js` (`friendNotification`)

I found no code that calls `friendNotification`, so these are **not sent right now**.
If friend notifications were removed on purpose, this file can be deleted.

Each type has 3 variants, picked at random, in two styles: `balanced` (default) and
`competitive` (based on the recipient's `notification_style`). `cta` is the action button label key.

### Friend beat your score — `friend_beat_score`

| Style | Title | Body | cta |
|---|---|---|---|
| balanced | `🏆 {name} just edged you out!` | `They scored {score}%. Retake and reclaim the top spot.` | challenge |
| balanced | `📈 New high score on the board` | `{name} hit {score}% — think you can top it?` | challenge |
| balanced | `👀 {name} is pulling ahead` | `{score}% and climbing. Your turn.` | challenge |
| competitive | `🥊 CHALLENGE ALERT! 🥊` | `{name} scored {score}%! Time to fight for 1st place!` | retake |
| competitive | `🔥 YOU'VE BEEN OVERTAKEN 🔥` | `{name} just dropped a {score}%. Get back out there!` | retake |
| competitive | `⚔️ RIVALRY UPDATE` | `{name}: {score}%. You: not anymore #1. Fix that.` | retake |

### Friend finished a lesson — `friend_lesson`

| Style | Title | Body | cta |
|---|---|---|---|
| balanced | `📚 {name} completed a lesson` | `{name} finished "{lessonTitle}" — keep pace!` | lets_go |
| balanced | `✅ {name} just wrapped up a chapter` | `"{lessonTitle}" — done. Your turn to catch up.` | lets_go |
| balanced | `🚶 {name} is moving through the course` | `They just finished "{lessonTitle}".` | lets_go |
| competitive | `📚 {name}: 1️⃣ Lesson Complete ✓` | `You: ❓  Let's go! 🏃‍♂️` | lets_go |
| competitive | `🏁 {name} just crossed a finish line` | `Where are you? Get moving!` | lets_go |
| competitive | `📊 The gap just got wider` | `{name} finished another lesson. Don't fall behind.` | lets_go |

### Friend took a quiz — `friend_quiz`

| Style | Title | Body | cta |
|---|---|---|---|
| balanced | `📝 {name} took a quiz` | `{name} completed "{quizTitle}"` | try_it |
| balanced | `🙋 {name} just tried "{quizTitle}"` | `See how you'd do.` | try_it |
| balanced | `🎲 New quiz attempt from {name}` | `"{quizTitle}" — want to give it a shot too?` | try_it |
| competitive | `🎯 {name} just did "{quizTitle}"` | `Your move — go beat their score.` | beat_it |
| competitive | `🚨 A challenger has appeared` | `{name} took "{quizTitle}". Show them how it's done.` | beat_it |
| competitive | `🏹 Target locked` | `{name} set a score on "{quizTitle}". Take it down.` | beat_it |
