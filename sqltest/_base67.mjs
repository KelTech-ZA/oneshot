// The schema sql/66 and sql/67 are tested against, shared so a test cannot
// quietly disagree with the column types the database actually has.
const OPS = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "11111111-1111-1111-1111-111111111111";
const JOB = "99999999-9999-9999-9999-999999999999";

export const BASE = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text);
  insert into auth.users values ('${OPS}','ops@s9.co.za'), ('${CREW}','crew@s9.co.za');
  create table public._session (uid uuid, tenant uuid);
  insert into public._session values ('${OPS}', '${T1}');
  create function auth.uid() returns uuid language sql stable
    as $$ select uid from public._session limit 1 $$;
  create function public.my_tenant() returns uuid language sql stable
    as $$ select tenant from public._session limit 1 $$;
  create table public.tenants (id uuid primary key, name text);
  insert into public.tenants values ('${T1}','Section 9');
  create table public.memberships (user_id uuid, tenant_id uuid, role text);
  insert into public.memberships values ('${OPS}','${T1}','ops'), ('${CREW}','${T1}','driver');

  -- after memberships: a sql function's body is checked when it is created
  create function public.is_ops() returns boolean language sql stable as $$
    select exists (select 1 from public.memberships m
                    where m.user_id = auth.uid() and m.tenant_id = public.my_tenant()
                      and m.role = 'ops') $$;

  create table public.clients (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    name text, legal_name text, billing_address text, vat_number text, reg_number text,
    billing_email text, payment_terms int, vat_applicable boolean);
  create table public.workspace_billing (tenant_id uuid primary key, invoice_prefix text,
    quote_prefix text, invoice_seq_pad int, quote_seq_pad int, default_currency text,
    payment_terms int, vat_number text, quote_valid_days int,
    invoice_next_seq bigint default 1, updated_by uuid);
  insert into public.workspace_billing (tenant_id, invoice_prefix, invoice_seq_pad,
                                        default_currency, vat_number, invoice_next_seq)
    values ('${T1}','SEC9',4,'ZAR','4123456789',1);

  create table public.jobs (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    ref text, client_id uuid, currency text, vat_applicable boolean, vat_rate numeric,
    scheduled_date date);
  insert into public.jobs (id, tenant_id, ref, vat_applicable, vat_rate, scheduled_date)
    values ('${JOB}','${T1}','JOB-2026-0401', true, 15, current_date);

  create table public.job_billing (job_id uuid primary key, tenant_id uuid, client_id uuid,
    bill_to_name text, bill_to_address text, vat_number text, reg_number text,
    billing_email text, reference text, payment_terms int,
    invoice_number text, invoice_date date, updated_at timestamptz);
  insert into public.job_billing (job_id, tenant_id, bill_to_name, payment_terms)
    values ('${JOB}','${T1}','Verso Gallery',30);

  create table public.job_charges (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, job_id uuid, charge_type_id uuid, description text, unit text,
    quantity numeric, unit_price numeric,
    line_total numeric generated always as (round(coalesce(quantity,1) * coalesce(unit_price,0), 2)) stored,
    sort int, created_by uuid, created_at timestamptz default now());

  create table public.invoices (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    number text, seq bigint, job_id uuid, job_ref text, client_id uuid,
    bill_to_name text, bill_to_address text, bill_to_vat_number text, bill_to_reg_number text,
    billing_email text, their_reference text, currency text,
    vat_applicable boolean, vat_rate numeric, subtotal numeric, vat numeric, total numeric,
    lines jsonb, issuer jsonb, invoice_date date, due_date date, payment_terms text,
    status text default 'issued', notes text, issued_by uuid,
    issued_at timestamptz default now(), created_at timestamptz default now());
  create table public.invoice_payments (id uuid primary key default gen_random_uuid(),
    tenant_id uuid, invoice_id uuid, amount numeric, paid_on date);
  create table public.quotes (id uuid primary key default gen_random_uuid(), tenant_id uuid,
    number text, status text, vat_applicable boolean, vat_rate numeric,
    subtotal numeric, vat numeric, total numeric, lines jsonb);
`;
export { OPS, CREW, T1, JOB };
