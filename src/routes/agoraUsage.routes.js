const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { MINUTES_MULTIPLIER, DAY_MS, getUsage, ymd } = require('../utils/agoraUsage');
const { listAccounts, getActiveKey } = require('../utils/agoraAccounts');

/**
 * GET /api/admin/agora-usage?month=YYYY-MM   (default: this month, UTC)
 *
 * Our own estimate of Agora minutes used, from agora_usage_sessions. Mirrors
 * the Agora console's monthly view: used vs the free allowance, the daily
 * curve, and which classes used the minutes. It can differ slightly from the
 * console, which remains the source of truth for billing.
 */
router.get('/', authenticateToken, isAdmin, async (req, res) => {
  try {
    const now = new Date();
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(req.query.month || ''));
    const year = m ? Number(m[1]) : now.getUTCFullYear();
    const month = m ? Number(m[2]) - 1 : now.getUTCMonth();

    const fromMs = Date.UTC(year, month, 1);
    const toMs = Date.UTC(year, month + 1, 1);
    const isCurrent = now.getTime() >= fromMs && now.getTime() < toMs;
    const daysInMonth = Math.round((toMs - fromMs) / DAY_MS);

    // ?account=<id|env> picks an Agora account; default is the active one.
    const accounts = await listAccounts();
    const wanted = String(req.query.account || '') || await getActiveKey();
    const account = accounts.find((a) => a.key === wanted) || accounts[0];
    const FREE_MINUTES = account.freeMinutes;

    const { daily, byClass, byKind, total, activeNow } = await getUsage(fromMs, toMs, account.key);

    const days = [];
    for (let i = 0; i < daysInMonth; i += 1) {
      const date = ymd(fromMs + i * DAY_MS);
      days.push({ date, minutes: daily.get(date) || 0 });
    }

    // Class titles for the breakdown.
    const classIds = [...byClass.keys()];
    const titles = new Map();
    if (classIds.length) {
      const { data: classes } = await supabase.from('live_classes')
        .select('id, title, teacher_id, started_at, courses(title)').in('id', classIds);
      const teacherIds = [...new Set((classes || []).map((c) => c.teacher_id).filter(Boolean))];
      const { data: teachers } = teacherIds.length
        ? await supabase.from('users').select('id, name').in('id', teacherIds)
        : { data: [] };
      const tname = new Map((teachers || []).map((t) => [t.id, t.name]));
      (classes || []).forEach((c) => titles.set(c.id, {
        title: c.title, course: c.courses?.title || null, teacher: tname.get(c.teacher_id) || null, started_at: c.started_at,
      }));
    }

    const classesOut = [...byClass.values()]
      .filter((c) => c.minutes > 0)
      .map((c) => ({
        live_class_id: c.live_class_id,
        title: titles.get(c.live_class_id)?.title || 'Deleted class',
        course: titles.get(c.live_class_id)?.course || null,
        teacher: titles.get(c.live_class_id)?.teacher || null,
        started_at: titles.get(c.live_class_id)?.started_at || null,
        minutes: c.minutes,
        participants: c.users.size,
      }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 50);

    const elapsedDays = isCurrent ? Math.max(1, now.getUTCDate() - 1 + now.getUTCHours() / 24) : daysInMonth;
    const projected = isCurrent ? Math.round((total / elapsedDays) * daysInMonth) : total;

    res.json({
      success: true,
      data: {
        account: { id: account.key, label: account.label, app_id: account.appId || null, email: account.email || null },
        month: `${year}-${String(month + 1).padStart(2, '0')}`,
        is_current_month: isCurrent,
        free_minutes: FREE_MINUTES,
        minutes_multiplier: MINUTES_MULTIPLIER,
        used_minutes: total,
        remaining_minutes: Math.max(0, FREE_MINUTES - total),
        overage_minutes: Math.max(0, total - FREE_MINUTES),
        percent_used: Math.round((total / FREE_MINUTES) * 1000) / 10,
        projected_minutes: projected,
        active_now: activeNow,
        by_kind: byKind,
        daily: days,
        classes: classesOut,
      },
    });
  } catch (error) {
    console.error('Agora usage error:', error);
    res.status(500).json({ success: false, error: 'Failed to load Agora usage' });
  }
});

module.exports = router;
