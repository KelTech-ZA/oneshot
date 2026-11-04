-- OneShot 60 - the demo workspace
--
-- WHAT THIS IS FOR
--
-- The landing page needs screenshots of the app with work in it, and so does
-- any live demo. Section 9's own workspace cannot be used for either: its 192
-- jobs carry 143 real addresses, 62 contact names, artists' studios named
-- directly, and at least one private residence abroad. Publishing a screenshot
-- of that would hand a competitor a customer list and hand a collector's home
-- address to anyone who looks.
--
-- So this fills the personal workspace with work that never happened. Every
-- gallery, person, address and crate below is invented. The shapes are real -
-- the job types, stop kinds and event types are the ones the app actually
-- uses - so the screens look like the screens, because they are the screens.
--
-- WHAT IT TOUCHES
--
-- One tenant and nothing else. Every statement here is scoped to the tenant
-- id in `ws` below, which is the personal workspace and holds no real work.
-- It clears that workspace first so the file can be run again after a change
-- without stacking up duplicates.
--
-- TO REMOVE IT ALL AGAIN
--
--   delete from public.jobs    where tenant_id = '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d';
--   delete from public.clients where tenant_id = '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d';
--
-- (stops, items, events and charges go with their jobs.)

begin;

-- ---------------------------------------------------------------------------
-- Which workspace, and whose name is on the work
-- ---------------------------------------------------------------------------

create temporary table ws on commit drop as
select '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d'::uuid as tenant_id,
       (select m.user_id from public.memberships m
         where m.tenant_id = '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d'::uuid
         order by m.created_at limit 1) as author;

do $$ begin
  if (select author from ws) is null then
    raise exception 'The personal workspace has no members, so there is nobody to own the demo jobs. Check the tenant id in this file.';
  end if;
end $$;

-- Start from empty every time.
delete from public.jobs    where tenant_id = (select tenant_id from ws);
delete from public.clients where tenant_id = (select tenant_id from ws);

-- ---------------------------------------------------------------------------
-- The galleries, none of which exist
-- ---------------------------------------------------------------------------
-- Billing days are spread so the Clients screen shows the automatic billing
-- set up at different points in the month rather than all on one date.

insert into public.clients
  (tenant_id, name, legal_name, billing_email, billing_address, vat_number,
   payment_terms, vat_applicable, billing_day, billing_direct)
select w.tenant_id, c.name, c.legal, c.email, c.addr, c.vat, c.terms, true, c.day, false
from ws w, (values
  ('Verso Gallery',           'Verso Gallery (Pty) Ltd',        'accounts@verso.example',      E'14 Harrington Street\nCape Town 8001',      '4210000011', 30,  7),
  ('Kestrel Projects',        'Kestrel Projects NPC',           'finance@kestrel.example',     E'3 Marlin Road\nPaarden Eiland 7405',        '4210000022', 30, 15),
  ('Marlow Fine Art',         'Marlow Fine Art CC',             'admin@marlowfine.example',    E'88 Victoria Road\nWoodstock 7925',          '4210000033', 14, 25),
  ('Oakfield Collection',     'Oakfield Collection Trust',      'office@oakfield.example',     E'7 Glen Crescent\nClaremont 7708',           '4210000044', 30, 28),
  ('Bellwether Contemporary', 'Bellwether Contemporary (Pty) Ltd','ap@bellwether.example',     E'21 Buiten Street\nCape Town 8001',          '4210000055', 45, 28),
  ('Tide & Tempo Gallery',    'Tide and Tempo Gallery CC',      'accounts@tidetempo.example',  E'5 Beach Road\nMouille Point 8005',          '4210000066', 30,  1),
  ('Northcliff Art Trust',    'Northcliff Art Trust',           'bookkeeper@northcliff.example',E'19 Rhodes Avenue\nNewlands 7700',          '4210000077', 30, 15),
  ('Saltriver Studio',        'Saltriver Studio (Pty) Ltd',     'studio@saltriver.example',    E'44 Brickfield Road\nSalt River 7925',       '4210000088', 14, null)
) as c(name, legal, email, addr, vat, terms, day);

-- ---------------------------------------------------------------------------
-- Forty-two jobs across three months
-- ---------------------------------------------------------------------------
-- Generated rather than listed, so the spread is visible in the code: the
-- further back a job is, the more likely it is finished; the nearest ones are
-- still booked. That is what makes a calendar look worked rather than seeded.

