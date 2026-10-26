-- Enough of the live schema for sql/55 to be itself. Column names and types
-- taken from the live database rather than from memory, because the point of
-- running this is to catch the ones I would have got wrong.

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, ref text, client_id uuid,
  vat_applicable boolean, vat_rate numeric, currency text, parsed_as jsonb
);
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, name text, legal_name text, billing_email text,
  billing_address text, vat_number text, reg_number text, eori_number text,
  country text, vat_applicable boolean, payment_terms int, notes text
);
create table public.workspace_billing (
  tenant_id uuid primary key, trading_name text, legal_name text, address text,
  vat_number text, reg_number text, eori_number text, billing_email text, phone text,
  bank_account_holder text, bank_name text, bank_branch text, bank_branch_code text,
  bank_account_number text, bank_swift text, payment_terms int,
  invoice_prefix text, invoice_footer text, updated_at timestamptz, updated_by uuid,
  default_currency text, logo_path text, invoice_next_seq int, invoice_seq_pad int
);
create table public.charge_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, key text, label text, unit text,
  default_rate numeric default 0, account_code text, sort int, active boolean default true,
  created_at timestamptz default now()
);
create table public.job_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid references public.jobs(id) on delete cascade,
  charge_type_id uuid, description text, unit text,
  quantity numeric, unit_price numeric,
  line_total numeric generated always as (round(coalesce(quantity,0) * coalesce(unit_price,0), 2)) stored,
  item_id uuid, sort int, created_by uuid, created_at timestamptz default now()
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, number text, seq int, job_id uuid, total numeric
);

insert into public.workspace_billing (tenant_id, trading_name, legal_name, vat_number,
                                      invoice_prefix, invoice_seq_pad, default_currency)
values ('11111111-1111-1111-1111-111111111111', 'Section 9', 'Crate Logik Pty Ltd',
        '4123456789', 'SEC9', 4, 'ZAR');

insert into public.clients (id, tenant_id, name, legal_name, billing_address, vat_number, payment_terms)
values ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        'Blank Projects', 'Blank Projects CC', '1 Sir Lowry Rd, Cape Town', '4987654321', 14);

insert into public.jobs (id, tenant_id, ref, client_id)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        'SEC-0142', '44444444-4444-4444-4444-444444444444');

-- Charge history shaped like the real thing: "kind: specifics", mostly unique,
-- one task-coded line, one unpriced line that must never be offered as a price.
insert into public.job_charges (tenant_id, job_id, description, unit, quantity, unit_price, sort)
values
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
   'Crate build:  207 x 37 x 146cm(h)','crate',1,3135.00,10),
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
   'Crate: 78 x 73 x 97cm(h)','crate',1,2217.00,20),
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
   'A4 - Airline handling & scanning fee','job',1,1477.50,30),
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
   'Customs forwarding charges','job',1,1704.00,40),
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
   'Tech handling — 4x techs full day','day',1,0.00,50);

insert into public.charge_types (tenant_id, label, unit, default_rate, sort)
values
  ('11111111-1111-1111-1111-111111111111','Packing labour','hour',450.00,20),
  ('11111111-1111-1111-1111-111111111111','Loading','hour',0.00,30);
