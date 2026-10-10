
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://yakamoz12121.github.io",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

// Ana yönetici hesabı
const ADMIN_ID = "6fca2729-3645-4cb6-9911-1961a44da015";
const ADMIN_EMAIL = "yakamoz123cetinkaya@gmail.com";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ error: "Method not allowed" }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !anonKey || !serviceKey) {
    return reply({ error: "Sunucu yapılandırması eksik." }, 500);
  }

  const authorization = req.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return reply({ error: "Önce giriş yapmalısın." }, 401);
  }

  // Çağrıyı yapan kullanıcının oturumunu doğrula.
  const callerClient = createClient(url, anonKey, {
    global: {
      headers: { Authorization: authorization },
    },
    auth: { persistSession: false },
  });

  const { data: authData, error: authError } =
    await callerClient.auth.getUser();

  const user = authData.user;

  if (authError || !user) {
    return reply({ error: "Oturum geçersiz." }, 401);
  }

  const isAdmin =
    user.id === ADMIN_ID &&
    user.email?.trim().toLowerCase() === ADMIN_EMAIL;

  // Servis anahtarı yalnızca sunucuda kullanılır.
  const privileged = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  let body: {
    action?: string;
    email?: string;
    role?: string;
    organization_id?: string;
    organization_name?: string;
  };

  try {
    body = await req.json();
  } catch {
    return reply({ error: "Geçersiz istek." }, 400);
  }

  // Yönetici paneli için işletme ve üyelik listesi.
  if (body.action === "list") {
    if (!isAdmin) {
      return reply({ error: "Bu işlem için yetkin yok." }, 403);
    }

    const [orgs, members, users] = await Promise.all([
      privileged
        .from("organizations")
        .select("id,name,owner_user_id,is_active,created_at")
        .order("created_at", { ascending: false }),

      privileged
        .from("organization_members")
        .select("organization_id,user_id,role,created_at"),

      privileged.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      }),
    ]);

    if (orgs.error || members.error || users.error) {
      return reply({ error: "Yönetim listesi alınamadı." }, 500);
    }

    return reply({
      organizations: orgs.data || [],
      members: members.data || [],
      users: (users.data.users || []).map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        email_confirmed_at: u.email_confirmed_at,
      })),
    });
  }

  if (body.action !== "invite") {
    return reply({ error: "Bilinmeyen işlem." }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const role = (body.role || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply({ error: "Geçerli bir e-posta gir." }, 400);
  }

  if (role !== "patron" && role !== "calisan") {
    return reply({ error: "Geçersiz rol." }, 400);
  }

  let organizationId = (body.organization_id || "").trim();
  const organizationName = (body.organization_name || "").trim();

  if (isAdmin) {
    if (role === "patron" && !organizationName) {
      return reply({ error: "İşletme adı gerekli." }, 400);
    }

    if (role === "calisan" && !organizationId) {
      return reply({ error: "Çalışan için işletme seçmelisin." }, 400);
    }
  } else {
    // Patron başka patron oluşturamaz veya başka işletmeye
    // çalışan ekleyemez.
    if (role !== "calisan" || !organizationId) {
      return reply({
        error: "Patronlar yalnızca kendi işletmelerine çalışan ekleyebilir.",
      }, 403);
    }

    const [membership, organization] = await Promise.all([
      callerClient
        .from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", user.id)
        .maybeSingle(),

      callerClient
        .from("organizations")
        .select("owner_user_id")
        .eq("id", organizationId)
        .maybeSingle(),
    ]);

    const canManage =
      organization.data?.owner_user_id === user.id ||
      ["patron", "owner"].includes(
        (membership.data?.role || "").toLowerCase()
      );

    if (!canManage) {
      return reply({ error: "Bu işletme için yetkin yok." }, 403);
    }
  }

  // Çalışan davetinde hedef işletmenin varlığını kontrol et.
  if (role === "calisan" && isAdmin) {
    const { data: org, error } = await privileged
      .from("organizations")
      .select("id")
      .eq("id", organizationId)
      .maybeSingle();

    if (error || !org) {
      return reply({ error: "İşletme bulunamadı." }, 404);
    }
  }

  // Supabase Auth daveti kullanıcıya e-posta gönderir.
  const { data: invitation, error: inviteError } =
    await privileged.auth.admin.inviteUserByEmail(email, {
      redirectTo:
        "https://yakamoz12121.github.io/qr-stok-sistemi/",
    });

  if (inviteError || !invitation.user) {
    return reply({
      error: inviteError?.message || "Davet gönderilemedi.",
    }, 400);
  }

  // Ana yönetici yeni patron için işletme oluşturur.
  if (role === "patron" && isAdmin) {
    const { data: org, error } = await privileged
      .from("organizations")
      .insert({
        name: organizationName,
        slug:
          "isletme-" +
          crypto.randomUUID().replaceAll("-", ""),
        owner_user_id: invitation.user.id,
        settings: {},
        is_active: true,
      })
      .select("id")
      .single();

    if (error || !org) {
      return reply({
        error:
          "Davet gönderildi ancak işletme oluşturulamadı. İşletme kaydını kontrol et.",
      }, 500);
    }

    organizationId = org.id;
  }

  // Kullanıcıyı ilgili işletmeye ve role bağla.
  const { error: memberError } = await privileged
    .from("organization_members")
    .insert({
      organization_id: organizationId,
      user_id: invitation.user.id,
      role,
      invited_by: user.id,
    });

  if (memberError) {
    return reply({
      error:
        "Davet gönderildi fakat üyelik kaydedilemedi. Hata: " +
        memberError.message,
    }, 500);
  }

  return reply({
    ok: true,
    email,
    role,
    organization_id: organizationId,
    message: "Davet e-postası gönderildi.",
  });
});
