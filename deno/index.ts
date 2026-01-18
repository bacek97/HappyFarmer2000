const BOT_TOKEN = Deno.env.get("BOT_TOKEN") || "";

async function getHasuraClaims(authHeader: string | null) {
  const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN");
  if (authHeader && SERVICE_USER_TOKEN && authHeader === SERVICE_USER_TOKEN) {
    console.log("Auth: Service User authenticated");
    let userId = "0";
    try {
      const params = new URLSearchParams(authHeader);
      const userRaw = params.get("user");
      if (userRaw) {
        userId = JSON.parse(userRaw).id.toString();
      }
    } catch (e) {
      console.warn("Could not parse user from Service Token, using 0");
    }

    return {
      "X-Hasura-Role": "service_role",
      "X-Hasura-User-Id": userId,
    };
  }

  try {
    if (!authHeader) {
      console.log("Auth: No header");
      return { "X-Hasura-Role": "anonymous" };
    }

    const params = new URLSearchParams(authHeader);
    const hash = params.get("hash");
    const userRaw = params.get("user");
    if (!hash || !userRaw) {
      console.log("Auth: Missing hash or user data");
      throw new Error("Missing data");
    }

    // 1. Подготовка строки проверки
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`).sort().join("\n");

    // 2. Web Crypto: создаем ключи и проверяем подпись
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", key, enc.encode(BOT_TOKEN));
    const finalKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);

    const signature = new Uint8Array(hash.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
    const isValid = await crypto.subtle.verify("HMAC", finalKey, signature, enc.encode(dataCheckString));

    if (!isValid) {
      console.log("Auth: Invalid signature");
      throw new Error("Invalid signature");
    }

    // 3. Успех: возвращаем данные для Hasura
    return {
      "X-Hasura-User-Id": JSON.parse(userRaw).id.toString(),
      "X-Hasura-Role": "user",
    };
  } catch (e) {
    console.error("Auth Error:", e);
    return null; // Ошибка валидации
  }
}

async function handleAuth(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authHeader = req.headers.get("authorization");
  console.log("Checking Auth Header:", authHeader ? "Present" : "Missing");

  const claims = await getHasuraClaims(authHeader);

  if (!claims) {
    console.log("Auth failed: returning 401");
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  return new Response(JSON.stringify(claims), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function handleCreateInvoice(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const body = await req.json();
    console.log("create_invoice body:", JSON.stringify(body));

    const { item_id } = body.input;
    const { "x-hasura-user-id": userId } = body.session_variables || {};

    if (!userId) {
      console.error("Missing user_id in session_variables");
      return new Response(JSON.stringify({ message: "User not found in session" }), { status: 400 });
    }

    // Fetch item details from Hasura
    const HASURA_URL = Deno.env.get("HASURA_GRAPHQL_ENDPOINT");
    const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN");

    if (!HASURA_URL || !SERVICE_USER_TOKEN) {
      console.error("Missing HASURA_GRAPHQL_ENDPOINT or SERVICE_USER_TOKEN");
      return new Response(JSON.stringify({ message: "Server configuration error" }), { status: 500 });
    }

    const itemQuery = `
      query GetItem($id: uuid!) {
        premium_items_by_pk(id: $id) {
          name
          price_stars
        }
      }
    `;

    const itemRes = await fetch(HASURA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": SERVICE_USER_TOKEN,
      },
      body: JSON.stringify({
        query: itemQuery,
        variables: { id: item_id },
      }),
    });

    const itemData = await itemRes.json();
    if (itemData.errors || !itemData.data.premium_items_by_pk) {
      console.error("Item not found or error. ID:", item_id, "Response:", JSON.stringify(itemData));
      return new Response(JSON.stringify({ message: `Item not found: ${item_id}` }), { status: 404 });
    }

    const item = itemData.data.premium_items_by_pk;
    const price = item.price_stars;
    const title = item.name;
    const description = `Покупка: ${item.name}`;
    const payload = JSON.stringify({ userId, itemId: item_id });

    if (!BOT_TOKEN) {
      console.error("BOT_TOKEN is missing");
      return new Response(JSON.stringify({ message: "Server configuration error: BOT_TOKEN missing" }), { status: 500 });
    }

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/test/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        payload,
        provider_token: "", // Empty for Stars
        currency: "XTR",
        prices: [{ label: "Price", amount: price }],
      }),
    });

    const data = await res.json();
    console.log("Telegram response:", JSON.stringify(data));

    if (!data.ok) {
      return new Response(JSON.stringify({ message: data.description }), { status: 400 });
    }

    return new Response(JSON.stringify({ invoice_link: data.result }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    console.error("Error in handleCreateInvoice:", e);
    return new Response(JSON.stringify({ message: e.message }), { status: 500 });
  }
}

async function handleTelegramWebhook(req: Request): Promise<Response> {
  const update = await req.json();

  if (update.pre_checkout_query) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/test/answerPreCheckoutQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true,
      }),
    });
  } else if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const { userId, itemId } = JSON.parse(payment.invoice_payload);

    // Insert into Hasura
    // Note: In a real app, use a proper admin secret/client.
    // Here we just log it for simplicity or assume it works.
    // To actually insert, we need a GraphQL mutation.
    // Let's keep it extremely simple: just log for now.
    console.log(`Payment success: User ${userId} bought ${itemId} for ${payment.total_amount}`);

    const HASURA_URL = Deno.env.get("HASURA_GRAPHQL_ENDPOINT");
    const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN");

    if (HASURA_URL && SERVICE_USER_TOKEN) {
      try {
        const mutation = `
          mutation InsertPayment($userId: bigint!, $itemId: uuid!, $amount: Int!) {
            insert_payments_one(object: {user_id: $userId, item_id: $itemId, amount: $amount}) {
              id
            }
          }
        `;

        const res = await fetch(HASURA_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": SERVICE_USER_TOKEN,
          },
          body: JSON.stringify({
            query: mutation,
            variables: {
              userId: userId,
              itemId: itemId,
              amount: payment.total_amount,
            },
          }),
        });

        const json = await res.json();
        if (json.errors) {
          console.error("Hasura Insert Error:", JSON.stringify(json.errors));
        } else {
          console.log("Payment recorded in Hasura:", json.data.insert_payments_one.id);
        }
      } catch (e) {
        console.error("Failed to insert payment:", e);
      }
    } else {
      console.error("Missing HASURA_GRAPHQL_ENDPOINT or SERVICE_USER_TOKEN");
    }
  }

  return new Response("OK");
}

// ===== CONFIG SCANNER =====

interface GameConfig {
  code: string;
  name?: { en: string; ru: string };
  [key: string]: unknown;
}

interface CategoryConfigs {
  [code: string]: GameConfig;
}

// Dynamic storage - categories discovered at runtime
const CONFIGS: Record<string, CategoryConfigs> = {};

// FSM modules storage
const FSM_MODULES: Record<string, Record<string, unknown>> = {};
const ENDPOINTS: Map<string, { category: string; handler: string; module: Record<string, unknown> }> = new Map();

async function scanConfigs() {
  const fsmPath = "./fsm";

  // Scan all category directories in fsm/
  for await (const categoryEntry of Deno.readDir(fsmPath)) {
    if (!categoryEntry.isDirectory) continue;

    const categoryName = categoryEntry.name;
    const categoryPath = `${fsmPath}/${categoryName}`;

    CONFIGS[categoryName] = {};

    // Load FSM.ts if exists
    const fsmFile = `${categoryPath}/FSM.ts`;
    try {
      const module = await import(fsmFile);
      FSM_MODULES[categoryName] = module;

      // Register endpoints from ENDPOINTS export
      if (module.ENDPOINTS) {
        for (const [handlerName, path] of Object.entries(module.ENDPOINTS)) {
          const handler = `handle${handlerName.charAt(0) + handlerName.slice(1).toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
          ENDPOINTS.set(path as string, { category: categoryName, handler, module });
          console.log(`Endpoint: ${path} -> ${categoryName}.${handler}`);
        }
      }
    } catch { /* no FSM.ts */ }

    // Scan all items in category
    for await (const itemEntry of Deno.readDir(categoryPath)) {
      if (!itemEntry.isDirectory) continue;

      const configPath = `${categoryPath}/${itemEntry.name}/config.json`;
      try {
        const content = await Deno.readTextFile(configPath);
        const config = JSON.parse(content) as GameConfig;
        CONFIGS[categoryName][itemEntry.name] = config;
        console.log(`Loaded: ${categoryName}/${itemEntry.name}`);
      } catch { /* skip */ }
    }
  }

  // Log summary
  const summary: Record<string, number> = {};
  for (const [key, value] of Object.entries(CONFIGS)) {
    summary[key] = Object.keys(value).length;
  }
  console.log("Configs loaded:", summary);
  console.log("Endpoints registered:", ENDPOINTS.size);
}

