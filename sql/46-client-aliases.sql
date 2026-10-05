-- OneShot 46 - the names customers actually get called
--
-- Nobody writes "Blank Projects Contemporary (Pty) Ltd" in an email. They
-- write "Blank projects". Or "Stevenson", or "WITW", or "THK". The matcher
-- wanted an exact hit on name or legal_name, so all of those missed - and a
-- miss is not harmless: the job still gets its billing details, but with no
-- client_id, so it never appears on that customer's statement and the money
-- quietly goes uncounted.
--
-- Most short forms can be worked out at read time, and now are: a name that
-- reduces to the same distinctive core, or sits inside exactly one customer's
-- name, matches without anybody setting anything up. That covers "Blank
-- projects" and "Stevenson".
--
-- What it cannot cover is a name with no textual relationship to the real one.
-- "WITW" is not derivable from "WhatIfTheWorld" by any rule worth trusting on
-- an invoice. That is what this column is for: the handful of names a
-- workspace knows and no algorithm could guess.
--
-- It lives on the CLIENT, not in the parser's vocabulary, because it is a fact
-- about the customer rather than a fact about parsing. Ops type it in next to
-- the VAT number, where they are already looking, and it is visible and
-- editable without going near the maintenance console. The console's "map"
-- action writes here too, so deciding a queued term and editing the client end
-- up in the same place rather than in two stores that disagree.
--
-- Safe to run more than once.

begin;

alter table public.clients
  add column if not exists aliases text[] not null default '{}'::text[];

comment on column public.clients.aliases is
  'Other names this customer is called in mail - short forms, initialisms, trading names. Matched exactly (case and punctuation ignored); derivable forms need no entry here.';

-- Tidy the list on the way in, rather than refusing it.
--
-- A CHECK constraint cannot do this - it may not contain a subquery, and
-- inspecting the elements of an array needs one - but a trigger can, and
-- tidying is the better behaviour regardless. Somebody typing a trailing
-- space, or the same short name twice, should get a clean list rather than an
-- error they have to decode. Only a list long enough to be a mistake is
-- refused outright.

create or replace function public.tidy_client_aliases()
returns trigger
language plpgsql
as $$
begin
  if new.aliases is null then
    new.aliases := '{}'::text[];
    return new;
  end if;

  select coalesce(array_agg(distinct a order by a), '{}'::text[])
    into new.aliases
    from (
      select left(btrim(x), 120) as a
        from unnest(new.aliases) as x
       where btrim(x) <> ''
    ) cleaned;

  if coalesce(array_length(new.aliases, 1), 0) > 25 then
    raise exception 'A client cannot have more than 25 other names (got %).',
      array_length(new.aliases, 1);
  end if;

  return new;
end;
$$;

drop trigger if exists tidy_client_aliases on public.clients;
create trigger tidy_client_aliases
  before insert or update of aliases on public.clients
  for each row execute function public.tidy_client_aliases();

-- Looking a name up across the list, for anything that wants to ask the
-- database rather than hold the clients in memory.
create index if not exists clients_aliases_idx on public.clients using gin (aliases);

commit;

-- ---------------------------------------------------------------------------
-- What to put in it
-- ---------------------------------------------------------------------------
-- Run this to see the customers whose names have a corporate tail or a
-- squashed-together word, which are the two cases worth an alias. Everything
-- else already matches on its own.
--
--   select name, legal_name, aliases from public.clients order by name;
--
-- Section 9's list, as it stood when this was written, needs very little:
-- "WhatIfTheWorld Gallery" wants WITW, and the rest match already. The app
-- offers these as suggestions on the client card; nothing is added for you,
-- because an alias decides whose invoice a job belongs to and that is not a
-- thing to guess at on somebody's behalf.
