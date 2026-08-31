-- Flow change: students no longer wait for teacher approval to speak.
-- Hand-raise status values are now:
--   raised    -- hand up, notifying the teacher, not publishing
--   speaking  -- student has opened their voice (co-host, publisher token)
-- (previously: pending / approved / denied)

update public.live_class_hand_raises set status = 'speaking' where status = 'approved';
update public.live_class_hand_raises set status = 'raised'   where status = 'pending';
delete from public.live_class_hand_raises where status = 'denied';
