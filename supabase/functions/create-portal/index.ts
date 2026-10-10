import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://yakamoz12121.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return reply({ error: "Invalid session" }, 401);
  let body: { organization_id?: string };
  try { body = await req.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  const orgId = body.organization_id;
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) return reply({ error: "Missing organization_id" }, 400);
  const { data: membership, error: memberError } = await userClient.from("organization_members")
    .select("role").eq("organization_id", orgId).eq("user_id", user.id).maybeSingle();
  const { data: org, error: orgError } = await userClient.from("organizations")
    .select("owner_user_id").eq("id", orgId).maybeSingle();
  if (memberError || orgError) return reply({ error: "Could not verify organization permissions" }, 500);
  if (org?.owner_user_id !== user.id && (membership?.role || "").toLowerCase() !== "patron") {
    return reply({ error: "Only the business owner can manage billing" }, 403);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: billing, error } = await admin.from("org_billing").select("stripe_customer_id")
    .eq("org_id", orgId).maybeSingle();
  if (error) return reply({ error: "Billing table is not ready" }, 500);
  if (!billing?.stripe_customer_id) return reply({ error: "No Stripe customer exists for this organization yet" }, 404);
  const form = new URLSearchParams();
  form.set("customer", billing.stripe_customer_id);
  form.set("return_url", "https://yakamoz12121.github.io/qr-stok-sistemi/");
  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const result = await response.json();
  if (!response.ok) return reply({ error: result.error?.message || "Portal creation failed" }, 502);
  return reply({ url: result.url });
});
