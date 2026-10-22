-- A student can give a reserved seat back. The cancel is its own ledger row
-- (kind 'class_cancel', delta = +1 when the seat had cost a pass) so that
-- "reserved today" can be told from the last reserve/cancel event.

alter table public.bacii_pass_events
  drop constraint if exists bacii_pass_events_kind_check;

alter table public.bacii_pass_events
  add constraint bacii_pass_events_kind_check
  check (kind in ('class_use','class_cancel','practice','recheck','follow'));


