// Copy for friend-activity bell notifications, keyed by the *recipient's*
// notification_style (028_notification_style). `balanced` is the default and
// the fallback for any unknown style.
//
// Each builder returns { title, body, cta } — `cta` is the action-button
// label key the mobile app localises (see i18n `notifications.cta.*`).

const STYLES = ['balanced', 'competitive'];

function normStyle(s) {
  return STYLES.includes(s) ? s : 'balanced';
}

const T = {
  friend_beat_score: {
    balanced: ({ name, score }) => ({
      title: `🏆 WOW! ${name} scored ${score}%!`,
      body: 'Time to retake and compete!',
      cta: 'challenge',
    }),
    competitive: ({ name, score }) => ({
      title: '🥊 CHALLENGE ALERT! 🥊',
      body: `${name} scored ${score}%! Time to fight for 1st place!`,
      cta: 'retake',
    }),
  },
  friend_lesson: {
    balanced: ({ name, lessonTitle }) => ({
      title: `📚 ${name} completed a lesson`,
      body: `${name} finished “${lessonTitle}” — keep pace!`,
      cta: 'lets_go',
    }),
    competitive: ({ name }) => ({
      title: `📚 ${name}: 1️⃣ Lesson Complete ✓`,
      body: 'You: ❓  Let’s go! 🏃‍♂️',
      cta: 'lets_go',
    }),
  },
  friend_quiz: {
    balanced: ({ name, quizTitle }) => ({
      title: `📝 ${name} took a quiz`,
      body: `${name} completed “${quizTitle}”`,
      cta: 'try_it',
    }),
    competitive: ({ name, quizTitle }) => ({
      title: `🎯 ${name} just did “${quizTitle}”`,
      body: 'Your move — go beat their score.',
      cta: 'beat_it',
    }),
  },
};

/**
 * @param {'friend_beat_score'|'friend_lesson'|'friend_quiz'} type
 * @param {string} style  recipient's notification_style
 * @param {object} vars   { name, score, lessonTitle, quizTitle }
 * @returns {{ title: string, body: string, cta: string }}
 */
function friendNotification(type, style, vars) {
  const s = normStyle(style);
  const group = T[type];
  const build = group?.[s] || group?.balanced;
  return build ? build(vars) : { title: '', body: '', cta: 'open' };
}

module.exports = { friendNotification, normStyle, STYLES };
