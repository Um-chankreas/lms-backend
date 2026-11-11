const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, isStudent } = require('../middleware/auth');
const { awardXp } = require('../utils/xp');
const { recordActivity } = require('../utils/streak');
const { computeDifficultyAndSubjects, buildQuestionPool, pickRandom } = require('../utils/dailyChallenge');

/**
 * Blitz — 60-second speed rounds drawn from the student's own quiz bank.
 *
 *   GET  /api/blitz/start    a shuffled pool of multiple-choice questions (WITH the answer —
 *                            a tap grades instantly on the phone, there is no Check step) + best/week stats
 *   POST /api/blitz/finish   { score, correct, wrong, best_combo } → saves the run, awards a little real XP
 *   GET  /api/blitz/leaderboard   this week's best run per student, with the caller's neighbours
 *
 * Because the answer key ships with the pool, a run is only plausibility-checked (see MAX_PER_SEC),
 * and real XP is small and capped per day; the leaderboard is for fun, not rewards.
 */

const POOL_SIZE = 60;
const START_SECONDS = 60;
const MAX_SECONDS = 90;
const BONUS_SECONDS = 3;
const BASE_POINTS = 10;
const XP_CAP_PER_RUN = 50;
const XP_RUNS_PER_DAY = 3;
const MAX_ANSWERS_PER_SEC = 1.5; // a human can't answer faster than this for 60s+

// Monday 00:00 of the current week (UTC is close enough for a leaderboard).
function weekStart() {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Same combo ladder as the client: x1.5 at 3, x2 at 5, x3 at 10 in a row.
const multFor = (combo) => (combo >= 10 ? 3 : combo >= 5 ? 2 : combo >= 3 ? 1.5 : 1);

async function bestFor(studentId, since) {
  let q = supabase.from('blitz_runs').select('score').eq('student_id', studentId).order('score', { ascending: false }).limit(1);
  if (since) q = q.gte('created_at', since);
  const { data } = await q;
  return data?.[0]?.score || 0;
}

async function weeklyBoard(studentId) {
  const { data: runs } = await supabase
    .from('blitz_runs').select('student_id, score').gte('created_at', weekStart()).order('score', { ascending: false }).limit(2000);
  const bestBy = new Map();
  for (const r of runs || []) if (!bestBy.has(r.student_id) || r.score > bestBy.get(r.student_id)) bestBy.set(r.student_id, r.score);
  const ids = [...bestBy.keys()];
  if (!ids.length) return { rows: [], me: null };
  let { data: users, error: uErr } = await supabase.from('users').select('id, name, is_test').in('id', ids);
  if (uErr) ({ data: users } = await supabase.from('users').select('id, name').in('id', ids)); // is_test migration not run yet
  const info = Object.fromEntries((users || []).map(u => [u.id, u]));
  const rows = ids
    .filter(id => id === studentId || !info[id]?.is_test)
    .map(id => ({ id, name: info[id]?.name || 'Student', score: bestBy.get(id) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const meIdx = rows.findIndex(r => r.id === studentId);
  return { rows, meIdx };
}

// The caller plus the rows around them (3 rows, like the result card).
function slice(rows, meIdx) {
  if (!rows.length) return [];
  const idx = meIdx >= 0 ? meIdx : 0;
  const from = Math.max(0, Math.min(idx - 1, rows.length - 3));
  return rows.slice(from, from + 3).map(r => ({ rank: r.rank, name: r.name, score: r.score, is_me: r.rank === (rows[meIdx]?.rank) }));
}

router.get('/start', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const { difficulty, subjects } = await computeDifficultyAndSubjects(studentId);
    let pool = await buildQuestionPool(studentId, subjects, difficulty);
    pool = pool.filter(q => q.question_type === 'QCM' && Array.isArray(q.options) && q.options.length >= 2);
    const picked = pickRandom(pool, Math.min(POOL_SIZE, pool.length));
    const topic = picked[0]?.category || null;
    res.json({
      success: true,
      data: {
        questions: picked.map(q => ({
          id: q.id,
          text: q.question,
          options: q.options,
          correct_answer: q.correct_answer,
          explanation: q.explanation || null,
          source_label: q.sourceLabel || null,
        })),
        rules: { start_seconds: START_SECONDS, max_seconds: MAX_SECONDS, bonus_seconds: BONUS_SECONDS, base_points: BASE_POINTS },
        topic,
        best: await bestFor(studentId),
        week_best: await bestFor(studentId, weekStart()),
      },
    });
  } catch (e) {
    console.error('blitz start failed:', e);
    res.status(500).json({ success: false, error: 'Failed to start Blitz' });
  }
});

router.post('/finish', authenticateToken, isStudent, async (req, res) => {
  try {
    const studentId = req.user.userId;
    const n = (v) => Math.max(0, Math.min(10000, Math.floor(Number(v) || 0)));
    const correct = n(req.body.correct);
    const wrong = n(req.body.wrong);
    const bestCombo = Math.min(n(req.body.best_combo), correct);
    // Recompute the ceiling from what was reported: every right answer is worth at most BASE x3.
    const ceiling = correct * BASE_POINTS * multFor(bestCombo || 0) * 1.0;
    let score = Math.min(n(req.body.score), Math.ceil(ceiling));
    // Time is the other limit: 60s + 3s per right answer (capped at 90s total, so ≈ 60 + 3*correct at most).
    const maxSeconds = START_SECONDS + correct * BONUS_SECONDS;
    if ((correct + wrong) > maxSeconds * MAX_ANSWERS_PER_SEC) {
      return res.status(400).json({ success: false, error: 'Run rejected' });
    }

    const prevBest = await bestFor(studentId);
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const { count: runsToday } = await supabase
      .from('blitz_runs').select('id', { count: 'exact', head: true }).eq('student_id', studentId).gte('created_at', since.toISOString());
    const xp = (runsToday || 0) < XP_RUNS_PER_DAY ? Math.min(score, XP_CAP_PER_RUN) : 0;

    const { error } = await supabase.from('blitz_runs').insert({
      id: uuidv4(), student_id: studentId, score, correct, wrong, best_combo: bestCombo, xp_awarded: xp,
    });
    if (error) throw error;
    if (xp > 0) await awardXp(studentId, xp, 'blitz');
    await recordActivity(studentId).catch(() => {});

    const { rows, meIdx } = await weeklyBoard(studentId);
    res.json({
      success: true,
      data: {
        score, prev_best: prevBest, is_record: score > prevBest, xp_awarded: xp,
        week_rank: meIdx >= 0 ? rows[meIdx].rank : null,
        board: slice(rows, meIdx),
      },
    });
  } catch (e) {
    console.error('blitz finish failed:', e);
    res.status(500).json({ success: false, error: 'Failed to save Blitz run' });
  }
});

router.get('/leaderboard', authenticateToken, isStudent, async (req, res) => {
  try {
    const { rows, meIdx } = await weeklyBoard(req.user.userId);
    res.json({ success: true, data: { board: slice(rows, meIdx), top: rows.slice(0, 10) } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

module.exports = router;
