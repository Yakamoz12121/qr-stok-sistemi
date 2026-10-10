import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://yakamoz12121.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Server configuration missing" }, 500);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return json({ error: "Sign in required" }, 401);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: "Invalid session" }, 401);

  let body: { organization_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const orgId = body.organization_id;
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) return json({ error: "Invalid organization_id" }, 400);

  const [{ data: org, error: orgError }, { data: member, error: memberError }] = await Promise.all([
    userClient.from("organizations").select("owner_user_id").eq("id", orgId).maybeSingle(),
    userClient.from("organization_members").select("role").eq("organization_id", orgId).eq("user_id", user.id).maybeSingle(),
  ]);
  if (orgError || memberError) return json({ error: "Permission check failed" }, 500);
  if (org?.owner_user_id !== user.id && (member?.role || "").toLowerCase() !== "patron") return json({ error: "Forbidden" }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.from("org_billing")
    .select("plan_key,status,current_period_end,trial_end,cancel_at_period_end")
    .eq("org_id", orgId).maybeSingle();
  if (error) return json({ error: "Could not load billing status" }, 500);
  return json(data || { plan_key: null, status: "inactive", current_period_end: null, trial_end: null, cancel_at_period_end: false });
});
