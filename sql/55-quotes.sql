-- OneShot 55 - quotes, and knowing what to charge
--
-- WHY A QUOTE LOOKS LIKE AN INVOICE
--
-- It very nearly is one. An invoice already carries its lines as jsonb, a
-- frozen copy of the issuer's letterhead, a per-workspace number series, and
-- the bill-to details as they stood on the day. A quote is that same document
-- with three differences: a different number series, an expiry rather than a
-- due date, and accepted/declined rather than paid/void.
--
-- So quotes are built to the same shape deliberately, and the payoff is at the
-- other end: accepting a quote writes its lines back onto the job as
-- job_charges, at which point issue_invoice - which has worked for months -
-- produces an invoice that matches the quote by construction rather than by
-- anybody checking.
--
-- WHY A QUOTE HAS NO JOB
--
-- Most quotes are for work that does not happen. Giving each one a job would
-- turn a job list of real movements into a list of maybes, and the job list is
-- the thing ops reads every morning. So job_id is null until somebody accepts,
-- and the parsed job the quote came from is kept in job_draft so that accepting
-- has something to make the job FROM.
--
-- Creating the job is not done here. There is no create_job in the database -
-- jobs are inserted by the intake function, with its own validation and
-- reference allocation - and a second way to make one would be a second set of
-- rules to keep in step. accept_quote takes the job it is being accepted onto.
--
-- WHY THE NUMBER IS ALLOCATED AT ONCE
--
-- Unlike an invoice. An invoice number is a tax document's identity and a gap
-- in the series is a question from an auditor, so issue_invoice allocates one
-- only when the invoice is really issued. A quote number is just a handle -
-- "about quote SEC9Q0007" - and a quote with no number cannot be talked about.
-- Gaps are free here, so the number comes with the quote.
--
-- WHAT THIS CANNOT DO
--
-- Price things on its own. The rate card has seventeen entries and one price;
-- the 43 charge lines in history are nearly all unique free text with the
-- specifics baked into the description. price_hint below says what it knows
-- and where it got it, and says nothing when it knows nothing. A blank price
-- is the honest answer and the UI shows it as blank rather than as zero.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- The quote's own number series
-- ---------------------------------------------------------------------------
-- Alongside invoice_prefix rather than derived from it, so a workspace that
-- numbers its quotes differently can. Null means "the invoice prefix with a Q",
-- which is what Section 9 would have chosen anyway.

alter table public.workspace_billing
  add column if not exists quote_prefix   text,
  add column if not exists quote_seq_pad  int,
  add column if not exists quote_valid_days int;

comment on column public.workspace_billing.quote_prefix is
  'Prefix for quote numbers. Null uses the invoice prefix with a Q after it.';
comment on column public.workspace_billing.quote_valid_days is
  'How long a quote stands before it reads as expired. Null means 30 days.';

-- ---------------------------------------------------------------------------
-- The document
-- ---------------------------------------------------------------------------

create table if not exists public.quotes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  number        text not null,
  seq           int  not null,

  -- Null until somebody accepts it. job_ref is the frozen copy, so a quote
  -- still reads correctly after a job is renamed or deleted.
  job_id        uuid references public.jobs(id) on delete set null,
  job_ref       text,
  -- The job as the parser proposed it, kept so that accepting has something to
  -- build from. Same shape as jobs.parsed_as.
  job_draft     jsonb,

  client_id          uuid references public.clients(id),
  bill_to_name       text,
  bill_to_address    text,
  bill_to_vat_number text,
  bill_to_reg_number text,
  billing_email      text,
  their_reference    text,

  currency       text,
  vat_applicable boolean not null default false,
  vat_rate       numeric,
  -- Scaled, unlike invoices, which stores bare numeric. Money with no declared
  -- scale comes back as "0" from one row and "1345.50" from the next, and a
  -- column that renders two different ways is a column every caller has to
  -- remember to format. These always have two decimals because they are rands.
  subtotal       numeric(14,2) not null default 0,
  vat            numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,

  -- [{description, unit, quantity, unit_price, line_total}], the same shape
  -- invoices.lines uses, so one renderer draws both.
  lines   jsonb not null default '[]'::jsonb,
  -- The letterhead as it stood the day this went out.
  issuer  jsonb,

  quote_date  date not null default current_date,
  valid_until date,

  -- draft    - made, not sent
  -- sent     - with the client
  -- accepted - turned into work; converted_job_id says where
  -- declined - they said no
  -- Expiry is NOT a status. A quote does not change because a day passed, and
  -- a stored 'expired' would need somebody to come along and store it.
  -- quote_ledger works it out from valid_until instead.
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined')),

  sent_at        timestamptz,
  accepted_at    timestamptz,
  accepted_by    uuid,
  declined_at    timestamptz,
  decline_reason text,

  converted_job_id     uuid references public.jobs(id) on delete set null,
  converted_invoice_id uuid references public.invoices(id) on delete set null,

  notes      text,
  issued_by  uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists quotes_number on public.quotes (tenant_id, number);