insert into public.jobs
  (tenant_id, ref, type, status, client_id, origin, destination, scheduled_date,
   time_window, crew, created_by, created_at, contact_name, vat_applicable,
   vat_rate, currency)
select
  w.tenant_id,
  v.ref,
  (array['collection','delivery','installation','packing','move','measure',
         'courier','storage_in'])[1 + (i * 3) % 8],
  -- jobs.status is the job_status enum, not text, so the literal has to be
  -- cast. Its legal values are pending_confirmation, confirmed, assigned,
  -- accepted, in_progress, completed, closed and cancelled; the four used
  -- here are the ones a workspace in steady use actually shows.
  (case
    when dd.d < current_date - 10 then (array['completed','closed','completed'])[1 + i % 3]
    when dd.d < current_date      then (array['completed','in_progress'])[1 + i % 2]
    else (array['confirmed','confirmed','in_progress'])[1 + i % 3]
  end)::public.job_status,
  cl.id,
  -- origin and destination are jsonb, not text: one object each, shaped the
  -- way the parser fills them in - label, notes, address and the contact.
  jsonb_build_object(
    'label',        (array['Studio','Gallery store','Workshop','Client residence','Fair stand'])[1 + (i * 5) % 5],
    'notes',        (array['Access via the loading bay on Brickfield.', null,
                           'Narrow stair - two crew minimum.', null, null])[1 + (i * 3) % 5],
    'address',      (array['14 Harrington Street, Cape Town 8001',
                           '3 Marlin Road, Paarden Eiland 7405',
                           '88 Victoria Road, Woodstock 7925',
                           '44 Brickfield Road, Salt River 7925',
                           '21 Buiten Street, Cape Town 8001'])[1 + (i * 2) % 5],
    'contact_name', (array['Imke de Waal','Nadia Roux','Ben Carter','Pieter Louw',
                           'Zanele Khoza','Sam Orwell'])[1 + (i * 11) % 6],
    'contact_phone','021 555 01' || lpad(((i * 7) % 99)::text, 2, '0')),
  jsonb_build_object(
    'label',        (array['Gallery','Client residence','Store Woodstock','Art fair stand','Studio'])[1 + (i * 7) % 5],
    'notes',        (array[null, 'Install Friday - deliver crated.', null,
                           'Leave crates, collect empties after install.', null])[1 + (i * 4) % 5],
    'address',      (array['7 Glen Crescent, Claremont 7708',
                           '5 Beach Road, Mouille Point 8005',
                           '19 Rhodes Avenue, Newlands 7700',
                           '14 Harrington Street, Cape Town 8001',
                           'CTICC, Convention Square, Cape Town 8001'])[1 + (i * 3) % 5],
    'contact_name', (array['Nadia Roux','Ben Carter','Pieter Louw','Imke de Waal'])[1 + (i * 5) % 4],
    'contact_phone','021 555 02' || lpad(((i * 13) % 99)::text, 2, '0')),
  dd.d,
  (array['08:00-10:00','09:00-12:00','13:00-16:00','07:30-09:30','14:00-17:00'])[1 + (i * 2) % 5],
  -- crew is a text array. A two-name crew is two elements, not one string
  -- with a comma in it, or the job card renders one person called
  -- "Thandi M., Riaan S.".
  string_to_array((array['Thandi M.','Riaan S.','Kagiso P.',
                         'Thandi M.,Riaan S.','Kagiso P.,Thandi M.'])[1 + (i * 4) % 5], ','),
  w.author,
  dd.d - 3,
  (array['Imke de Waal','Nadia Roux','Ben Carter','Pieter Louw','Zanele Khoza','Sam Orwell'])[1 + (i * 11) % 6],
  true, 15, 'ZAR'
from ws w
cross join generate_series(1, 42) as i
cross join lateral (select 'JOB-2026-' || lpad((100 + i)::text, 4, '0') as ref) as v
cross join lateral (select (current_date - ((42 - i) * 2 + (i % 3)))::date as d) as dd
cross join lateral (
  select c.id from public.clients c
   where c.tenant_id = w.tenant_id
   order by c.name offset (i * 5) % 8 limit 1
) as cl;

-- ---------------------------------------------------------------------------
-- Where each one goes
-- ---------------------------------------------------------------------------

-- Taken straight from the job's own origin and destination, so a screenshot
-- cannot show a stop list that disagrees with the job header above it.

insert into public.job_stops (tenant_id, job_id, kind, seq, label, address, contact_name, contact_phone, notes)
select j.tenant_id, j.id, 'collection', 0,
       j.origin->>'label', j.origin->>'address',
       j.origin->>'contact_name', j.origin->>'contact_phone', j.origin->>'notes'
