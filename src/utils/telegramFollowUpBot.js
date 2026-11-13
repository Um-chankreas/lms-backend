const M = require('./followUpMessages');

// What the bot does when a student taps a button on a follow-up message or types a reply.
// The database and Telegram are passed in (`store`, `tg`, `notify`), so the logic is unit tested with fakes.
//
// store: claimUpdate(id) -> bool (false = seen before) · getMessage(id) · markChosen(id, value) · markReplied(id)
//        insertFollowUp(row) · insertInbox(row) · reasons() -> { reason: { label, reply, reply_links } }
//        callbackReplies() -> { call_me: {km,en}, help: {km,en} } · teacher(id) -> { id, name }
//        courseTitle(id) · studentByChat(chatId) -> { id, name } | null · lastMessageToChat(chatId) · linkBase()
// tg:    answerCallback(id, text) · editMessage(chat, msg, text, extra) · sendPlain(chat, text, extra)
// notify(userId, { title, body, data, priority })

const pick = (o, lang) => (o && (o[lang] || o.km || o.en)) || '';
const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null || vars[k] === '' ? m : vars[k]));
const LINK_LABELS = {
  recording: { km: 'មើលវីដេអូថត', en: 'Watch recording' }, recordings: { km: 'មើលវីដេអូថត', en: 'Watch recordings' },
  live: { km: 'មើលម៉ោងរៀន', en: 'See class times' }, review: { km: 'មើលវីដេអូពន្យល់', en: 'Watch review' },
  downloads: { km: 'ទាញយកមេរៀន', en: 'Downloads' },
};

