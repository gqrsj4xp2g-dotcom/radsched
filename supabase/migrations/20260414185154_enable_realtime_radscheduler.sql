-- Add radscheduler table to the Supabase Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE radscheduler;

-- Confirm it's there
SELECT pubname, tablename FROM pg_publication_tables WHERE tablename = 'radscheduler';;