// ===== GAME API HANDLERS =====

function handleGetConfigs(category?: string, code?: string): Response {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  if (!category) {
    // Return all categories with their item codes
    const summary: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(CONFIGS)) {
      summary[key] = Object.keys(value);
    }
    return new Response(JSON.stringify(summary), { headers });
  }

  const catData = CONFIGS[category];
  if (!catData) {
    return new Response(JSON.stringify({ error: "Category not found" }), { status: 404, headers });
  }

  if (!code) {
    return new Response(JSON.stringify(catData), { headers });
  }

  const config = catData[code];
  if (!config) {
    return new Response(JSON.stringify({ error: "Config not found" }), { status: 404, headers });
  }

  return new Response(JSON.stringify(config), { headers });
}

// ===== MAIN SERVER =====

await scanConfigs();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const headers = { "Access-Control-Allow-Origin": "*" };

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { ...headers, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "*" } });
  }

  if (path === "/v1/auth/claims") {
    return await handleAuth(req);
  }

  if (path === "/v1/actions/create_invoice") {
    return await handleCreateInvoice(req);
  }

  if (path === "/v1/webhook/telegram") {
    return await handleTelegramWebhook(req);
  }

  // Game API: GET /api/configs/:category?/:code?
  if (path.startsWith("/api/configs")) {
    const parts = path.split("/").filter(Boolean);
    const category = parts[2];
    const code = parts[3];
    return handleGetConfigs(category, code);
  }

  // List all available endpoints
  if (path === "/api/endpoints") {
    const list = Array.from(ENDPOINTS.entries()).map(([p, e]) => ({ path: p, category: e.category, handler: e.handler }));
    return new Response(JSON.stringify(list), { headers: { ...headers, "Content-Type": "application/json" } });
  }

  // Dynamic FSM endpoints
  const endpoint = ENDPOINTS.get(path);
  if (endpoint) {
    return new Response(JSON.stringify({
      endpoint: path,
      category: endpoint.category,
      handler: endpoint.handler,
      status: "DB layer needed",
      params: Object.fromEntries(url.searchParams)
    }), { headers: { ...headers, "Content-Type": "application/json" } });
  }
  return new Response("Not Found", { status: 404 });
});