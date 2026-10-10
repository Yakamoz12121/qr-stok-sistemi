-- Stripe billing foundation. Additive only: does not rewrite existing org/user data.
-- Run in Supabase SQL Editor after confirming org_id references the existing organizations table.
create table if not exists public.org_billing (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan_key text check (plan_key in ('basic','pro','enterprise')),
  status text not null default 'inactive',
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.org_billing enable row level security;
alter table public.stripe_webhook_events enable row level security;

-- No client-side writes to billing records. A server-side webhook with service role updates them.
drop policy if exists "org members can read own billing" on public.org_billing;
create policy "org members can read own billing" on public.org_billing
for select to authenticated
using (
  exists (
    select 1 from public.org_members m
    where m.org_id = org_billing.org_id
      and m.user_id = auth.uid()
  )
);

-- Deliberately no client policies on webhook events.
revoke all on public.stripe_webhook_events from anon, authenticated;
revoke insert, update, delete on public.org_billing from anon, authenticated;
