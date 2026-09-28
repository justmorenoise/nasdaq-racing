-- Database side of the live price feed, to run once on a new Supabase project
-- (SQL editor). Needs the pg_cron, pg_net and supabase_vault extensions.
-- Replace <project-ref> and <anon-key> with the project's own values: the anon
-- key is the public one the browser uses; no secret goes in this file.

-- Latest quote per symbol, read by the browser and followed over Realtime.
create table if not exists public.prices (
  symbol text primary key,
  price double precision not null default 0,
  change_pct double precision not null default 0,
  ts timestamptz not null default now()
);
alter table public.prices enable row level security;
create policy "public read prices" on public.prices for select to anon, authenticated using (true);
alter table public.prices replica identity full;
alter publication supabase_realtime add table public.prices;

-- Shared secret between the cron job and the update-prices Edge Function, so
-- only the scheduler can trigger a Finnhub refresh (the anon key is public).
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'update_prices_cron_secret',
  'x-cron-secret header the update-prices function requires');

-- The function checks a candidate against the Vault; callable by service_role only.
create or replace function public.check_cron_secret(candidate text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'update_prices_cron_secret' and decrypted_secret = candidate
  );
$$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- Refresh every minute; the secret is read from the Vault at each run.
select cron.schedule(
  'update-prices-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/update-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <anon-key>',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'update_prices_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
