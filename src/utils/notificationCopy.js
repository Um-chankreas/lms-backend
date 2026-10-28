// All notification text (English + Khmer) for Notification System v2.
//
//   template_key -> { kind, push, pick, defaults?, variants: [{ id, group?, en, km }] }
//
// - `kind`: 'class' (teacher/class events, no daily cap) or 'nudge' (automatic,
//   capped at 2 per student per day).
// - `push: false` = bell only.
// - `pick: 'first'` takes the first variant that has all its values (class
//   messages with fallbacks); the default `'random'` rotates through variants
//   and skips the ones this student saw in the last 5 days.
// - `unless: ['x']` skips a variant when `x` HAS a value (the no-XP fallbacks).
// - `group` narrows which variants a given situation may use (for example the
//   student has a streak, or this is the champion's own message).
// - `{curly}` values are filled in at send time. A variant whose value is empty
//   is skipped (never send "null" or a blank), so each template has fallbacks.
//
// Text style: short, friendly, no ALL CAPS, no long dashes.

const T = {
  // ── Class notifications ─────────────────────────────────────────────────
  assignment_new: {
    kind: 'class',
    pick: 'first',
    defaults: { courseTitle: { en: 'Your course', km: 'វគ្គសិក្សារបស់អ្នក' } },
    variants: [
      {
        id: 'a',
        en: { title: '📚 New assignment: {assignmentTitle}', body: '{courseTitle} · Due {dueDate} · Finish on time for {xp}+ XP' },
        km: { title: '📚 កិច្ចការថ្មី៖ {assignmentTitle}', body: '{courseTitle} · ផុតកំណត់ {dueDate} · ធ្វើទាន់ពេល ទទួលបាន {xp}+ XP' },
      },
      {
        id: 'a-nodue',
        en: { title: '📚 New assignment: {assignmentTitle}', body: '{courseTitle} · Finish it for {xp}+ XP' },
        km: { title: '📚 កិច្ចការថ្មី៖ {assignmentTitle}', body: '{courseTitle} · ធ្វើឲ្យចប់ ទទួលបាន {xp}+ XP' },
      },
    ],
  },

  // Sent by hand: the teacher taps "Remind students" on an assignment, and only
  // students who have not submitted get it. Variants run most to least specific.
  assignment_reminder: {
    kind: 'class',
    pick: 'first',
    defaults: { courseTitle: { en: 'Your course', km: 'វគ្គសិក្សារបស់អ្នក' } },
    variants: [
      {
        id: 'overdue',
        en: { title: '⏰ Still open: {assignmentTitle}', body: '{courseTitle} · Was due {overdueDate} · Submit it now so you do not fall behind' },
        km: { title: '⏰ នៅមិនទាន់ធ្វើ៖ {assignmentTitle}', body: '{courseTitle} · ផុតកំណត់ {overdueDate} · សូមធ្វើឥឡូវនេះ កុំឲ្យយឺតជាងនេះ' },
      },
      {
        id: 'due',
        en: { title: '⏰ Reminder: {assignmentTitle}', body: '{courseTitle} · Due {dueDate} · You have not submitted yet. Finish it for {xp}+ XP' },
        km: { title: '⏰ រំលឹក៖ {assignmentTitle}', body: '{courseTitle} · ផុតកំណត់ {dueDate} · អ្នកមិនទាន់បានដាក់ជូនទេ។ ធ្វើឲ្យចប់ ទទួលបាន {xp}+ XP' },
      },
      {
        id: 'nodue',
        en: { title: '⏰ Reminder: {assignmentTitle}', body: '{courseTitle} · You have not submitted yet. Finish it for {xp}+ XP' },
        km: { title: '⏰ រំលឹក៖ {assignmentTitle}', body: '{courseTitle} · អ្នកមិនទាន់បានដាក់ជូនទេ។ ធ្វើឲ្យចប់ ទទួលបាន {xp}+ XP' },
      },
    ],
  },

  live_class_started: {
    kind: 'class',
    pick: 'first',
    defaults: { teacherName: { en: 'Your teacher', km: 'គ្រូរបស់អ្នក' } },
    variants: [
      {
        id: 'a',
        en: { title: '🔴 Live now: {liveClassTitle}', body: '{teacherName} is teaching {courseTitle} right now. Tap to join.' },
        km: { title: '🔴 កំពុងបង្រៀនផ្ទាល់៖ {liveClassTitle}', body: '{teacherName} កំពុងបង្រៀន {courseTitle} ឥឡូវនេះ។ ចុចដើម្បីចូលរួម។' },
      },
      {
        id: 'a-nocourse',
        en: { title: '🔴 Live now: {liveClassTitle}', body: '{teacherName} is teaching right now. Tap to join.' },
        km: { title: '🔴 កំពុងបង្រៀនផ្ទាល់៖ {liveClassTitle}', body: '{teacherName} កំពុងបង្រៀនឥឡូវនេះ។ ចុចដើម្បីចូលរួម។' },
      },
    ],
  },

  live_class_reminder: {
    kind: 'class',
    pick: 'first',
    defaults: { teacherName: { en: 'Your teacher', km: 'គ្រូរបស់អ្នក' } },
    variants: [
      {
        id: 'a',
        en: { title: '⏰ In 15 min: {courseTitle}', body: '{teacherName} starts "{liveClassTitle}" at {time}. Get ready.' },
        km: { title: '⏰ 15 នាទីទៀត៖ {courseTitle}', body: '{teacherName} ចាប់ផ្ដើម "{liveClassTitle}" ម៉ោង {time}។ ត្រៀមខ្លួនណា!' },
      },
      {
        id: 'a-notitle',
        en: { title: '⏰ In 15 min: {courseTitle}', body: '{teacherName} starts class at {time}. Get ready.' },
        km: { title: '⏰ 15 នាទីទៀត៖ {courseTitle}', body: '{teacherName} ចាប់ផ្ដើមម៉ោង {time}។ ត្រៀមខ្លួនណា!' },
      },
    ],
  },

  // ── Nudges ──────────────────────────────────────────────────────────────
  daily_reminder: {
    kind: 'nudge',
    variants: [
      // Group A: has a streak
      { id: 'A1', group: 'A', en: { title: '🔥 Day {streakNext}?', body: "One practice set and it's yours." }, km: { title: '🔥 ថ្ងៃទី {streakNext}?', body: 'ធ្វើលំហាត់មួយឈុត ហើយថ្ងៃនេះជារបស់អ្នក។' } },
      { id: 'A2', group: 'A', en: { title: '📖 Today: {nextLessonTitle}', body: 'About {lessonMinutes} minutes. Your {streak}-day streak is waiting.' }, km: { title: '📖 ថ្ងៃនេះ៖ {nextLessonTitle}', body: 'ប្រហែល {lessonMinutes} នាទីប៉ុណ្ណោះ។ អ្នករៀនជាប់គ្នា {streak} ថ្ងៃហើយ។' } },
      { id: 'A3', group: 'A', en: { title: '💪 {streak} days in a row', body: "Don't stop now. Today's lesson is short." }, km: { title: '💪 រៀនជាប់គ្នា {streak} ថ្ងៃហើយ', body: 'កុំឈប់ឥឡូវ។ មេរៀនថ្ងៃនេះខ្លីទេ។' } },
      { id: 'A4', group: 'A', en: { title: '⚡ Quick one today?', body: '{lessonMinutes} minutes keeps your {streak}-day streak going.' }, km: { title: '⚡ រៀនបន្តិចថ្ងៃនេះ?', body: 'ត្រឹមតែ {lessonMinutes} នាទី ក៏រក្សាការរៀនជាប់គ្នា {streak} ថ្ងៃបានដែរ។' } },
      // Group B: no streak
      { id: 'B1', group: 'B', en: { title: '📖 Next up: {nextLessonTitle}', body: 'Start a new streak today. It only takes {lessonMinutes} minutes.' }, km: { title: '📖 មេរៀនបន្ទាប់៖ {nextLessonTitle}', body: 'ចាប់ផ្ដើមរៀនជាប់គ្នាម្ដងទៀតថ្ងៃនេះ។ ត្រឹមតែ {lessonMinutes} នាទី។' } },
      { id: 'B2', group: 'B', en: { title: '🌱 Fresh start', body: 'Day 1 of a new streak is one lesson away.' }, km: { title: '🌱 ចាប់ផ្ដើមថ្មី', body: 'ថ្ងៃទី 1 នៃការរៀនជាប់គ្នា នៅសល់តែមេរៀនមួយទៀតប៉ុណ្ណោះ។' } },
      { id: 'B3', group: 'B', en: { title: '🤔 Did you know?', body: "{curiosityQuestion} Find out in today's lesson." }, km: { title: '🤔 តើអ្នកដឹងទេ?', body: '{curiosityQuestion} រកចម្លើយក្នុងមេរៀនថ្ងៃនេះ។' } },
      // Group C: a quiz is 1 to 5 days away (needs a quiz date; none is stored yet)
      { id: 'C1', group: 'C', en: { title: '📅 {quizTitle} in {daysToQuiz} days', body: "You've finished {pctTopicsDone}% of the topics. Keep going." }, km: { title: '📅 {quizTitle} នៅសល់ {daysToQuiz} ថ្ងៃទៀត', body: 'អ្នករៀនបាន {pctTopicsDone}% នៃមេរៀនហើយ។ បន្តទៀត!' } },
      { id: 'C2', group: 'C', en: { title: '🎯 {daysToQuiz} days to {quizTitle}', body: "Today's practice is exactly what's on it." }, km: { title: '🎯 {daysToQuiz} ថ្ងៃទៀតដល់ {quizTitle}', body: 'លំហាត់ថ្ងៃនេះ គឺចំអ្វីដែលនឹងចេញ។' } },
    ],
  },

  streak_at_risk: {
    kind: 'nudge',
    variants: [
      { id: 'a', group: 'std', en: { title: "⏳ {streak} days. Don't lose it tonight.", body: 'One practice set before midnight saves your streak.' }, km: { title: '⏳ {streak} ថ្ងៃហើយ។ កុំឲ្យដាច់យប់នេះ។', body: 'ធ្វើលំហាត់មួយឈុតមុនម៉ោង 12 យប់ ដើម្បីរក្សាវាទុក។' } },
      { id: 'b', group: 'std', en: { title: '🔥 Your {streak}-day streak ends at midnight', body: 'You still have time. 5 minutes is enough.' }, km: { title: '🔥 រៀនជាប់គ្នា {streak} ថ្ងៃ នឹងដាច់ម៉ោង 12 យប់', body: 'នៅមានពេលទៀត។ 5 នាទីគឺគ្រប់គ្រាន់។' } },
      { id: 'c', group: 'std', en: { title: '😬 So close to losing {streak} days', body: 'Open the app and finish one set. That\'s it.' }, km: { title: '😬 ជិតបាត់ {streak} ថ្ងៃហើយ', body: 'បើកកម្មវិធី ហើយធ្វើលំហាត់មួយឈុត។ អស់ហ្នឹង។' } },
      // Only for students who hold a streak pass / freeze (no such field exists yet).
      { id: 'pass', group: 'pass', en: { title: '🛡️ Your {streak}-day streak', body: 'Study today and save your streak pass for a harder day.' }, km: { title: '🛡️ រៀនជាប់គ្នា {streak} ថ្ងៃរបស់អ្នក', body: 'រៀនថ្ងៃនេះ ហើយទុកសិទ្ធិការពារសម្រាប់ថ្ងៃដែលរវល់ជាងនេះ។' } },
    ],
  },

  streak_milestone: {
    kind: 'nudge',
    variants: [
      { id: 'a', group: 'std', en: { title: '🔥 {milestone}-day streak!', body: '{milestone} days in a row. +{streakBonusXp} XP for you.' }, km: { title: '🔥 រៀនជាប់គ្នា {milestone} ថ្ងៃ!', body: '{milestone} ថ្ងៃមិនដាច់។ ទទួលបាន +{streakBonusXp} XP។' } },
      { id: 'b', group: 'std', en: { title: '🎉 {milestone} days, no break', body: "That's real discipline. +{streakBonusXp} XP added." }, km: { title: '🎉 {milestone} ថ្ងៃ មិនឈប់សោះ', body: 'នេះហើយជាវិន័យពិតប្រាកដ។ បន្ថែម +{streakBonusXp} XP។' } },
      // Milestones that carry no XP bonus (3, 50, 100 today) must not say "+0 XP".
      { id: 'c', group: 'std', unless: ['streakBonusXp'], en: { title: '🔥 {milestone}-day streak!', body: '{milestone} days in a row. Keep it going.' }, km: { title: '🔥 រៀនជាប់គ្នា {milestone} ថ្ងៃ!', body: '{milestone} ថ្ងៃមិនដាច់។ បន្តទៀត!' } },
      { id: 'big', group: 'big', en: { title: '🏅 {milestone} days!', body: 'Only a few students ever get here. +{streakBonusXp} XP.' }, km: { title: '🏅 {milestone} ថ្ងៃ!', body: 'មានសិស្សតិចណាស់ដែលមកដល់ទីនេះ។ +{streakBonusXp} XP។' } },
      { id: 'big-noxp', group: 'big', unless: ['streakBonusXp'], en: { title: '🏅 {milestone} days!', body: 'Only a few students ever get here. Keep going.' }, km: { title: '🏅 {milestone} ថ្ងៃ!', body: 'មានសិស្សតិចណាស់ដែលមកដល់ទីនេះ។ បន្តទៀត!' } },
    ],
  },

  assignment_due_soon: {
    kind: 'nudge',
    variants: [
      { id: 'a', group: 'tomorrow', en: { title: '📝 Due tomorrow: {assignmentTitle}', body: 'Finish on time to get {xp}+ XP.' }, km: { title: '📝 ផុតកំណត់ថ្ងៃស្អែក៖ {assignmentTitle}', body: 'ធ្វើឲ្យទាន់ពេល ទទួលបាន {xp}+ XP។' } },
      { id: 'b', group: ['tomorrow', 'today'], en: { title: '⌛ {assignmentTitle} is due soon', body: 'Due {dueDate} at {time}. You can still make it.' }, km: { title: '⌛ {assignmentTitle} ជិតផុតកំណត់ហើយ', body: 'ផុតកំណត់ {dueDate} ម៉ោង {time}។ អ្នកនៅទាន់។' } },
    ],
  },

  quiz_soon: {
    kind: 'nudge',
    variants: [
      { id: 'a', en: { title: '📅 {quizTitle} in 2 days', body: "You've finished {pctTopicsDone}% of the topics." }, km: { title: '📅 {quizTitle} នៅសល់ 2 ថ្ងៃទៀត', body: 'អ្នករៀនបាន {pctTopicsDone}% នៃមេរៀនហើយ។' } },
      { id: 'b', en: { title: '🎯 {quizTitle} is coming', body: 'Weakest topic: {weakestTopic}. Practice it today.' }, km: { title: '🎯 {quizTitle} ជិតមកដល់ហើយ', body: 'ផ្នែកដែលអ្នកខ្សោយជាងគេ៖ {weakestTopic}។ ហាត់វាថ្ងៃនេះ។' } },
    ],
  },

  comeback: {
    kind: 'nudge',
    variants: [
      { id: 'd3', group: '3', en: { title: '👋 We saved your spot', body: 'Next lesson: {nextLessonTitle}. Pick up where you stopped.' }, km: { title: '👋 យើងរក្សាកន្លែងរបស់អ្នកទុក', body: 'មេរៀនបន្ទាប់៖ {nextLessonTitle}។ បន្តពីកន្លែងដែលអ្នកឈប់។' } },
      { id: 'd7', group: '7', en: { title: '📖 One short lesson?', body: "It's been a week. {lessonMinutes} minutes is a good restart." }, km: { title: '📖 មេរៀនខ្លីមួយទេ?', body: 'មួយសប្ដាហ៍ហើយ។ {lessonMinutes} នាទី ល្អសម្រាប់ចាប់ផ្ដើមវិញ។' } },
      { id: 'd14', group: '14', en: { title: '🌱 Ready when you are', body: 'Your progress is still here. This is our last reminder for now.' }, km: { title: '🌱 ពេលណាក៏បាន ពេលអ្នករួចរាល់', body: 'វឌ្ឍនភាពរបស់អ្នកនៅដដែល។ នេះជាការរំលឹកចុងក្រោយសិន។' } },
      // Fallbacks when the optional value above is missing (a student must still get a message).
      { id: 'd3-plain', group: '3', en: { title: '👋 We saved your spot', body: 'Pick up where you stopped. One short lesson is enough.' }, km: { title: '👋 យើងរក្សាកន្លែងរបស់អ្នកទុក', body: 'បន្តពីកន្លែងដែលអ្នកឈប់។ មេរៀនខ្លីមួយក៏គ្រប់គ្រាន់។' } },
      { id: 'd7-plain', group: '7', en: { title: '📖 One short lesson?', body: "It's been a week. A short lesson is a good restart." }, km: { title: '📖 មេរៀនខ្លីមួយទេ?', body: 'មួយសប្ដាហ៍ហើយ។ មេរៀនខ្លីមួយ ល្អសម្រាប់ចាប់ផ្ដើមវិញ។' } },
    ],
  },

  daily_champion: {
    kind: 'nudge',
    variants: [
      { id: 'champion', group: 'champion', en: { title: "🏆 You're today's top learner!", body: '{count} lessons and quizzes done well today. Great work.' }, km: { title: '🏆 អ្នករៀនពូកែជាងគេថ្ងៃនេះ!', body: 'ធ្វើបានល្អ {count} មេរៀន និងតេស្តថ្ងៃនេះ។ ល្អណាស់!' } },
      { id: 'a', group: 'others', en: { title: "🏆 Today's top learner: {championName}", body: '{championName} finished {countText} today. You did {myCount}. Nice work too.' }, km: { title: '🏆 ពូកែជាងគេថ្ងៃនេះ៖ {championName}', body: '{championName} ធ្វើបាន {countText}។ អ្នកធ្វើបាន {myCount}។ អ្នកក៏ល្អដែរ។' } },
      { id: 'b', group: 'others', en: { title: '🌟 {championName} led today', body: 'You studied today as well. Tomorrow could be yours.' }, km: { title: '🌟 {championName} នាំមុខថ្ងៃនេះ', body: 'អ្នកក៏បានរៀនថ្ងៃនេះដែរ។ ស្អែកអាចជាវេនរបស់អ្នក។' } },
    ],
  },

  friend_beat_score: {
    kind: 'nudge',
    variants: [
      { id: 'a', group: 'balanced', cta: 'challenge', en: { title: '🏆 {name} just passed you', body: 'They got {score}% on "{quizTitle}". You can catch up.' }, km: { title: '🏆 {name} ទើបតែឈ្នះអ្នក', body: '{name} បាន {score}% លើ "{quizTitle}"។ អ្នកអាចតាមទាន់។' } },
      { id: 'b', group: 'balanced', cta: 'challenge', en: { title: '📈 New top score by {name}', body: '{score}% on "{quizTitle}". Think you can beat it?' }, km: { title: '📈 ពិន្ទុខ្ពស់ថ្មីរបស់ {name}', body: '{score}% លើ "{quizTitle}"។ អាចឈ្នះបានទេ?' } },
      { id: 'c', group: 'balanced', cta: 'challenge', en: { title: '👀 {name} is close to you', body: '{score}% on "{quizTitle}". Your turn.' }, km: { title: '👀 {name} នៅជិតអ្នកហើយ', body: '{score}% លើ "{quizTitle}"។ ដល់វេនអ្នកហើយ។' } },
      { id: 'a', group: 'competitive', cta: 'retake', en: { title: '⚔️ {name} took the lead', body: '{score}% on "{quizTitle}". Only {gap} points ahead. Win it back.' }, km: { title: '⚔️ {name} នាំមុខហើយ', body: '{score}% លើ "{quizTitle}"។ លើសតែ {gap} ពិន្ទុ។ យកវាមកវិញ!' } },
      { id: 'b', group: 'competitive', cta: 'retake', en: { title: '🥊 Rematch?', body: '{name} scored {score}% on "{quizTitle}". Show them your best.' }, km: { title: '🥊 ប្រកួតម្ដងទៀត?', body: '{name} បាន {score}% លើ "{quizTitle}"។ បង្ហាញសមត្ថភាពរបស់អ្នក។' } },
      { id: 'c', group: 'competitive', cta: 'retake', en: { title: "🔥 You've been passed", body: '{name} got {score}%. You were {myScore}%. Close the gap.' }, km: { title: '🔥 មានគេរំលងអ្នកហើយ', body: '{name} បាន {score}%។ អ្នកបាន {myScore}%។ តាមឲ្យទាន់!' } },
    ],
  },

  // ── Friend activity: bell only, never a push ────────────────────────────
  friend_lesson: {
    kind: 'nudge',
    push: false,
    variants: [
      { id: 'a', cta: 'lets_go', en: { title: '📚 {name} finished a lesson', body: '"{lessonTitle}" is done. Want to study it too?' }, km: { title: '📚 {name} រៀនចប់មេរៀនមួយ', body: '"{lessonTitle}" រួចរាល់។ ចង់រៀនដែរទេ?' } },
    ],
  },
  friend_quiz: {
    kind: 'nudge',
    push: false,
    variants: [
      { id: 'a', cta: 'try_it', en: { title: '📝 {name} took a quiz', body: '"{quizTitle}". See how you\'d score.' }, km: { title: '📝 {name} បានធ្វើតេស្ត', body: '"{quizTitle}"។ សាកមើលថាអ្នកបានប៉ុន្មាន។' } },
    ],
  },
};

