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
| 2 | Skip a topic by passing its quiz | **Done in backend**, incl. hard-questions-only attempt (`?mode=test_out`); the "Skip this topic" button is built in the Expo app |
| 3 | EXP, streak, badges | **Done in backend**: gold added (earn-only), "Test-Out Pro" badge; migration 057 must be run |
| 4 | Khmer stories library | **Done**: API, mobile screen, web admin page; migration 058 must be run; content from the client still needed |

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

## 3. Incentives (implemented: gold + test-out badge)
Already existed: XP, daily streaks, achievements/badges, path chests, daily challenge bonuses, leaderboard.

New (migration `sql/057_gold.sql`):
- `users.gold` and a `gold_transactions` ledger. `utils/gold.js` (`awardGold`, `getGold`); `awardXp` grants gold alongside the XP event, per `GOLD_BY_REASON` (quiz pass 5, lesson 5, chest 15, daily challenge 5, 7/14/30-day Daily Challenge streak bonus 20, on-time assignment 10, live class 5, ...).
- Test-out bonus: +10 gold the first time a unit's quiz is passed without having read the unit.
- Badge `first_skip` ("Test-Out Pro") for the first topic skipped that way. 7/14/30-day streak badges already existed.
- Quiz submit response now includes `skipped_unit` and `gold`; `GET /api/profile` summary includes `gold`.
- Gold is **earn-only**. What it buys (hints, streak freeze, cosmetics) is still to be decided. Not built: "chapter mastered" and "all topics opened" badges (need a definition from the client).

## 2b. Skip tests, Duolingo-style (implemented)
Migration `sql/059_skip_tests.sql`, routes in `src/routes/skipTests.routes.js` (`/api/skip-tests`).
- **Skip the next two units:** after a student passes a unit's practice with 80%+, the result screen offers "Jump ahead!". The test is **3 hard questions**, passed with **at most 1 mistake**. Passing marks the next two unread units done.
- **Skip a chapter:** a "Skip this chapter" button on the CLASS tab. The test is **10 hard questions** drawn from the chapter's units, passed with **70% correct** (at most 3 mistakes). The button only appears when the chapter has at least 10 hard questions in total. Passing marks the remaining units and the chapter's end-of-lesson quiz done, so the chapter completes (chapter XP and chest still work).
- **Hard questions** are taken from the units' own quiz banks, filtered to `difficulty = 'Hard'`. An offer only appears when there are enough Hard questions (3 or 5); a teacher marking more questions as Hard makes it appear.
- **Grading:** the server stores which questions it served (`skip_test_attempts`) and grades exactly those; an unanswered question is a mistake, and an attempt can be submitted once.
- **Rewards:** skipped units pay no unit-read XP; bonus gold (10 for units, 20 for a chapter) and the "Test-Out Pro" badge. Failing changes nothing; the student can retry (new random questions).
- Endpoints: `GET /offer?quiz_id=|unit_id=|lesson_id=`, `POST /start`, `POST /:id/submit`. Tuning constants (`UNITS_TEST`, `CHAPTER_TEST`) are at the top of the route file; the 80% threshold is in the app (`SKIP_OFFER_MIN_SCORE`).

## 4. Khmer stories library (API implemented)
Migration `sql/058_khmer_stories.sql`: `khmer_stories` (title_km/en, author, year, summary_km/en, themes[]) and `khmer_story_excerpts` (story_id, label, excerpt_km, usable_for_topics[], order_number).
Routes in `src/routes/stories.routes.js`, mounted at `/api/stories`:
- `GET /api/stories?topic=&q=` and `GET /api/stories/:id` (with excerpts): any signed-in user.
- `POST/PUT/DELETE /api/stories[/:id]` and `/api/stories/:id/excerpts[/:excerptId]`: admin / super_admin only.
- **Still needed:** an admin screen in `romduol-web`, essay-topic pages in the apps, and the story content with verified author and year from the client.

## Client apps (implemented)
- **Expo app (`RS-tutoring-`)**: after a practice pass with 80%+ the result screen offers "Jump ahead!" (START TEST / NOT NOW); a "Skip this chapter" button sits under the chapter bar on the CLASS tab; both open a new `skip-test` screen (intro, one question at a time, result with review). The quiz result shows a "Topic skipped" banner and the gold balance; the profile stats card shows gold; a new **Khmer stories** screen (More tab > Learning) lists stories, filters by topic, and shows the parts of a story with the essay topics each part fits.
- **Web portal (`romduol-web`)**: new admin page **Khmer Stories** (`/stories`, admin and super admin) to add, edit and delete stories and their parts.
- Gold is shown but cannot be spent yet.

## Deployment notes
- Run `sql/057_gold.sql`, `sql/058_khmer_stories.sql` and `sql/059_skip_tests.sql` in the Supabase SQL editor. Gold and stories do nothing until they are run (the backend does not crash without them).
- Open access itself needed no migration.
- Rollback: set `OPEN_PROGRESSION=false` and restart.
- Verify: a new student's `GET /api/courses/:id/path` returns lessons 2+ as `available`, not `locked`.
