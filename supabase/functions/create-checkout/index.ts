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

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!url || !anon || !stripeKey) return reply({ error: "Server secrets are not configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return reply({ error: "Sign in required" }, 401);

  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return reply({ error: "Invalid session" }, 401);

  let body: { plan?: string };
  try { body = await req.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  const plan = body.plan;
  if (!plan || !PRICE_IDS[plan]) return reply({ error: "Invalid plan" }, 400);

  // SECURITY NOTE: organization membership/owner authorization and persistent
  // Stripe customer mapping must be wired to the exact deployed schema before
  // this function can create a checkout session. Fail closed until that is done.
  return reply({
    error: "Checkout is not enabled yet. Organization membership verification and Stripe webhook must be deployed first.",
    authenticated: true,
    selectedPlan: plan,
  }, 501);
});
