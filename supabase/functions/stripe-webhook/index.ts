import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripeKey = Deno.env.get("STRIPE_SECRET_KEY")!;
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const PRICE_TO_PLAN: Record<string, string> = {
  "price_1UP4KvBgGhcZnLUHu7wdxoiH": "basic",
  "price_1UP3CjBgGhcZnLUH3X2e5k8n": "pro",
  "price_1UP3CkBgGhcZnLUHRdJNFLYa": "enterprise",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const signature = req.headers.get("stripe-signature");
  if (!signature || !webhookSecret || !stripeKey || !serviceKey || !supabaseUrl) {
    return new Response("Webhook is not configured", { status: 500 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await req.text();
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error("Stripe signature verification failed", err);
    return new Response("Invalid signature", { status: 400 });
  }

  const { error: seenError } = await db.from("stripe_webhook_events").insert({
    event_id: event.id,
    event_type: event.type,
  });
  if (seenError) {
    if (seenError.code === "23505") return new Response("Already processed", { status: 200 });
    console.error("Could not record webhook event", seenError);
    return new Response("Database error", { status: 500 });
  }

  try {
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.org_id;
      if (!orgId) {
        console.error("Subscription has no org_id metadata", sub.id);
        await db.from("stripe_webhook_events").delete().eq("event_id", event.id);
        return new Response("Missing org metadata", { status: 400 });
      }
      const priceId = sub.items.data[0]?.price?.id ?? "";
      const plan = PRICE_TO_PLAN[priceId] ?? null;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const { error } = await db.from("org_billing").upsert({
        org_id: orgId,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        plan_key: plan,
        status: sub.status,
        current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
        trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        cancel_at_period_end: sub.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      }, { onConflict: "org_id" });
      if (error) throw error;
    }
  } catch (err) {
    // Event receipt remains recorded; remove it so Stripe retries after a fix.
    await db.from("stripe_webhook_events").delete().eq("event_id", event.id);
    console.error("Webhook processing failed", err);
    return new Response("Processing failed", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
