import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://yakamoz12121.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PRICE_IDS: Record<string, string> = {
  basic: "price_1UP4KvBgGhcZnLUHu7wdxoiH",
  pro: "price_1UP3CjBgGhcZnLUH3X2e5k8n",
  enterprise: "price_1UP3CkBgGhcZnLUHRdJNFLYa",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!url || !anon || !serviceKey || !stripeKey) return reply({ error: "Server secrets are not configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return reply({ error: "Sign in required" }, 401);
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply({ error: "Invalid session" }, 401);

  let body: { plan?: string; organization_id?: string };
  try { body = await req.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  const plan = body.plan;
  const organizationId = body.organization_id;
  if (!plan || !PRICE_IDS[plan]) return reply({ error: "Invalid plan" }, 400);
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) return reply({ error: "Missing organization_id" }, 400);

  // Authorization is checked against the authenticated user's own membership.
  const { data: membership, error: memberError } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  const { data: organization, error: orgError } = await userClient
    .from("organizations")
    .select("owner_user_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (memberError || orgError) return reply({ error: "Could not verify organization permissions" }, 500);
  const isOwner = organization?.owner_user_id === user.id;
  const isPatron = (membership?.role || "").toLowerCase() === "patron";
  if (!isOwner && !isPatron) return reply({ error: "Only the business owner can manage billing" }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: billing, error: billingError } = await admin
    .from("org_billing").select("stripe_customer_id,status")
    .eq("org_id", organizationId).maybeSingle();
  if (billingError) return reply({ error: "Billing table is not ready; apply the billing migration first" }, 500);
  if (billing?.status === "active" || billing?.status === "trialing") {
    return reply({ error: "This organization already has an active subscription. Use the customer portal to change it." }, 409);
  }

  let customerId = billing?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customerForm = new URLSearchParams();
    customerForm.set("email", user.email || "");
    customerForm.set("name", String(organizationId));
    customerForm.set("metadata[org_id]", organizationId);
    customerForm.set("metadata[owner_user_id]", user.id);
    const customerRes = await fetch("https://api.stripe.com/v1/customers", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: customerForm,
    });
    const customer = await customerRes.json();
    if (!customerRes.ok) return reply({ error: customer.error?.message || "Stripe customer creation failed" }, 502);
    customerId = customer.id;
    const { error: saveError } = await admin.from("org_billing").upsert({
      org_id: organizationId, stripe_customer_id: customerId, updated_at: new Date().toISOString(),
    }, { onConflict: "org_id" });
    if (saveError) return reply({ error: "Could not save billing customer mapping" }, 500);
  }

  const origin = "https://yakamoz12121.github.io/qr-stok-sistemi/";
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("customer", customerId);
  form.set("line_items[0][price]", PRICE_IDS[plan]);
  form.set("line_items[0][quantity]", "1");
  form.set("subscription_data[trial_period_days]", "7");
  form.set("subscription_data[metadata][org_id]", organizationId);
  form.set("subscription_data[metadata][plan_key]", plan);
  form.set("metadata[org_id]", organizationId);
  form.set("metadata[plan_key]", plan);
  form.set("payment_method_collection", "always");
  form.set("success_url", origin + "?billing=success");
  form.set("cancel_url", origin + "?billing=cancel");
  const checkoutRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const checkout = await checkoutRes.json();
  if (!checkoutRes.ok) return reply({ error: checkout.error?.message || "Checkout creation failed" }, 502);
  return reply({ url: checkout.url });
});