// Priority when a student qualifies for more nudges than the daily cap allows
// (1 = most important). friend_lesson / friend_quiz are bell only and never compete.
const PRIORITY = {
  streak_at_risk: 1,
  assignment_due_soon: 2,
  quiz_soon: 3,
  daily_reminder: 4,
  comeback: 5,
  streak_milestone: 6,
  friend_beat_score: 7,
  daily_champion: 8,
};

const KHMER_MONTHS = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TZ = 'Asia/Phnom_Penh';

// Calendar parts of an instant in Cambodia time.
function cambodiaParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(date));
  const get = (t) => parts.find(p => p.type === t)?.value;
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** `{dueDate}`: "Oct 25" in English, "25 តុលា" in Khmer (Cambodia calendar day). */
function formatDay(date, lang) {
  if (!date) return null;
  const p = cambodiaParts(date);
  return lang === 'km' ? `${p.day} ${KHMER_MONTHS[p.month - 1]}` : `${EN_MONTHS[p.month - 1]} ${p.day}`;
}

/** `{time}`: "17:30" (Cambodia time). */
function formatClock(date) {
  if (!date) return null;
  const p = cambodiaParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

const isEmpty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && Number.isNaN(v));
const placeholdersOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]);
const tidy = (s) => String(s).replace(/\s+—\s+/g, ' · ').replace(/—/g, '·').replace(/\s{2,}/g, ' ').trim();

