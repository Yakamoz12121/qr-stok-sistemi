-- Stripe billing foundation. Additive and schema-independent.
-- This migration intentionally does not assume the name of your organization
-- or membership tables. Keep all billing writes server-side via the webhook.
create table if not exists public.org_billing (
  org_id uuid primary key,
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

-- No client access until tenant-specific read policy is based on the real schema.
revoke all on public.org_billing from anon, authenticated;
revoke all on public.stripe_webhook_events from anon, authenticated;
