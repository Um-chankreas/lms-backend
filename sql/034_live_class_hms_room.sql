-- Migrating live classes from Agora to 100ms. A live class now needs a
-- 100ms room (created via their REST API) in addition to the existing
-- `channel_name` label — the room id is what token/role-change calls need.
-- Nullable: classes created before this migration never had one and are
-- already completed, so nothing needs to backfill them.
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.live_classes
  add column if not exists hms_room_id text;