function makeBot({ store, tg, notify }) {
  async function replyWithLinks(chatId, text, links, lang, vars) {
    const rows = (links || []).map(l => {
      const target = fill(l, vars);
      return [{ text: pick(LINK_LABELS[target.split(':')[0]], lang) || (lang === 'en' ? 'Open' : 'បើក'), url: M.targetToLink(target, vars, store.linkBase()) }];
    });
    return tg.sendPlain(chatId, text, rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
  }

  /** A button tap. Returns a short string saying what happened (used by tests and logs). */
  async function handleCallback(cb) {
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const parsed = M.parseCallback(cb.data);
    if (!parsed || !chatId) { await tg.answerCallback(cb.id); return 'ignored'; }
    const msg = await store.getMessage(parsed.id);
    // The tap must come from the chat the message was sent to.
    if (!msg || Number(msg.chat_id) !== Number(chatId)) { await tg.answerCallback(cb.id); return 'unknown_message'; }
    await tg.answerCallback(cb.id);                                // answer first, then do the work
    if (msg.chosen_reason) return 'already_answered';
    const lang = msg.lang === 'en' ? 'en' : 'km';
    const teacher = msg.sent_by ? await store.teacher(msg.sent_by) : null;
    const subject = msg.subject_id ? await store.courseTitle(msg.subject_id) : '';
    const saved = (msg.buttons && msg.buttons.vars) || {};
    const vars = { ...saved, teacher: teacher && teacher.name, subject, subject_id: msg.subject_id };
    const student = await store.studentByChat(chatId);

    if (parsed.kind === 'r') {
      const reasons = await store.reasons();
      const r = reasons[parsed.reason];
      const label = r ? pick(r.label, lang) : parsed.reason;
      await store.insertFollowUp({
        student_id: msg.student_id, kind: 'note', reason: parsed.reason, case_code: msg.case_code, course_id: msg.subject_id,
        channel: 'telegram', source: 'student_button', telegram_message_id: msg.id, text: `Student chose: ${label}`,
      });
      await store.markChosen(msg.id, parsed.reason);
      // The original message keeps its text, loses its buttons and shows the choice.
      await tg.editMessage(chatId, cb.message.message_id, `${msg.body_sent}\n\n✓ ${label}`, { reply_markup: { inline_keyboard: [] } });
      if (r) await replyWithLinks(chatId, fill(pick(r.reply, lang), vars), r.reply_links, lang, vars);
      if (msg.sent_by) await notify(msg.sent_by, { title: `${student ? student.name : 'A student'} replied`, body: label, data: { student_id: msg.student_id, kind: 'follow_up_reason', reason: parsed.reason } });
      return 'reason';
    }
    // call_me / help
    const replies = await store.callbackReplies();
    await store.markChosen(msg.id, parsed.kind);
    await store.insertFollowUp({
      student_id: msg.student_id, kind: 'note', case_code: msg.case_code, course_id: msg.subject_id, channel: 'telegram', source: 'student_button',
      telegram_message_id: msg.id, text: parsed.kind === 'call_me' ? 'Student asked to be called' : 'Student asked for help',
    });
    const tapped = ((msg.buttons && msg.buttons.items) || []).find(b => b.callback === parsed.kind);
    await tg.editMessage(chatId, cb.message.message_id, `${msg.body_sent}\n\n✓ ${tapped ? tapped.label : parsed.kind}`, { reply_markup: { inline_keyboard: [] } });
    await tg.sendPlain(chatId, fill(pick(replies[parsed.kind], lang), vars));
    if (msg.sent_by) await notify(msg.sent_by, {
      title: `${student ? student.name : 'A student'} ${parsed.kind === 'call_me' ? 'asked you to call' : 'needs help'}`,
      body: parsed.kind === 'call_me' ? 'Please call them soon.' : 'They tapped “I need help”.', data: { student_id: msg.student_id, kind: parsed.kind }, priority: 'high',
    });
    return parsed.kind;
  }

  /** Free text from a linked student: saved to the inbox, counts as a reply to the last message, teacher is told. */
  async function handleText(chatId, text) {
    const student = await store.studentByChat(chatId);
    const clean = String(text || '').trim().slice(0, 2000);
    if (!student || !clean) return 'ignored';
    const last = await store.lastMessageToChat(chatId);
    await store.insertInbox({ student_id: student.id, message_id: last ? last.id : null, text: clean });
    if (last) await store.markReplied(last.id);
    if (last && last.sent_by) await notify(last.sent_by, { title: `${student.name || 'A student'} replied`, body: clean.slice(0, 140), data: { student_id: student.id, kind: 'inbox' } });
    return 'inbox';
  }

  /** Entry point for a webhook update. A retried update is processed once. */
  async function handleUpdate(update) {
    if (update.update_id != null && !(await store.claimUpdate(update.update_id))) return 'duplicate';
    if (update.callback_query) return handleCallback(update.callback_query);
    const msg = update.message;
    if (msg && msg.chat && msg.chat.type === 'private' && typeof msg.text === 'string' && !msg.text.startsWith('/')) return handleText(msg.chat.id, msg.text);
    return 'ignored';
  }
  return { handleUpdate, handleCallback, handleText };
}

/** The real store, on Supabase. */
function supabaseStore(supabase, linkBase) {
  const one = async (q) => (await q).data || null;
  return {
    linkBase,
    async claimUpdate(id) { const { error } = await supabase.from('telegram_updates').insert({ update_id: id }); return !error; },
    getMessage: (id) => one(supabase.from('follow_up_messages').select('*').eq('id', id).maybeSingle()),
    async markChosen(id, v) { await supabase.from('follow_up_messages').update({ chosen_reason: v, replied_at: new Date().toISOString() }).eq('id', id); },
    async markReplied(id) { await supabase.from('follow_up_messages').update({ replied_at: new Date().toISOString() }).eq('id', id); },
    async insertFollowUp(row) { await supabase.from('student_followups').insert(row); },
    async insertInbox(row) { await supabase.from('telegram_inbox').insert(row); },
    async reasons() { const { data } = await supabase.from('message_reasons').select('*'); const o = {}; (data || []).forEach(r => { o[r.reason] = { label: { km: r.label_km, en: r.label_en }, reply: { km: r.reply_km, en: r.reply_en }, reply_links: r.reply_links || [] }; }); return o; },
    async callbackReplies() { const o = await this.reasons(); return { call_me: o.call_me && o.call_me.reply, help: o.help && o.help.reply }; },
    teacher: (id) => one(supabase.from('users').select('id, name').eq('id', id).maybeSingle()),
    async courseTitle(id) { const c = await one(supabase.from('courses').select('title').eq('id', id).maybeSingle()); return c ? c.title : ''; },
    async studentByChat(chatId) {
      const p = await one(supabase.from('student_private').select('user_id').eq('telegram_chat_id', chatId).maybeSingle());
      if (!p) return null;
      const u = await one(supabase.from('users').select('id, name').eq('id', p.user_id).maybeSingle());
      return u;
    },
    lastMessageToChat: (chatId) => one(supabase.from('follow_up_messages').select('id, sent_by').eq('chat_id', chatId).eq('status', 'sent').order('sent_at', { ascending: false }).limit(1).maybeSingle()),
  };
}

module.exports = { makeBot, supabaseStore, LINK_LABELS };
