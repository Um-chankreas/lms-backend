const supabase = require('../config/supabase');

/**
 * Database side of ending a live class: mark it completed, mark everyone as
 * left, clear hand raises. Shared by the teacher's "End class" button and the
 * auto-end for a teacher who closed the tab. Callers do the realtime emits
 * (emitClassStatus / emitStageChanged / emitParticipantsChanged) afterwards.
 * Returns the updated class row, or null if it was not active anymore.
 */
async function endLiveClassRecord(id) {
  const now = new Date();

  const { data: updatedClass, error } = await supabase
    .from('live_classes')
    .update({ status: 'completed', ended_at: now })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  await supabase
    .from('live_class_participants')
    .update({ left_at: now })
    .eq('live_class_id', id)
    .is('left_at', null);

  await supabase
    .from('live_class_hand_raises')
    .delete()
    .eq('live_class_id', id);

  return updatedClass;
}

module.exports = { endLiveClassRecord };
