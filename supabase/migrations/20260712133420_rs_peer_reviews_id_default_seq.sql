create sequence if not exists public.rs_peer_reviews_id_seq owned by public.rs_peer_reviews.id;
alter table public.rs_peer_reviews alter column id set default nextval('public.rs_peer_reviews_id_seq');
-- Prevent duplicate completed reviews of the same report by the same reviewer.
create unique index if not exists rs_peer_reviews_uniq_reviewer_report
  on public.rs_peer_reviews (practice_id, report_uid, reviewer_uid)
  where report_uid is not null;;
