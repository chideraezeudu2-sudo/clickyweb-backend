-- Usage/plan storage for the backend proxy.
-- Run once in the Supabase SQL editor for your project.

create table if not exists public.clickyweb_usage (
  install_id              text primary key,
  plan                    text        not null default 'free',
  count                   integer     not null default 0,
  period_start            timestamptz not null default now(),
  stripe_subscription_id  text,
  stripe_customer_id      text
);

-- Webhook handlers look rows up by subscription id when applying plan changes.
create index if not exists clickyweb_usage_stripe_subscription_id_idx
  on public.clickyweb_usage (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- The backend reaches this table with the service-role key, which bypasses RLS.
-- RLS is enabled so nothing holding the anon key can read or write usage records.
alter table public.clickyweb_usage enable row level security;