create unique index if not exists quotes_seq    on public.quotes (tenant_id, seq);
create index if not exists quotes_job     on public.quotes (job_id) where job_id is not null;
create index if not exists quotes_client  on public.quotes (client_id) where client_id is not null;
create index if not exists quotes_open    on public.quotes (tenant_id, quote_date desc)
  where status in ('draft', 'sent');

alter table public.quotes enable row level security;

drop policy if exists quotes_read   on public.quotes;
drop policy if exists quotes_write  on public.quotes;
drop policy if exists quotes_update on public.quotes;
drop policy if exists quotes_delete on public.quotes;

-- Everyone in the workspace can see them - a colleague needs to know a price
-- has already been given before giving another one.
create policy quotes_read on public.quotes for select
  using (tenant_id = public.my_tenant());

-- Writing is ops, as the charges sheet is. Quoting is a commercial act.
create policy quotes_write on public.quotes for insert
  with check (tenant_id = public.my_tenant() and public.is_ops());
create policy quotes_update on public.quotes for update
  using (tenant_id = public.my_tenant() and public.is_ops())
  with check (tenant_id = public.my_tenant() and public.is_ops());

-- Only a draft may be deleted. Once it has been sent it is a thing somebody
-- outside the company has seen, and declining it is the way to close it.
create policy quotes_delete on public.quotes for delete
  using (tenant_id = public.my_tenant() and public.is_ops() and status = 'draft');

grant select, insert, update, delete on public.quotes to authenticated;

