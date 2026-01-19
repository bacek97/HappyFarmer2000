/**
 * ========================================
 * ARCHITECTURE RULES - DO NOT FORGET!
 * ========================================
 * 
 * 1. Endpoints MUST be defined in FSM files (deno/fsm/<FSM_NAME>/FSM.ts), NOT directly here
  * 2. This file only handles:
 * - Auth(getHasuraClaims, handleAuth)
  * - Config loading(scanConfigs, handleGetConfigs)
    * - Telegram webhooks
      * - Dynamic routing to FSM endpoints
        * 
 * 3. FSM files(e.g.deno / fsm / crops / FSM.ts) contain:
 * - ENDPOINTS constant with paths
* - Handler functions(handlePlant, handleHarvest, etc.)
  * - State calculation logic
    * - Checkpoint generation
      * 
 * 4. Database tables:
 * - user_stats: ONLY for inventory(silver, item_ *, seed_ *)
  * - game_objects: planted crops, factories, etc.
 * - game_object_params: object parameters(yield, stolen, etc.)
  * - game_checkpoints: growth stages, wither times, events
    * ========================================
 */

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

// ===== HASURA GRAPHQL HELPER =====
const HASURA_URL = Deno.env.get("HASURA_GRAPHQL_ENDPOINT") || "https://happy-farmer-2000.hasura.app/v1/graphql";
const SERVICE_TOKEN = Deno.env.get("SERVICE_USER_TOKEN") || "";

