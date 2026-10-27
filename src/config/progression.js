// Open progression: when on (the default), a learner can start any chapter or
// step without finishing the ones before it — they can skip ahead and prove
// mastery with the practice quizzes instead. Set OPEN_PROGRESSION=false to
// restore the old strictly-sequential unlock.
const OPEN_PROGRESSION = String(process.env.OPEN_PROGRESSION ?? 'true').toLowerCase() !== 'false';

module.exports = { OPEN_PROGRESSION };
