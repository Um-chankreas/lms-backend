// Copy for friend-activity bell notifications, keyed by the *recipient's*
// notification_style (028_notification_style). `balanced` is the default and
// the fallback for any unknown style.
//
// Each builder returns { title, body, cta } — `cta` is the action-button
// label key the mobile app localises (see i18n `notifications.cta.*`).
//
// Each (type, style) has a few variants, picked at random per call, so the
// same event doesn't show the exact same line every single time — a friend
// beating your score five times shouldn't read like a stuck record.

const STYLES = ['balanced', 'competitive'];

function normStyle(s) {
  return STYLES.includes(s) ? s : 'balanced';
}

const pick = (variants) => variants[Math.floor(Math.random() * variants.length)];

const T = {
  friend_beat_score: {
    balanced: ({ name, score }) => pick([
      { title: `🏆 ${name} just edged you out!`, body: `They scored ${score}%. Retake and reclaim the top spot.`, cta: 'challenge' },
      { title: `📈 New high score on the board`, body: `${name} hit ${score}% — think you can top it?`, cta: 'challenge' },
      { title: `👀 ${name} is pulling ahead`, body: `${score}% and climbing. Your turn.`, cta: 'challenge' },
    ]),
    competitive: ({ name, score }) => pick([
      { title: '🥊 CHALLENGE ALERT! 🥊', body: `${name} scored ${score}%! Time to fight for 1st place!`, cta: 'retake' },
      { title: '🔥 YOU\'VE BEEN OVERTAKEN 🔥', body: `${name} just dropped a ${score}%. Get back out there!`, cta: 'retake' },
      { title: '⚔️ RIVALRY UPDATE', body: `${name}: ${score}%. You: not anymore #1. Fix that.`, cta: 'retake' },
    ]),
  },
  friend_lesson: {
    balanced: ({ name, lessonTitle }) => pick([
      { title: `📚 ${name} completed a lesson`, body: `${name} finished "${lessonTitle}" — keep pace!`, cta: 'lets_go' },
      { title: `✅ ${name} just wrapped up a chapter`, body: `"${lessonTitle}" — done. Your turn to catch up.`, cta: 'lets_go' },
      { title: `🚶 ${name} is moving through the course`, body: `They just finished "${lessonTitle}".`, cta: 'lets_go' },
    ]),
    competitive: ({ name }) => pick([
      { title: `📚 ${name}: 1️⃣ Lesson Complete ✓`, body: 'You: ❓  Let\'s go! 🏃‍♂️', cta: 'lets_go' },
      { title: `🏁 ${name} just crossed a finish line`, body: 'Where are you? Get moving!', cta: 'lets_go' },
      { title: `📊 The gap just got wider`, body: `${name} finished another lesson. Don't fall behind.`, cta: 'lets_go' },
    ]),
  },
  friend_quiz: {
    balanced: ({ name, quizTitle }) => pick([
      { title: `📝 ${name} took a quiz`, body: `${name} completed "${quizTitle}"`, cta: 'try_it' },
      { title: `🙋 ${name} just tried "${quizTitle}"`, body: "See how you'd do.", cta: 'try_it' },
      { title: `🎲 New quiz attempt from ${name}`, body: `"${quizTitle}" — want to give it a shot too?`, cta: 'try_it' },
    ]),
    competitive: ({ name, quizTitle }) => pick([
      { title: `🎯 ${name} just did "${quizTitle}"`, body: 'Your move — go beat their score.', cta: 'beat_it' },
      { title: '🚨 A challenger has appeared', body: `${name} took "${quizTitle}". Show them how it's done.`, cta: 'beat_it' },
      { title: '🏹 Target locked', body: `${name} set a score on "${quizTitle}". Take it down.`, cta: 'beat_it' },
    ]),
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
