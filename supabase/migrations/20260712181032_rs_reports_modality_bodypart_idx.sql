-- Supports the autotrigger's like-for-like eligible-prior query
-- (WHERE practice_id=? AND modality=? AND body_part=? AND signed_at > cutoff)
-- so it index-scans same-type reports instead of scanning the whole practice
-- and feeding a large set into ORDER BY random(). Bounds the random-sort set too.
create index if not exists rs_reports_practice_modality_bp
  on public.rs_reports (practice_id, modality, body_part, signed_at desc);;
