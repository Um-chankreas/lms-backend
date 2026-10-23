# Notification tests

Run with plain Node (no database, no network): they use an in-memory stand-in for Supabase.

    node scripts/notification-tests/rules.test.js   # cap, quiet hours, priority, rotation, back-off, outcomes
    node scripts/notification-tests/jobs.test.js    # champion, due soon, class messages, friend events, milestones

Each prints `ok` / `FAIL` per check and sets a non-zero exit code on failure.