function fill(text, vars) {
  return tidy(String(text).replace(/\{(\w+)\}/g, (_, k) => String(vars[k])));
}

/**
 * Which variants of `templateKey` can be sent right now: they match the
 * requested `group`(s) and every {value} they use is present.
 * Returns [{ id, title, body, cta }] (already filled in).
 */
function eligibleVariants(templateKey, lang, vars, { groups = null } = {}) {
  const tpl = T[templateKey];
  if (!tpl) return [];
  const language = lang === 'en' ? 'en' : 'km';
  const merged = { ...vars };
  for (const [k, byLang] of Object.entries(tpl.defaults || {})) {
    if (isEmpty(merged[k])) merged[k] = byLang[language];
  }
  const want = groups ? [].concat(groups) : null;
  return tpl.variants
    .filter(v => !want || [].concat(v.group || []).some(g => want.includes(g)))
    .map(v => {
      if ((v.unless || []).some(k => !isEmpty(merged[k]))) return null;
      const text = v[language] || v.en;
      const needed = [...placeholdersOf(text.title), ...placeholdersOf(text.body)];
      if (needed.some(k => isEmpty(merged[k]))) return null;
      return { id: v.id, title: fill(text.title, merged), body: fill(text.body, merged), cta: v.cta || null };
    })
    .filter(Boolean);
}

/**
 * Pick the message to send.
 *  - class messages (`pick: 'first'`): the first variant with all its values.
 *  - nudges: random among eligible, skipping variant ids in `recentIds` (what
 *    this student got in the last 5 days); if every variant was recent, any is
 *    allowed rather than sending nothing.
 * Returns { id, title, body, cta } or null when nothing can be built.
 */
function renderTemplate(templateKey, lang, vars, { groups = null, recentIds = [], random = Math.random } = {}) {
  const tpl = T[templateKey];
  const list = eligibleVariants(templateKey, lang, vars, { groups });
  if (!tpl || list.length === 0) return null;
  if (tpl.pick === 'first') return list[0];
  const recent = new Set(recentIds);
  const fresh = list.filter(v => !recent.has(v.id));
  const pool = fresh.length ? fresh : list;
  return pool[Math.floor(random() * pool.length)];
}

module.exports = { T, PRIORITY, TZ, renderTemplate, eligibleVariants, formatDay, formatClock, cambodiaParts, isEmpty };
