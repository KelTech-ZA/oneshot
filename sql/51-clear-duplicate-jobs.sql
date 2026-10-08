-- OneShot 51 - clearing the jobs the repeated emails made
--
-- Run this ONCE, by hand, after 50. It is not a migration: it deletes rows.
--
-- WHAT HAPPENED
--
-- The same email reached intake several times - byte-identical body, same
-- sender, same subject - and every arrival built another full set of jobs.
-- One crate ended up with eleven. sql/50 and the intake change stop it
-- happening again; this clears what it already made.
--
-- WHAT IS DELETED, AND WHAT IS NOT
--
-- Only jobs that NOBODY HAS TOUCHED. A job is left alone if it has:
--   any custody event          somebody logged work against it
--   any photo                  crew shot it
--   any sign-off               somebody signed for it
--   an invoice                 it has been billed
--   an accepted_by or crew     it was taken on
--   any status past pending    it has moved
--
-- Deliberately NOT counted as somebody touching it: job_charges and
-- job_documents. Both are written by the PARSER - the quote in the mail
-- becomes charges, the attachment becomes a document - so counting them
-- would protect every duplicate and delete nothing at all. That was the first
-- version of this file and it cleared precisely zero rows.
--
-- And one job of each TYPE always survives per email, whether anything has
-- touched it or not, so a repeated mail still leaves the work it asked for.
-- Where several copies survive the filter, the one with work on it wins, and
-- the earliest wins the tie.
--
-- Deleting a job needs its line items gone first: line_items, custody_events,
-- job_documents and item_photos are all NO ACTION, so Postgres refuses to
-- delete a job that still has any. That refusal is a second safety net under
-- the filter above - if the filter were ever wrong about a job carrying work,
-- the delete would fail rather than quietly destroy it.

-- ---------------------------------------------------------------------------
-- STEP 1 - look first. Run this on its own and read it.
-- ---------------------------------------------------------------------------

with fam as (
  select m.id as msg, m.tenant_id, md5(m.body) as h
    from public.messages m
   where m.body is not null and length(m.body) > 50
),
dupfam as (
  select tenant_id, h from fam group by tenant_id, h having count(*) > 1
),
cand as (
  select j.id, j.ref, j.type, j.status, j.created_at, j.client_ref,
         j.accepted_by, j.crew, f.tenant_id, f.h,
         exists (select 1 from public.custody_events e where e.job_id = j.id) as ev,
         exists (select 1 from public.item_photos   p where p.job_id = j.id) as ph,
         exists (select 1 from public.stop_signoffs s where s.job_id = j.id) as so,
         exists (select 1 from public.invoices      i where i.job_id = j.id) as inv
    from public.jobs j
    join fam    f on f.msg = j.source_message_id
    join dupfam d on d.tenant_id = f.tenant_id and d.h = f.h
),
scored as (
  select *,
         (ev or ph or so or inv
          or accepted_by is not null
          or coalesce(array_length(crew, 1), 0) > 0
          or status <> 'pending_confirmation') as human
    from cand
),
ranked as (
  select *, row_number() over (
    partition by tenant_id, h, type
    order by human desc, created_at asc) as rn
    from scored
)
select r.ref                as will_delete,
       r.type, r.status,
       r.client_ref,
       to_char(r.created_at, 'YYYY-MM-DD HH24:MI') as made,
       (select k.ref    from ranked k
         where k.tenant_id = r.tenant_id and k.h = r.h and k.type = r.type and k.rn = 1) as keeping,
       (select k.status from ranked k
         where k.tenant_id = r.tenant_id and k.h = r.h and k.type = r.type and k.rn = 1) as keep_status
  from ranked r
 where r.rn > 1 and not r.human
 order by r.client_ref, r.type, r.created_at;

-- ---------------------------------------------------------------------------
-- STEP 2 - if that list is right, run everything below in one go.
-- ---------------------------------------------------------------------------

begin;

create temp table _del_jobs on commit drop as
with fam as (
  select m.id as msg, m.tenant_id, md5(m.body) as h
    from public.messages m
   where m.body is not null and length(m.body) > 50
),
dupfam as (
  select tenant_id, h from fam group by tenant_id, h having count(*) > 1
),
cand as (
  select j.id, j.ref, j.type, j.status, j.created_at,
         j.accepted_by, j.crew, f.tenant_id, f.h,
         exists (select 1 from public.custody_events e where e.job_id = j.id) as ev,
         exists (select 1 from public.item_photos   p where p.job_id = j.id) as ph,
         exists (select 1 from public.stop_signoffs s where s.job_id = j.id) as so,
         exists (select 1 from public.invoices      i where i.job_id = j.id) as inv
    from public.jobs j
    join fam    f on f.msg = j.source_message_id
    join dupfam d on d.tenant_id = f.tenant_id and d.h = f.h
),
scored as (
  select *,
         (ev or ph or so or inv
          or accepted_by is not null
          or coalesce(array_length(crew, 1), 0) > 0
          or status <> 'pending_confirmation') as human
    from cand
),
ranked as (
  select *, row_number() over (
    partition by tenant_id, h, type
    order by human desc, created_at asc) as rn
    from scored
)
select id, ref from ranked where rn > 1 and not human;

-- Belt and braces: refuse the whole thing if anything in the list has work on
-- it after all. Nothing is deleted, the transaction rolls back, and the
-- message says which job to look at.
do $$
declare bad text;
begin
  select string_agg(d.ref, ', ') into bad
    from _del_jobs d
   where exists (select 1 from public.custody_events e where e.job_id = d.id)
      or exists (select 1 from public.item_photos   p where p.job_id = d.id)
      or exists (select 1 from public.stop_signoffs s where s.job_id = d.id);
  -- job_documents is deliberately NOT in that list. The parser writes one for
  -- every job a mail produced - the attachment is linked, not copied - so
  -- refusing on it would refuse every duplicate there is. An earlier draft of
  -- this file had it here and cleared nothing at all.
  if bad is not null then
    raise exception 'Refusing to delete - these carry work: %', bad;
  end if;
end $$;

-- line_items and job_documents are both NO ACTION, so the job cannot go while
-- either still points at it. The document ROW is a link; the file it points to
-- is shared with the job that is being kept and is not touched.
delete from public.job_documents where job_id in (select id from _del_jobs);
delete from public.line_items    where job_id in (select id from _del_jobs);
delete from public.jobs          where id     in (select id from _del_jobs);

select count(*) as deleted, string_agg(ref, ', ' order by ref) as refs from _del_jobs;

commit;

-- ---------------------------------------------------------------------------
-- STEP 3 - confirm it is clear, and stays clear
-- ---------------------------------------------------------------------------
--   select m.body_hash, count(distinct m.id) as copies,
--          sum((select count(*) from public.jobs j where j.source_message_id = m.id)) as jobs
--     from public.messages m
--    where m.body is not null
--    group by m.tenant_id, m.body_hash
--   having count(distinct m.id) > 1
--    order by 3 desc;
--
-- After 50 and the intake change are deployed, `copies` may still climb - the
-- same mail can still arrive - but `jobs` must not. A repeat is recorded with
-- kind = 'duplicate' and builds nothing:
--
--   select kind, count(*) from public.messages
--    where created_at > now() - interval '7 days' group by kind;
