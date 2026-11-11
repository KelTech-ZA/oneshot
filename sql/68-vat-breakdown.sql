-- OneShot 68 - the VAT split a mixed-rate tax invoice has to print
--
-- WHY THIS EXISTS AT ALL
--
-- sql/66 made VAT a per-line thing. It did not change what the documents say,
-- and the documents are now capable of lying.
--
-- The PDF totals block prints:
--
--     Subtotal            12 000.00
--     VAT 15%              1 200.00
--     Total ZAR           13 200.00
--
-- The "15%" there is invoices.vat_rate - the DOCUMENT rate - printed next to
-- invoices.vat, which after sql/66 may have been worked out from a mixture of
-- rates. On an invoice carrying a local collection at 15% and an export leg at
-- 0%, that line says 15% beside a figure that is not 15% of the subtotal. A
-- customer's accounts department checks exactly that multiplication, and SARS
-- requires a tax invoice covering supplies at more than one rate to show the
-- value and the tax for each rate separately.
--
-- So the document needs the split, and this is the one function that produces
-- it.
--
-- WHY IT IS A FUNCTION AND NOT A COLUMN
--
-- The invoice's lines are frozen at issue. Recomputing the split from frozen
-- lines is deterministic - the same input gives the same answer forever - so
-- there is nothing to store and nothing that can drift out of step with the
-- row. A column would be a second copy of a derivable fact, and one more
-- thing for a future migration to forget to fill in.
--
-- WHY IT IS NOT DONE IN THE PDF
--
-- supabase/functions/_shared/pack.ts says at the top that nothing is computed
-- there, because a document that does its own arithmetic is a document that
-- can disagree with the database it came from. That principle is right and
-- this honours it: the breakdown arrives worked out, and pack.ts draws it.
--
-- THE GUARANTEE THIS MUST KEEP
--
--     sum of the breakdown's vat  =  vat_on_lines(same arguments)  exactly
--
-- Not to within a cent. Exactly. The breakdown and the total are printed on
-- the same page, one under the other, and a customer who adds up the first
-- and gets the second is the whole point. So the single-rate branch rounds
-- the subtotal the same way vat_on_lines does, and the mixed branch sums the
-- same per-line rounded figures. The test file asserts this over every shape
-- it can think of, including randomised ones.
--
-- WHAT IT RETURNS
--
--     []                                      no lines
--     [{"rate":0,"net":12000,"vat":0}]        document not vatable
--     [{"rate":15,"net":12000,"vat":1800}]    one rate - the ordinary invoice
--     [{"rate":15,"net":8000,"vat":1200},
--      {"rate":0,"net":4000,"vat":0}]         mixed, highest rate first
--
-- Highest rate first because that is the order a person reads a tax invoice
-- in: what was taxed, then what was not.
--
-- Safe to run more than once. Requires sql/66.

begin;

create or replace function public.vat_breakdown(
  p_lines      jsonb,
  p_applicable boolean,
  p_rate       numeric
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_sub    numeric := 0;
  v_rows   jsonb := '[]'::jsonb;
  v_n      int := 0;
  v_line   jsonb;
begin
  -- A line with no line_total still counts as a line, at nil. An empty
  -- document is the only thing that comes back empty: a group of nothing is
  -- not a thing to print.
  select count(*),
         coalesce(sum(coalesce(nullif(btrim(coalesce(x->>'line_total', '')), '')::numeric, 0)), 0)
    into v_n, v_sub
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x;

  if v_n = 0 then
    return '[]'::jsonb;
  end if;

  -- Not vatable is not a rate of its own: it means every line is at nil,
  -- whatever the lines themselves say. vat_on_lines returns 0 here and this
  -- has to agree with it.
  if not coalesce(p_applicable, false) then
    return jsonb_build_array(jsonb_build_object(
      'rate', 0, 'net', round(v_sub, 2), 'vat', 0));
  end if;

  -- One group per distinct effective rate.
  select coalesce(jsonb_agg(jsonb_build_object(
           'rate', g.rate,
           'net',  round(g.net, 2),
           'vat',  round(g.vat, 2)
         ) order by g.rate desc), '[]'::jsonb)
    into v_rows
    from (
      select r.rate,
             sum(r.net) as net,
             -- Per line, rounded per line. Correct for the mixed case and
             -- overwritten below for the single-rate one.
             sum(round(r.net * r.rate / 100, 2)) as vat
        from (
          -- nullif on the blank string because this is granted to
          -- authenticated and can be handed any jsonb. bill_lines drops the
          -- key when there is no rate, but '' arriving from somewhere else
          -- should read as "no opinion", not raise a cast error.
          select coalesce(nullif(btrim(coalesce(x->>'vat_rate', '')), '')::numeric,
                          coalesce(p_rate, 0))                               as rate,
                 coalesce(nullif(btrim(coalesce(x->>'line_total', '')), '')::numeric, 0) as net
            from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
        ) r
       group by r.rate
    ) g;

  -- Every line on one rate: round the subtotal, which is what this database
  -- did before sql/66 and what every invoice already issued was built with.
  -- Without this the breakdown on an ordinary invoice could differ by a cent
  -- from the invoices.vat sitting in the row beside it.
  if jsonb_array_length(v_rows) = 1 then
    v_rows := jsonb_build_array(jsonb_build_object(
      'rate', (v_rows->0->>'rate')::numeric,
      'net',  round(v_sub, 2),
      'vat',  round(v_sub * (v_rows->0->>'rate')::numeric / 100, 2)));
  end if;

  return v_rows;
end;
$$;

comment on function public.vat_breakdown(jsonb, boolean, numeric) is
  'The per-rate split of a document''s VAT, for printing. Sums exactly to vat_on_lines of the same arguments. See sql/68.';

-- Readable by anyone who can read the document it describes. It computes from
-- arguments and touches no table, so there is nothing here for RLS to scope.
--
-- Guarded the way sql/66 guards its grants: the Supabase roles do not exist in
-- the Postgres the tests run against, and a migration that will not install
-- under test is a migration nobody checks.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.vat_breakdown(jsonb, boolean, numeric) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reading it off a document
-- ---------------------------------------------------------------------------
--
-- The billing-run function and anything else building a PDF should not have
-- to remember which three fields to pass. These two views do it once.
--
-- They are deliberately thin: the breakdown and the invoice's own id, nothing
-- else. Joining them is cheaper than widening invoice_ledger, which several
-- screens select * from.

create or replace view public.invoice_vat_breakdown as
  select i.id as invoice_id,
         i.tenant_id,
         public.vat_breakdown(i.lines, i.vat_applicable, i.vat_rate) as vat_breakdown
    from public.invoices i;

create or replace view public.quote_vat_breakdown as
  select q.id as quote_id,
         q.tenant_id,
         public.vat_breakdown(q.lines, q.vat_applicable, q.vat_rate) as vat_breakdown
    from public.quotes q;

-- The views inherit the base tables' RLS: security_invoker makes the reader's
-- own policies apply, so a workspace sees its own documents and no others.
-- Without this a view owned by the migration role would read past RLS.
alter view public.invoice_vat_breakdown set (security_invoker = true);
alter view public.quote_vat_breakdown   set (security_invoker = true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.invoice_vat_breakdown to authenticated';
    execute 'grant select on public.quote_vat_breakdown to authenticated';
  end if;
end $$;

commit;
