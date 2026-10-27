# Client feedback update: open access, incentives, Khmer stories

## Feedback received
1. Learners cannot skip ahead. Chapter 2 stays locked until Chapter 1 is done. They want to skip topics, like Duolingo's "test out", by answering a few hard questions instead of the whole practice set.
2. Make all problems available instead of unlocking chapter by chapter.
3. Keep learners motivated without forced order: EXP, gold, streaks, badges.
4. Provide Khmer resources: famous stories (year, author, info) so learners can pick which part of a story to use as an example in different essay topics.

## Status

| # | Item | Status |
|---|------|--------|
| 1 | Open access (no sequential lock) | **Done in backend** (this change) |
| 2 | Skip a topic by passing its quiz | **Done in backend**; hard-question-only quiz and button still proposed |
| 3 | EXP, streak, badges | **Already exist**; gold is new (proposed) |
| 4 | Khmer stories library | Proposed (needs content from client) |

## 1. Open access (implemented)
Flag: `OPEN_PROGRESSION` (default `true`; set `false` to restore the old behaviour). Config in `src/config/progression.js`, documented in `.env.example`.

With the flag on:
- `GET /api/courses/:id/path`: every lesson is reachable, not only the one after the last completed lesson.
- `GET /api/lessons/:id/path`: every step in a chapter (unit, unit quiz, chapter quiz) is reachable, and the previous-lesson check is skipped.
- Still enforced: course access/subscription (`hasCourseAccess`, `is_free`) and the guest wall (guests only get the free preview steps).
- Chapter auto-completion (`utils/progress.js`) is order-independent, so XP and chests still work when steps are done out of order.
- Chest claims still require the lesson to be completed.
- The "current" marker is now the first unfinished step; the rest show as `available` instead of `locked`.

Client apps (Expo app in `RS-tutoring-`, web in `romduol-web`) already render `locked` / `available` from the API status, so they need no change to unlock. The lock-icon UI only appears for paid/guest locks now.

Files changed: `src/routes/courses.routes.js`, `src/routes/lessons.routes.js`, `src/config/progression.js`, `.env.example`.

## 2. Test-out (implemented, decision: skipped topics count)
Decision: a skipped topic counts toward chapter completion and badges, with reduced XP.

How it works, for every subject (it was History-only before):
- A learner can open any unit's practice quiz directly (open access) and pass it.
- Passing the quiz marks the unit done, and the path node shows `skipped: true`. Fail and nothing changes; the learner reads and practises as normal.
- Chapter auto-complete (`utils/progress.js`) treats a passed unit quiz as the unit done, so the chapter, its chest and lesson XP still complete.
- Badges and levels are driven by quiz passes, lesson completions and XP, so skipped topics count automatically.
- Reduced XP: a skipped unit never earns the +5 `UNIT_COMPLETE` XP, only the quiz-pass XP (10-50). Reading then passing earns both.

Not built yet: a dedicated "Skip this topic" button serving only 3-5 of the hardest questions. Today the skip is the topic's normal practice quiz. This is a client-app UI plus question-selection change.

Files: `src/utils/progress.js`, `src/routes/lessons.routes.js`.

## 3. Incentives
Already in the backend: XP (`utils/xp.js`, levels, quiz XP scaling), daily streaks (`utils/streak.js`), achievements/badges (`utils/achievements.js`), path chests, daily challenge bonuses, leaderboard.
Missing: **gold**. Proposal:
- `user_stats.gold` (int) plus `gold_transactions` (student_id, amount, reason, created_at).
- Earn gold from quiz passes, chest claims, streak milestones, and test-out passes.
- Add badges for: first topic skipped via test-out, 7/14/30-day streaks, chapter mastered, all topics opened.
- Decide what gold buys (hints, streak freeze, cosmetics) before building.

## 4. Khmer stories library (proposal)
Table `khmer_stories`: id, title_km, title_en, author, year, summary_km, summary_en, themes[], created_at.
Table `khmer_story_excerpts`: id, story_id, label (e.g. "Beginning", "Climax"), excerpt_km, usable_for_topics[] (e.g. family, honesty, nature).
- Admin CRUD in `romduol-web`; read endpoint `GET /api/stories?topic=` for learners.
- Essay topic pages suggest which story and which part fits.
- **Needs from client:** the list of stories with verified author and year.

## Deployment notes
- No DB migration for this change.
- Rollback: set `OPEN_PROGRESSION=false` and restart.
- Verify: a new student's `GET /api/courses/:id/path` returns lessons 2+ as `available`, not `locked`.