async function hasuraQuery(query: string, variables: Record<string, unknown> = {}, userId?: string) {
  console.log("[HASURA] Query:", query.slice(0, 100), "userId:", userId);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (userId) {
    headers["X-Hasura-Role"] = "user";
    headers["X-Hasura-User-Id"] = userId;
  } else if (SERVICE_TOKEN) {
    headers["X-Hasura-Admin-Secret"] = SERVICE_TOKEN;
  }

  const res = await fetch(HASURA_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    console.error("Hasura Error:", json.errors);
    throw new Error(json.errors[0]?.message || "GraphQL Error");
  }
  return json.data;
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

// ===== CROP FSM HANDLERS =====
// These use FSM logic from deno/fsm/crops/FSM.ts concepts

interface CropCheckpoint {
  time_offset: number;  // seconds from planting
  action: string;       // stage_seed, stage_sprout, stage_ripe, harvest, water, etc.
  deadline: number | null; // for harvest = wither time
}

function generateCropCheckpoints(config: any): CropCheckpoint[] {
  const checkpoints: CropCheckpoint[] = [];
  let currentTime = 0;
  const stageTimes = config.stage_times || [30, 60, 90];
  const stages = ['stage_seed', 'stage_sprout', 'stage_growing', 'stage_ripe'];

  // Add stage transitions
  for (let i = 0; i < stageTimes.length; i++) {
    currentTime += stageTimes[i];
    checkpoints.push({
      time_offset: currentTime,
      action: stages[i + 1] || 'stage_ripe',
      deadline: null,
    });
  }

  // Add harvest checkpoint with wither deadline
  checkpoints.push({
    time_offset: currentTime,
    action: 'harvest',
    deadline: currentTime + (config.wither_time || 1800),
  });

  // Random events (water, pest)
  if (Math.random() < (config.water_chance || 0.3)) {
    const waterTime = Math.floor(currentTime * 0.5);
    checkpoints.push({
      time_offset: waterTime,
      action: 'water',
      deadline: waterTime + 1800,
    });
  }

  if (Math.random() < (config.pest_chance || 0.1)) {
    const pestTime = Math.floor(currentTime * 0.7);
    checkpoints.push({
      time_offset: pestTime,
      action: 'remove_pest',
      deadline: pestTime + 600,
    });
  }

  return checkpoints;
}

async function handlePlantCrop(req: Request): Promise<Response> {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    const claims = await getHasuraClaims(authHeader);
    if (!claims || claims["X-Hasura-Role"] === "anonymous") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    const userId = claims["X-Hasura-User-Id"];

    const url = new URL(req.url);
    const plotId = parseInt(url.searchParams.get("plot_id") || "0");
    const cropCode = url.searchParams.get("crop") || "";

    console.log("[PLANT] Request:", { userId, plotId, cropCode });

    if (!cropCode || plotId < 0) {
      return new Response(JSON.stringify({ error: "Missing crop or plot_id" }), { status: 400, headers });
    }

    // Get crop config
    console.log("[PLANT] Available crops:", Object.keys(CONFIGS.crops || {}));
    const cropConfig = CONFIGS.crops?.[cropCode];
    if (!cropConfig) {
      console.log("[PLANT] Crop not found:", cropCode);
      return new Response(JSON.stringify({ error: "Unknown crop", available: Object.keys(CONFIGS.crops || {}) }), { status: 404, headers });
    }

    console.log("[PLANT] Crop config found:", cropConfig.name);

    // Check and deduct seeds from user_stats
    const seedKey = `seed_${cropCode}`;
    const seedCheck = await hasuraQuery(`
      query($userId: bigint!, $key: String!) {
        user_stats(where: {user_id: {_eq: $userId}, key: {_eq: $key}}) {
          value
        }
      }
    `, { userId, key: seedKey }, userId);

    const currentSeeds = seedCheck?.user_stats?.[0]?.value || 0;
    if (currentSeeds < 1) {
      return new Response(JSON.stringify({ error: "No seeds" }), { status: 400, headers });
    }

    // Deduct 1 seed
    await hasuraQuery(`
      mutation($userId: bigint!, $key: String!, $value: Int!) {
        insert_user_stats_one(
          object: {user_id: $userId, key: $key, value: $value}
          on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
        ) { key }
      }
    `, { userId, key: seedKey, value: currentSeeds - 1 }, userId);

    // Create game_object
    const objData = await hasuraQuery(`
      mutation($userId: bigint!, $typeCode: String!, $x: Int!) {
        insert_game_objects_one(object: {
          user_id: $userId,
          type_code: $typeCode,
          x: $x,
          y: 0
        }) {
          id
          created_at
        }
      }
    `, { userId, typeCode: `crop_${cropCode}`, x: plotId }, userId);

    const objectId = objData?.insert_game_objects_one?.id;
    const createdAt = objData?.insert_game_objects_one?.created_at;

    if (!objectId) {
      return new Response(JSON.stringify({ error: "Failed to create object" }), { status: 500, headers });
    }

    // Generate and insert checkpoints
    const checkpoints = generateCropCheckpoints(cropConfig);
    const createdTime = new Date(createdAt).getTime();

    for (const cp of checkpoints) {
      await hasuraQuery(`
        mutation($objectId: Int!, $action: String!, $triggerAt: timestamptz!, $deadline: timestamptz) {
          insert_game_checkpoints_one(object: {
            object_id: $objectId,
            action: $action,
            trigger_at: $triggerAt,
            deadline: $deadline
          }) { id }
        }
      `, {
        objectId,
        action: cp.action,
        triggerAt: new Date(createdTime + cp.time_offset * 1000).toISOString(),
        deadline: cp.deadline ? new Date(createdTime + cp.deadline * 1000).toISOString() : null,
      }, userId);
    }

    // Store yield in params
    const yieldRange = cropConfig.products?.[0]?.yield || [2, 4];
    const yieldAmount = Math.floor(Math.random() * (yieldRange[1] - yieldRange[0] + 1)) + yieldRange[0];

    await hasuraQuery(`
      mutation($objectId: Int!, $key: String!, $value: String!) {
        insert_game_object_params_one(object: {object_id: $objectId, key: $key, value: $value}) { object_id }
      }
    `, { objectId, key: "yield", value: String(yieldAmount) }, userId);

    console.log(`[PLANT] User ${userId} planted ${cropCode} on plot ${plotId}, object ${objectId}`);

    return new Response(JSON.stringify({
      success: true,
      objectId,
      cropCode,
      plotId,
      checkpoints: checkpoints.length,
      yield: yieldAmount
    }), { headers });

  } catch (e) {
    console.error("[PLANT] Error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}

async function handleHarvestCrop(req: Request): Promise<Response> {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    const claims = await getHasuraClaims(authHeader);
    if (!claims || claims["X-Hasura-Role"] === "anonymous") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    const userId = claims["X-Hasura-User-Id"];

    const url = new URL(req.url);
    const objectId = parseInt(url.searchParams.get("id") || "0");

    if (!objectId) {
      return new Response(JSON.stringify({ error: "Missing object id" }), { status: 400, headers });
    }

    // Get object and check ownership
    const objData = await hasuraQuery(`
      query($objectId: Int!, $userId: bigint!) {
        game_objects_by_pk(id: $objectId) {
          id
          type_code
          user_id
          created_at
          params { key value }
          checkpoints { action trigger_at deadline done_at }
        }
      }
    `, { objectId, userId }, userId);

    const obj = objData?.game_objects_by_pk;
    if (!obj) {
      return new Response(JSON.stringify({ error: "Object not found" }), { status: 404, headers });
    }

    if (String(obj.user_id) !== userId) {
      return new Response(JSON.stringify({ error: "Not your crop" }), { status: 403, headers });
    }

    // Check if ready to harvest
    const harvestCheckpoint = obj.checkpoints?.find((c: any) => c.action === 'harvest');
    if (!harvestCheckpoint) {
      return new Response(JSON.stringify({ error: "No harvest checkpoint" }), { status: 400, headers });
    }

    const now = Date.now();
    const triggerTime = new Date(harvestCheckpoint.trigger_at).getTime();
    const deadline = harvestCheckpoint.deadline ? new Date(harvestCheckpoint.deadline).getTime() : null;

    if (now < triggerTime) {
      return new Response(JSON.stringify({ error: "Not ready yet" }), { status: 400, headers });
    }

    if (deadline && now > deadline) {
      // Withered - just delete
      await hasuraQuery(`
        mutation($objectId: Int!) {
          delete_game_objects_by_pk(id: $objectId) { id }
        }
      `, { objectId }, userId);
      return new Response(JSON.stringify({ error: "Withered", harvested: 0 }), { headers });
    }

    // Get yield
    const yieldParam = obj.params?.find((p: any) => p.key === 'yield');
    const yieldAmount = parseInt(yieldParam?.value || "2");

    // Get item code from type_code (crop_tomato -> tomato)
    const itemCode = obj.type_code.replace('crop_', '');
    const itemKey = `item_${itemCode}`;

    // Get crop config for exp and sell_silver
    const cropConfig = CONFIGS.crops?.[itemCode];
    const exp = cropConfig?.exp || 5;
    const sellSilver = cropConfig?.products?.[0]?.sell_silver || 10;

    // Add items to inventory
    const currentItems = await hasuraQuery(`
      query($userId: bigint!, $key: String!) {
        user_stats(where: {user_id: {_eq: $userId}, key: {_eq: $key}}) { value }
      }
    `, { userId, key: itemKey }, userId);

    const currentItemCount = currentItems?.user_stats?.[0]?.value || 0;
    await hasuraQuery(`
      mutation($userId: bigint!, $key: String!, $value: Int!) {
        insert_user_stats_one(
          object: {user_id: $userId, key: $key, value: $value}
          on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
        ) { key }
      }
    `, { userId, key: itemKey, value: currentItemCount + yieldAmount }, userId);

    // Add exp
    const currentExp = await hasuraQuery(`
      query($userId: bigint!) {
        user_stats(where: {user_id: {_eq: $userId}, key: {_eq: "exp"}}) { value }
      }
    `, { userId }, userId);
    const expValue = (currentExp?.user_stats?.[0]?.value || 0) + exp;
    await hasuraQuery(`
      mutation($userId: bigint!, $value: Int!) {
        insert_user_stats_one(
          object: {user_id: $userId, key: "exp", value: $value}
          on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
        ) { key }
      }
    `, { userId, value: expValue }, userId);

    // Delete the game object
    await hasuraQuery(`
      mutation($objectId: Int!) {
        delete_game_objects_by_pk(id: $objectId) { id }
      }
    `, { objectId }, userId);

    console.log(`[HARVEST] User ${userId} harvested ${itemCode} x${yieldAmount}`);

    return new Response(JSON.stringify({
      success: true,
      item: itemCode,
      harvested: yieldAmount,
      exp: exp
    }), { headers });

  } catch (e) {
    console.error("[HARVEST] Error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}

// ===== MAIN SERVER =====

await scanConfigs();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS headers for all responses
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
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

  // Crop FSM API endpoints
  if (path === "/api/plant") {
    return await handlePlantCrop(req);
  }

  if (path === "/api/harvest") {
    return await handleHarvestCrop(req);
  }

  // List all available endpoints
  if (path === "/api/endpoints") {
    const list = Array.from(ENDPOINTS.entries()).map(([p, e]) => ({ path: p, category: e.category, handler: e.handler }));
    return new Response(JSON.stringify(list), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  return new Response("Not Found", { status: 404 });
});