-- ---------------------------------------------------------------------------
-- What to charge, and how we know
-- ---------------------------------------------------------------------------
-- Three places a price can come from, in descending order of how much it
-- deserves to be believed, and every answer says which one it was. The caller
-- shows that: "last charged R2 217 on SEC-0142" is a number somebody can
-- agree or disagree with, where a bare 2217 is a number they have to check.
--
-- Matching on the KIND rather than the whole description, because the
-- descriptions in this workspace are "kind: specifics" - "crate build: 207 x
-- 37 x 146cm(h)", "airfreight: cpt-mxp @ 218vkg" - and the specifics are
-- exactly the part that never repeats. A leading task code ("A4 - airline
-- handling") is stripped for the same reason.

create or replace function public.charge_kind(p_description text)
returns text
language sql
immutable
as $$
  select nullif(btrim(split_part(
    regexp_replace(lower(coalesce(p_description, '')), '^[a-z][0-9]+\s*-\s*', ''),
    ':', 1)), '');
$$;

comment on function public.charge_kind(text) is
  'The reusable part of a charge description: "crate build: 207 x 37cm" becomes "crate build".';

-- Parameterised by workspace rather than reading my_tenant(), because the
-- intake function runs as the service role, where my_tenant() is null and
-- every lookup would come back empty. Left as security INVOKER so that an
-- authenticated caller passing somebody else's tenant still sees nothing -
-- RLS on job_charges and charge_types does that work - while the service
-- role, which has no RLS to stop it, is confined by the explicit filter.
create or replace function public.price_hint_in(
  p_tenant uuid, p_description text, p_unit text default null)
returns table (unit_price numeric, source text, seen text)
language sql
stable
security invoker
set search_path = public
as $$
  with kind as (select public.charge_kind(p_description) as k),
  -- 1. This workspace has charged for this exact thing before.
  exact as (
    select c.unit_price,
           'charged before' as source,
           'last charged on ' || coalesce(j.ref, 'an earlier job') as seen,
           1 as rank, c.created_at
      from public.job_charges c
      left join public.jobs j on j.id = c.job_id
     where c.tenant_id = p_tenant
       and c.unit_price > 0
       and lower(btrim(c.description)) = lower(btrim(coalesce(p_description, '')))
  ),
  -- 2. It has charged for this KIND of thing before. The price will be wrong -
  --    a different crate is a different crate - but it is the right order of
  --    magnitude and it tells the user what they usually charge.
  nearby as (
    select c.unit_price,
           'last ' || coalesce(k.k, 'similar') as source,
           'last ' || coalesce(k.k, 'similar line') || ' was '
             || to_char(c.unit_price, 'FM999G999G990D00')
             || coalesce(' on ' || j.ref, '') as seen,
           2 as rank, c.created_at
      from public.job_charges c
      cross join kind k
      left join public.jobs j on j.id = c.job_id
     where c.tenant_id = p_tenant
       and c.unit_price > 0
       and k.k is not null
       and public.charge_kind(c.description) = k.k
       and (p_unit is null or c.unit is null or c.unit = p_unit)
  ),
  -- 3. The rate card, where somebody has actually filled a rate in.
  card as (
    select t.default_rate as unit_price,
           'rate card' as source,
           'rate card: ' || t.label as seen,
           3 as rank, t.created_at
      from public.charge_types t, kind k
     where t.tenant_id = p_tenant
       and t.active
       and t.default_rate > 0
       and (lower(t.label) = k.k or lower(t.label) = lower(btrim(coalesce(p_description, ''))))
  )
  select unit_price, source, seen
    from (select * from exact union all select * from nearby union all select * from card) z
   order by rank, created_at desc
   limit 1;
$$;

comment on function public.price_hint_in(uuid, text, text) is
  'The best price a workspace knows for a line like this, and where it came from. No row at all when it knows nothing - a blank price is the honest answer.';

-- What the app calls: the same thing, about the caller's own workspace.
create or replace function public.price_hint(p_description text, p_unit text default null)
returns table (unit_price numeric, source text, seen text)
language sql
stable
security invoker
set search_path = public
as $$
  select * from public.price_hint_in(public.my_tenant(), p_description, p_unit);
$$;

revoke all on function public.price_hint(text, text) from public;
revoke all on function public.price_hint_in(uuid, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.price_hint(text, text) to authenticated';
    execute 'grant execute on function public.price_hint_in(uuid, text, text) to authenticated';
    execute 'grant execute on function public.charge_kind(text) to authenticated';
  end if;
end $$;

-- Priced in one call rather than one per line, because a quote has ten lines
-- and ten round trips from a browser on a phone is a visible pause.
create or replace function public.price_lines_in(p_tenant uuid, p_lines jsonb)
returns table (idx int, description text, unit text, quantity numeric,
               unit_price numeric, source text, seen text)
language sql
stable
security invoker
set search_path = public
as $$
  select (l.i - 1)::int,
         l.v->>'description',
         l.v->>'unit',
         round(nullif(l.v->>'quantity', '')::numeric, 2),
         -- A price the message itself stated always wins. Somebody wrote it
         -- down; that is not a guess this database gets to improve on.
         -- Rounded so that a price read out of a message and one read out of
         -- history come back looking the same.
         round(coalesce(nullif(l.v->>'unit_price', '')::numeric, h.unit_price), 2),
         case when nullif(l.v->>'unit_price', '') is not null then 'stated'
              else h.source end,
         case when nullif(l.v->>'unit_price', '') is not null then 'from the message'
              else h.seen end
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(v, i)
    left join lateral public.price_hint_in(p_tenant, l.v->>'description', l.v->>'unit') h on true;
$$;

create or replace function public.price_lines(p_lines jsonb)
returns table (idx int, description text, unit text, quantity numeric,
               unit_price numeric, source text, seen text)
language sql
stable
security invoker
set search_path = public
as $$
  select * from public.price_lines_in(public.my_tenant(), p_lines);
$$;

revoke all on function public.price_lines(jsonb) from public;
revoke all on function public.price_lines_in(uuid, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.price_lines(jsonb) to authenticated';
    execute 'grant execute on function public.price_lines_in(uuid, jsonb) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Making one
-- ---------------------------------------------------------------------------
-- Mirrors issue_invoice: freeze the letterhead and the bill-to, total the
-- lines, take the next number. Totalling here rather than in the browser
-- because a document whose own total disagrees with its own lines is the
-- worst bug this table could have, and the browser is the easier place to
-- introduce it.

create or replace function public.create_quote(
  p_lines     jsonb,
  p_client_id uuid default null,
  p_job_id    uuid default null,
  p_job_draft jsonb default null,
  p_their_ref text default null,
  p_notes     text default null
) returns public.quotes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant uuid := public.my_tenant();
  v_wb     public.workspace_billing%rowtype;
  v_cl     public.clients%rowtype;
  v_job    public.jobs%rowtype;
  v_seq    int;
  v_lines  jsonb;
  v_sub    numeric;
  v_vatp   boolean;
  v_vatr   numeric;
  v_q      public.quotes;
begin
  if not public.is_ops() then
    raise exception 'Only ops can quote.';
  end if;

  select * into v_wb from public.workspace_billing where tenant_id = v_tenant;
  if p_client_id is not null then
    select * into v_cl from public.clients where id = p_client_id and tenant_id = v_tenant;
  end if;
  if p_job_id is not null then
    select * into v_job from public.jobs where id = p_job_id and tenant_id = v_tenant;
    if not found then
      raise exception 'That job is not in this workspace.';
    end if;
  end if;

  -- Normalised rather than trusted: line_total is computed from quantity and
  -- price here, so a caller that sends an inconsistent one cannot store it.
  select coalesce(jsonb_agg(jsonb_build_object(
           'description', btrim(coalesce(l.v->>'description', '')),
           'unit',        nullif(btrim(coalesce(l.v->>'unit', '')), ''),
           'quantity',    round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric, 2),
           'unit_price',  round(coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),
           'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric
                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2)
         ) order by l.i), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(v, i)
   where btrim(coalesce(l.v->>'description', '')) <> '';

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;

  -- The job decides if it has an opinion, then the client - an export client
  -- is zero-rated whatever the workspace does - and only then the workspace,
  -- which charges VAT if it is registered for it.
  v_vatp := coalesce(v_job.vat_applicable, v_cl.vat_applicable,
                     nullif(btrim(coalesce(v_wb.vat_number, '')), '') is not null);
  v_vatr := coalesce(v_job.vat_rate, 15);

  -- One number series per workspace, taken under a lock so that two people
  -- quoting at the same moment cannot take the same one.
  perform pg_advisory_xact_lock(hashtext(v_tenant::text || ':quote'));
  select coalesce(max(seq), 0) + 1 into v_seq from public.quotes where tenant_id = v_tenant;

  insert into public.quotes (
    tenant_id, number, seq, job_id, job_ref, job_draft,
    client_id, bill_to_name, bill_to_address, bill_to_vat_number, bill_to_reg_number,
    billing_email, their_reference,
    currency, vat_applicable, vat_rate, subtotal, vat, total,
    lines, issuer, quote_date, valid_until, status, notes, issued_by
  ) values (
    v_tenant,
    coalesce(nullif(btrim(coalesce(v_wb.quote_prefix, '')), ''),
             coalesce(v_wb.invoice_prefix, '') || 'Q')
      || lpad(v_seq::text, coalesce(v_wb.quote_seq_pad, v_wb.invoice_seq_pad, 4), '0'),
    v_seq,
    p_job_id,
    v_job.ref,
    p_job_draft,
    coalesce(p_client_id, v_job.client_id, v_cl.id),
    coalesce(v_cl.legal_name, v_cl.name),
    v_cl.billing_address,
    v_cl.vat_number,
    v_cl.reg_number,
    v_cl.billing_email,
    p_their_ref,
    coalesce(v_job.currency, v_wb.default_currency, 'ZAR'),
    v_vatp,
    v_vatr,
    v_sub,
    case when v_vatp then round(v_sub * v_vatr / 100, 2) else 0 end,
    case when v_vatp then round(v_sub * (1 + v_vatr / 100), 2) else v_sub end,
    v_lines,
    to_jsonb(v_wb),
    current_date,
    current_date + coalesce(v_wb.quote_valid_days, 30),
    'draft',
    p_notes,
    auth.uid()
  ) returning * into v_q;

  return v_q;
end;
$$;

revoke all on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_quote(jsonb, uuid, uuid, jsonb, text, text) to authenticated';
  end if;
end $$;

-- Re-totalling after the user has edited the lines. The same normalisation as
-- above, in one place, because two of them would drift.
create or replace function public.retotal_quote(p_quote uuid, p_lines jsonb)
returns public.quotes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lines jsonb;
  v_sub   numeric;
  v_q     public.quotes;
begin
  select * into v_q from public.quotes where id = p_quote;
  if not found then raise exception 'No such quote.'; end if;
  if v_q.status in ('accepted', 'declined') then
    raise exception 'Quote % has been %; make a new one.', v_q.number, v_q.status;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'description', btrim(coalesce(l.v->>'description', '')),
           'unit',        nullif(btrim(coalesce(l.v->>'unit', '')), ''),
           'quantity',    round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric, 2),
           'unit_price',  round(coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2),
           'line_total',  round(coalesce(nullif(l.v->>'quantity', ''), '1')::numeric
                              * coalesce(nullif(l.v->>'unit_price', ''), '0')::numeric, 2)
         ) order by l.i), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as l(v, i)
   where btrim(coalesce(l.v->>'description', '')) <> '';

  select coalesce(sum((x->>'line_total')::numeric), 0) into v_sub
    from jsonb_array_elements(v_lines) x;

  update public.quotes
     set lines    = v_lines,
         subtotal = v_sub,
         vat      = case when vat_applicable then round(v_sub * vat_rate / 100, 2) else 0 end,
         total    = case when vat_applicable then round(v_sub * (1 + vat_rate / 100), 2) else v_sub end
   where id = p_quote
   returning * into v_q;

  return v_q;
