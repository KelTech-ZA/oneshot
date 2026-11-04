-- OneShot 58 - waking the billing run
--
-- 57 decided whose pack is due. This is what asks.
--
-- WHY HOURLY AND NOT DAILY
--
-- A daily job has to fire at some particular minute, and if the database is
-- busy or the function is cold at that minute, that day is simply missed.
-- Billing dates are a day apart, not an hour, so an hourly poll costs almost
-- nothing and gives twenty-four chances to get each day right.
--
-- It is cheap because due_billing_runs answers with nothing for all but a
-- handful of hours in the month: the day has to match AND no run may exist
-- for the period. Once a pack has gone, that customer disappears from the
-- answer until next month.
--
-- WHY A SECRET RATHER THAN A JWT
--
-- Same shape as the reminders job. The function is deployed with
-- --no-verify-jwt so that cron can reach it, which means the function has to
-- do its own checking: a request carrying this secret is the scheduler, and
-- anything else must present an ops session. Without that, the URL alone
-- would be enough to make somebody's invoices go out.
--
-- BEFORE RUNNING THIS
--
--   1. Deploy the function:  supabase functions deploy billing-run --no-verify-jwt
--   2. Put a secret in app_secrets (below). Generate your own; do not use the
--      example. It never leaves the database and the function reads it there.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- What this expects to find
-- ---------------------------------------------------------------------------
-- Checked up front so that a mismatch says what is wrong rather than failing
-- three statements later with "column value does not exist". Everything named
-- here was put in place by an earlier migration; nothing below creates it.

do $$
declare
  missing text[] := '{}';
begin
  if to_regclass('public.app_secrets') is null then
    missing := array_append(missing, 'table public.app_secrets');
  else
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'app_secrets'
                      and column_name = 'key') then
      missing := array_append(missing, 'app_secrets.key');
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'app_secrets'
                      and column_name = 'value') then
      missing := array_append(missing, 'app_secrets.value');
    end if;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    missing := array_append(missing, 'extension pg_net');
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    missing := array_append(missing, 'extension pg_cron');
  end if;
  if to_regprocedure('public.due_billing_runs(date)') is null then
    missing := array_append(missing, 'function due_billing_runs - run sql/57 first');
  end if;

  if array_length(missing, 1) is not null then
    raise exception
      'sql/58 cannot run. Not found: %. The secret is stored the same way the push notification secret is, so if app_secrets uses different column names here, change the two statements below to match and rerun.',
      array_to_string(missing, ', ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The shared secret
-- ---------------------------------------------------------------------------
-- app_secrets already holds push_hook_secret and is readable by nobody but
-- the service role. gen_random_uuid() twice over is more than enough entropy
-- for a value that is never transmitted anywhere but between this database
-- and our own function.

insert into public.app_secrets (key, value)
select 'billing_hook_secret',
       replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
where not exists (select 1 from public.app_secrets where key = 'billing_hook_secret');

-- ---------------------------------------------------------------------------
-- The call
-- ---------------------------------------------------------------------------
-- Modelled on fire_due_reminders: read the secret here, post to the function,
-- and never let a failure become a database error. pg_net is fire-and-forget
-- by design - the response lands in net._http_response, and the run's own
-- status in billing_runs is the record that matters.

create or replace function public.fire_billing_runs()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_url    text;
begin
  select value into v_secret from public.app_secrets where key = 'billing_hook_secret';
  if v_secret is null then
    raise warning 'fire_billing_runs: no billing_hook_secret, nothing sent';
    return;
  end if;

  -- The project's own functions host. Kept here rather than hard-coded in a
  -- dozen places; if the project ref ever changes this is the one edit.
  v_url := 'https://ntcvwosypcnwedxefwcr.supabase.co/functions/v1/billing-run';

  -- Nothing is due for all but a few hours a month, and the function answers
  -- {"ran":0} in that case, so this is a cheap thing to ask often.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-billing-secret', v_secret),
    body    := '{}'::jsonb
  );
exception
  -- A scheduler that throws stops being a scheduler. Whatever went wrong
  -- here, the customers still have billing days and the next hour will ask
  -- again.
  when others then
    raise warning 'fire_billing_runs: %', sqlerrm;
end;
$$;

revoke all on function public.fire_billing_runs() from public;

commit;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
-- Outside the transaction: cron.schedule writes to its own tables and a
-- rollback here would leave the job half-registered.
--
-- At seven minutes past, rather than on the hour, so it is not competing with
-- everything else in the world that runs at :00. The reminders job already
-- runs every minute; this one has a day's worth of slack.

select cron.unschedule('oneshot-billing')
 where exists (select 1 from cron.job where jobname = 'oneshot-billing');

select cron.schedule('oneshot-billing', '7 * * * *', 'select public.fire_billing_runs()');

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select jobname, schedule, active from cron.job;
--
--   select client_id, period_to, status, invoice_count, outstanding, sent_to, error
--     from public.billing_runs order by created_at desc limit 10;
--
--   -- what the scheduler got back
--   select status_code, left(content, 200) from net._http_response
--    order by created desc limit 5;
--
-- To try one customer immediately, without waiting for their day, POST to the
-- function with an ops session and {"client_id": "...", "on": "YYYY-MM-DD"}.
