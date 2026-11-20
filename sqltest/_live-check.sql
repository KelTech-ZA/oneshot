with f as (
  select p.proname, pg_get_functiondef(p.oid) as def,
         pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
), chk(step, what, ok) as (
  values
  ('66', 'job_charges.vat_rate column',
     (select count(*) from information_schema.columns
       where table_schema='public' and table_name='job_charges' and column_name='vat_rate') = 1),
  ('66', 'bill_lines()',        (select count(*) from f where proname='bill_lines') = 1),
  ('66', 'vat_on_lines()',      (select count(*) from f where proname='vat_on_lines') = 1),
  ('66', 'retotal_invoice()',   (select count(*) from f where proname='retotal_invoice') = 1),
  ('66', 'invoice_edits table',
     (select count(*) from information_schema.tables
       where table_schema='public' and table_name='invoice_edits') = 1),
  ('67', 'next_invoice_seq()',  (select count(*) from f where proname='next_invoice_seq') = 1),
  ('67', 'invoice_number_for()',(select count(*) from f where proname='invoice_number_for') = 1),
  ('67', 'unique index on (tenant_id, number)',
     (select count(*) from pg_indexes
       where schemaname='public' and indexname='invoices_tenant_number_key') = 1),
  ('68', 'vat_breakdown()',     (select count(*) from f where proname='vat_breakdown') = 1),
  ('68', 'invoice_vat_breakdown view',
     (select count(*) from information_schema.views
       where table_schema='public' and table_name='invoice_vat_breakdown') = 1),
  ('68', 'quote_vat_breakdown view',
     (select count(*) from information_schema.views
       where table_schema='public' and table_name='quote_vat_breakdown') = 1),
  ('69', 'create_quote uses bill_lines',
     (select def like '%bill_lines%' from f where proname='create_quote')),
  ('70', 'create_quote takes p_vat_applicable',
     (select args like '%p_vat_applicable%' from f where proname='create_quote')),
  ('70', 'only one create_quote (no stale overload)',
     (select count(*) from f where proname='create_quote') = 1),
  ('--', 'create_invoice still uses vat_on_lines',
     (select def like '%vat_on_lines%' from f where proname='create_invoice')),
  ('--', 'issue_invoice still uses vat_on_lines',
     (select def like '%vat_on_lines%' from f where proname='issue_invoice')),
  ('!!', 'create_invoice has the CORRECTED payment_terms line',
     (select def not like '%coalesce(p_payment_terms, v_client.payment_terms%' from f where proname='create_invoice')),
  ('--', 'no duplicate invoice numbers',
     (select count(*) from (select tenant_id, number from public.invoices
                             group by 1,2 having count(*) > 1) d) = 0)
)
select step,
       case when ok then 'ok     ' else 'NOT OK ' end as result,
       what
  from chk
 order by case when ok then 1 else 0 end, step, what;
