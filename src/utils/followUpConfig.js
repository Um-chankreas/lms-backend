// Every number the Follow-up page's rules use. Change them here, nowhere else.
module.exports = {
  windowDays: 14,                 // metrics look at the last 14 days
  attendJoinedMinutes: 15,        // a class counts as joined at this many minutes (see liveReport ATTEND_MINUTES)
  attendance: { regular: 0.7, sometimes: 0.3 },   // joined / held: >= regular, >= sometimes, else rarely, 0 = never
  studiedAfter: { minRatio: 0.5, withinHours: 48 },
  progress: {
    slowBehindPoints: 15,         // this far behind the class pace = slow
    slowNoLessonDays: 7,          // no new lesson for this long = slow
    noneDays: 14,                 // nothing for this long = no progress
    assignmentPassPct: 50,        // below this a past-due assignment counts as failed
  },
  multiSubjectMin: 2,             // case 4 needs at least this many subjects
  newStudent: {
    days: 14,                     // day 1 = the day they joined; from day 15 they are normal
    steps: { tour: 1, firstLesson: 2, telegram: 3, firstQuiz: 4, backDays: 7 },
    firstLiveAfterClasses: 2,     // first live class is due once this many were held
    backDaysNeeded: 3,
    notStarted: { lessonByDay: 3, activeDaysByDay3: 1, missedLiveClasses: 2 },
  },
  engagement: { high: 8, medium: 3 },   // active days in the last 14: >= high, >= medium, >= 1 = low, 0 = none
  welcomeCheckInDays: 2,          // a not-getting-started new student needs a fresh check-in after this many days
  praiseEveryDays: 14,
  followedUpReturnDays: 7,        // a followed-up student returns to Needs follow-up after this
  pageSize: 15,
};
