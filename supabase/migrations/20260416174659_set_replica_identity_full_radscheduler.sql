-- Set REPLICA IDENTITY FULL so Supabase Realtime sends the full row (including data column)
-- on UPDATE events. Without this, payload.new is empty for large JSONB columns.
ALTER TABLE radscheduler REPLICA IDENTITY FULL;;
