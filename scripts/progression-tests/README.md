# Progression tests

Plain Node, no database or network (in-memory Supabase stand-in).

    node scripts/progression-tests/progression.test.js   # or: npm test (also runs the notification tests)

Covers: open progression on/off (`OPEN_PROGRESSION`) for the course and chapter paths, passing a unit quiz to skip its reading (`skipped: true`), and chapter auto-complete with skipped units (non-History and History).