end;
$$;

revoke all on function public.retotal_quote(uuid, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.retotal_quote(uuid, jsonb) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Saying yes
-- ---------------------------------------------------------------------------
-- The lines go onto the job as charges, which is the whole point: from here
-- on the quote is history and issue_invoice does the rest, so the invoice
-- cannot quietly differ from what was quoted.
--
-- The job is passed in rather than made here. See the note at the top.

create or replace function public.accept_quote(p_quote uuid, p_job_id uuid default null)
returns public.quotes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_q   public.quotes;
  v_job uuid;
  v_n   int;
begin
  if not public.is_ops() then
    raise exception 'Only ops can accept a quote.';
  end if;

  select * into v_q from public.quotes where id = p_quote for update;
  if not found then raise exception 'No such quote.'; end if;
  if v_q.status = 'accepted' then
    raise exception 'Quote % was already accepted.', v_q.number;
  end if;
  if v_q.status = 'declined' then
    raise exception 'Quote % was declined. Make a new one.', v_q.number;
  end if;

  v_job := coalesce(p_job_id, v_q.job_id);
  if v_job is null then
    raise exception 'Accepting quote % needs a job to put the work on.', v_q.number;
  end if;
  if not exists (select 1 from public.jobs where id = v_job and tenant_id = v_q.tenant_id) then
    raise exception 'That job is not in this workspace.';
  end if;

  -- Charges already on the job are left alone and the quote's lines are added
  -- after them. Quietly replacing somebody's hand-entered costs with a
  -- document they are only just accepting would be the wrong way round.
  select coalesce(max(sort), 0) into v_n from public.job_charges where job_id = v_job;

  insert into public.job_charges
    (tenant_id, job_id, description, unit, quantity, unit_price, sort, created_by)
  select v_q.tenant_id, v_job,
         x->>'description',
         nullif(x->>'unit', ''),
         (x->>'quantity')::numeric,
         (x->>'unit_price')::numeric,
         v_n + (i * 10),
         auth.uid()
    from jsonb_array_elements(v_q.lines) with ordinality as t(x, i);

  update public.quotes
     set status           = 'accepted',
         accepted_at      = now(),
         accepted_by      = auth.uid(),
         job_id           = coalesce(job_id, v_job),
         job_ref          = coalesce(job_ref, (select ref from public.jobs where id = v_job)),
         converted_job_id = v_job
   where id = p_quote
   returning * into v_q;

  return v_q;
end;
$$;

revoke all on function public.accept_quote(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.accept_quote(uuid, uuid) to authenticated';
  end if;
end $$;

create or replace function public.decline_quote(p_quote uuid, p_reason text default null)
returns public.quotes
language plpgsql
security invoker
set search_path = public
as $$
declare v_q public.quotes;
begin
  if not public.is_ops() then
    raise exception 'Only ops can close a quote.';
  end if;
  select * into v_q from public.quotes where id = p_quote for update;
  if not found then raise exception 'No such quote.'; end if;
  if v_q.status = 'accepted' then
    raise exception 'Quote % was accepted. Void the invoice instead.', v_q.number;
  end if;

  update public.quotes
     set status         = 'declined',
         declined_at    = now(),
         decline_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_quote
   returning * into v_q;
  return v_q;
end;
$$;

revoke all on function public.decline_quote(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.decline_quote(uuid, text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reading them back
-- ---------------------------------------------------------------------------
-- state is worked out rather than stored, so a quote cannot sit in the
-- database claiming to be live three months after it lapsed.

create or replace view public.quote_ledger
with (security_invoker = on) as
select q.*,
       case
         when q.status = 'accepted' then 'accepted'
         when q.status = 'declined' then 'declined'
         when q.valid_until is not null and q.valid_until < current_date then 'expired'
         when q.status = 'sent' then 'awaiting'
         else 'draft'
       end as state,
       greatest(0, current_date - q.valid_until) as days_expired,
       jsonb_array_length(q.lines) as line_count
  from public.quotes q;

comment on view public.quote_ledger is
  'Quotes with their state worked out from the dates: draft, awaiting, expired, accepted or declined.';

grant select on public.quote_ledger to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select number, state, total, valid_until, job_ref from public.quote_ledger
--    order by seq desc;
--
--   select * from public.price_lines('[{"description":"Crate build: 80 x 60 x 90cm(h)",
--                                       "unit":"crate","quantity":2}]'::jsonb);
