const supabase = require('../config/supabase');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Send an Expo push for a batch of per-recipient messages. Best-effort:
 * never throws, prunes tokens Expo reports as unregistered.
 *
 * @param {{ userId: string, title: string, body: string, data?: object }[]} items
 */
async function pushMany(items) {
  const list = (items || []).filter(x => x && x.userId && x.title && x.body);
  if (list.length === 0) return;

  try {
    const userIds = [...new Set(list.map(i => i.userId))];
    const { data: rows } = await supabase
      .from('push_tokens').select('user_id, token').in('user_id', userIds);

    const tokensByUser = new Map();
    (rows || []).forEach(r => {
      if (!r.token || !r.token.startsWith('ExponentPushToken')) return;
      if (!tokensByUser.has(r.user_id)) tokensByUser.set(r.user_id, []);
      tokensByUser.get(r.user_id).push(r.token);
    });

    const messages = [];
    for (const it of list) {
      for (const to of tokensByUser.get(it.userId) || []) {
        messages.push({
          to,
          title: it.title,
          body: it.body,
          data: it.data || {},
          sound: 'default',
          priority: 'high',
          channelId: 'default',
        });
      }
    }
    if (messages.length === 0) return;

    const dead = [];
    for (const group of chunk(messages, 100)) {
      let json = null;
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(group),
        });
        json = await res.json();
      } catch (e) {
        console.warn('Expo push request failed:', e.message);
        continue;
      }
      (json?.data || []).forEach((r, i) => {
        if (r.status === 'error' && r.details && r.details.error === 'DeviceNotRegistered') {
          dead.push(group[i].to);
        }
      });
    }
    if (dead.length) {
      await supabase.from('push_tokens').delete().in('token', dead);
    }
  } catch (e) {
    console.warn('pushMany failed:', e.message);
  }
}

/** Same message to several users. */
function pushToUsers(userIds, { title, body, data = {} } = {}) {
  return pushMany([...new Set((userIds || []).filter(Boolean))].map(userId => ({ userId, title, body, data })));
}

module.exports = { pushMany, pushToUsers };
