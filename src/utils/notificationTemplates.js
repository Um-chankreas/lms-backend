// Friend-activity copy used to live here. All notification text (English +
// Khmer, every variant) is now in notificationCopy.js; this file only keeps the
// small helper the rest of the code already imports.
const { renderTemplate } = require('./notificationCopy');

const STYLES = ['balanced', 'competitive'];

function normStyle(s) {
  return STYLES.includes(s) ? s : 'balanced';
}

/**
 * @param {'friend_beat_score'|'friend_lesson'|'friend_quiz'} type
 * @param {string} style  recipient's notification_style
 * @param {object} vars   { name, score, gap, myScore, lessonTitle, quizTitle }
 * @param {'km'|'en'} [lang]
 * @returns {{ title: string, body: string, cta: string }}
 */
function friendNotification(type, style, vars, lang = 'km') {
  const msg = renderTemplate(type, lang, vars, { groups: type === 'friend_beat_score' ? [normStyle(style)] : null });
  return msg ? { title: msg.title, body: msg.body, cta: msg.cta || 'open' } : { title: '', body: '', cta: 'open' };
}

module.exports = { friendNotification, normStyle, STYLES };