from public.jobs j where j.tenant_id = (select tenant_id from ws);

insert into public.job_stops (tenant_id, job_id, kind, seq, label, address, contact_name, contact_phone, notes)
select j.tenant_id, j.id, 'delivery', 1,
       j.destination->>'label', j.destination->>'address',
       j.destination->>'contact_name', j.destination->>'contact_phone', j.destination->>'notes'
from public.jobs j where j.tenant_id = (select tenant_id from ws);

-- ---------------------------------------------------------------------------
-- What is being moved
-- ---------------------------------------------------------------------------
-- One to three per job. The descriptions are the kind a registrar writes,
-- because that is what makes a screenshot of an item list look like work.

insert into public.line_items (tenant_id, job_id, description, identity_tier, serial_or_code)
select j.tenant_id, j.id,
       (array[
         'Untitled (oil on canvas), 1200 x 900, crated',
         'Bronze maquette, 420mm, foam-packed case',
         'Framed work on paper, 600 x 450, glazed',
         'Ceramic vessel, bubble-wrapped, timber crate',
         'Triptych panel 1 of 3, 1800 x 700',
         'Photographic print, perspex-mounted, 900 x 600',
         'Mixed media assemblage, custom crate',
         'Woven tapestry, rolled, tube'
       ])[1 + (abs(hashtext(j.ref || n::text)) % 8)],
       'crate',
       'CR-' || upper(substr(md5(j.ref || n::text), 1, 5))
from public.jobs j
cross join generate_series(1, 1 + (abs(hashtext(j.ref)) % 3)) as n
where j.tenant_id = (select tenant_id from ws);

-- ---------------------------------------------------------------------------
-- The custody trail
-- ---------------------------------------------------------------------------
-- Only on jobs that have actually started. A booked job with a delivery
-- already logged against it is the detail that tells a careful viewer the
-- data is fake.

insert into public.custody_events (tenant_id, job_id, item_id, type, taken_at, user_id, notes)
select j.tenant_id, j.id, li.id, e.type,
       (j.scheduled_date + e.at)::timestamptz, w.author, e.note
from ws w
join public.jobs j on j.tenant_id = w.tenant_id
join public.line_items li on li.job_id = j.id
cross join lateral (values
  ('built',     time '07:10', 'Crate built to museum spec'),
  ('packed',    time '07:45', 'Packed, condition recorded'),
  ('collected', time '08:30', 'Collected, 2 photos'),
  ('loaded',    time '08:55', null),
  ('in_transit',time '09:20', null),
  ('delivered', time '11:05', 'Delivered, signed for')
) as e(type, at, note)
where j.status in ('completed', 'closed')
   or (j.status = 'in_progress' and e.type in ('built','packed','collected','loaded'));

-- ---------------------------------------------------------------------------
-- What it cost
-- ---------------------------------------------------------------------------

insert into public.job_charges
  (tenant_id, job_id, description, unit, quantity, unit_price, line_total, sort, created_by)
select j.tenant_id, j.id, c.descr, c.unit, c.qty, c.price,
       round(c.qty * c.price, 2), c.sort, w.author
from ws w
join public.jobs j on j.tenant_id = w.tenant_id
cross join lateral (values
  ('Crating - museum spec',            'crate', (1 + (abs(hashtext(j.ref)) % 3))::numeric, 2850::numeric, 1),
  ('Transport - within Cape Town',     'trip',  1::numeric,                                1650::numeric, 2),
  ('Handling and installation',        'hour',  (2 + (abs(hashtext(j.ref || 'h')) % 5))::numeric, 450::numeric, 3)
) as c(descr, unit, qty, price, sort)
where j.status in ('completed', 'closed');

commit;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
--   select status, count(*) from public.jobs
--    where tenant_id = '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d' group by status;
--
--   select (select count(*) from public.jobs        where tenant_id = t) as jobs,
--          (select count(*) from public.clients     where tenant_id = t) as clients,
--          (select count(*) from public.line_items  where tenant_id = t) as items,
--          (select count(*) from public.custody_events where tenant_id = t) as events,
--          (select count(*) from public.job_charges where tenant_id = t) as charges
--     from (select '06b5c9ea-93d5-4f19-8f82-6dcbcefcdb5d'::uuid as t) z;
--
-- NOTE: these rows are counted by public_stats() like any others, so the
-- landing page's figures will include them. If that matters, scope the counts
-- in sql/59 to exclude this tenant.
