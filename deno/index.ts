/**
 * ========================================
 * ARCHITECTURE RULES - DO NOT FORGET!
 * ========================================
 * 
 * 1. Endpoints MUST be defined in FSM files (deno/fsm/<FSM_NAME>/FSM.ts), NOT directly here
 * 2. This file only handles:
 *    - Auth (getHasuraClaims, handleAuth)
 *    - Config loading (scanConfigs, handleGetConfigs)
 *    - Telegram webhooks
 *    - Dynamic routing to FSM endpoints
 * 
 * 3. FSM files (e.g. deno/fsm/crops/FSM.ts) contain:
 *    - ENDPOINTS constant with paths
 *    - Handler functions (handlePlant, handleHarvest, etc.)
 *    - State calculation logic
 *    - Checkpoint generation
 * 
 * 4. Database tables:
 *    - user_stats: ONLY for inventory (silver, item_*, seed_*)
 *    - game_objects: planted crops, factories, etc.
 *    - game_object_params: object parameters (yield, stolen, etc.)
 *    - game_checkpoints: growth stages, wither times, events
 * 
 * 5. HASURA AUTH:
 *    - NEVER use X-Hasura-Admin-Secret in Deno!
 *    - Use SERVICE_USER_TOKEN env variable instead
 *    - Pass initData from frontend for user authentication
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
const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN") || "";

async function hasuraQuery(query: string, variables: Record<string, unknown> = {}, userId?: string) {
  console.log("[HASURA] Query:", query.slice(0, 100), "userId:", userId);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Use Authorization header with SERVICE_USER_TOKEN (not X-Hasura-Admin-Secret!)
  if (SERVICE_USER_TOKEN) {
    headers["Authorization"] = SERVICE_USER_TOKEN;
  }

  // Set role and user-id for row-level security
  if (userId) {
    headers["X-Hasura-Role"] = "user";
    headers["X-Hasura-User-Id"] = userId;
  }

  console.log("[HASURA] Headers:", Object.keys(headers));

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
    return new Response(JSON.stringify({ message: (e as Error).message }), { status: 500 });
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

// ===== CONFIG & MODULE SCANNER =====

import type { HandlerContext, ModuleHook, PendingHook, RegisteredEndpoint, ModuleAPI, DatabaseAPI } from "./fsm/types.ts";

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

// Hook registry - endpoint name -> sorted hooks
const HOOKS_REGISTRY: Map<string, PendingHook[]> = new Map();
const PENDING_HOOKS: Map<string, PendingHook[]> = new Map();

// Endpoint registry - path -> endpoint info
const ENDPOINTS_REGISTRY: Map<string, RegisteredEndpoint> = new Map();

// Module API for FSM modules
const moduleAPI: ModuleAPI = {
  registerEndpoint(name: string, handler: (ctx: HandlerContext) => Promise<Response>, moduleName: string) {
    const path = `/api/${name}`;
    const pendingHooks = PENDING_HOOKS.get(name) || [];
    PENDING_HOOKS.delete(name);

    const endpoint: RegisteredEndpoint = {
      name,
      path,
      handler,
      hooks: [],
      module: moduleName
    };

    ENDPOINTS_REGISTRY.set(name, endpoint);

    // Attach pending hooks (will be sorted later)
    for (const hook of pendingHooks) {
      endpoint.hooks.push(hook);
    }

    console.log(`[MOD] ✓ Endpoint '${name}' from ${moduleName} (${pendingHooks.length} hooks attached)`);
  },

  registerHook(endpointName: string, hook: ModuleHook, moduleName: string) {
    const pending: PendingHook = { hook, moduleName };

    const endpoint = ENDPOINTS_REGISTRY.get(endpointName);
    if (endpoint) {
      endpoint.hooks.push(pending);
      console.log(`[MOD] ✓ Hook → '${endpointName}' from ${moduleName}`);
    } else {
      const queue = PENDING_HOOKS.get(endpointName) || [];
      queue.push(pending);
      PENDING_HOOKS.set(endpointName, queue);
      console.log(`[MOD] ⏳ Hook queued for '${endpointName}' from ${moduleName}`);
    }
  },

  configs: CONFIGS
};

// Topological sort for hooks based on runBefore/runAfter
function sortHooks(hooks: PendingHook[]): PendingHook[] {
  if (hooks.length <= 1) return hooks;

  // Build dependency graph
  const moduleToHook = new Map<string, PendingHook>();
  for (const h of hooks) {
    moduleToHook.set(h.moduleName, h);
  }

  // graph: module -> modules that must come before it
  const graph = new Map<string, Set<string>>();
  for (const h of hooks) {
    graph.set(h.moduleName, new Set());
  }

  for (const h of hooks) {
    // runBefore: ["dog"] means this hook runs BEFORE dog
    // So dog depends on this hook
    for (const target of h.hook.runBefore || []) {
      if (graph.has(target)) {
        graph.get(target)!.add(h.moduleName);
      }
    }

    // runAfter: ["eagle"] means this hook runs AFTER eagle
    // So this hook depends on eagle
    for (const dep of h.hook.runAfter || []) {
      if (graph.has(h.moduleName)) {
        graph.get(h.moduleName)!.add(dep);
      }
    }
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<string, number>();
  for (const [node, deps] of graph) {
    inDegree.set(node, deps.size);
  }

  const queue: string[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) queue.push(node);
  }

  const result: PendingHook[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const hook = moduleToHook.get(node);
    if (hook) result.push(hook);

    // Remove this node from dependencies
    for (const [target, deps] of graph) {
      if (deps.has(node)) {
        deps.delete(node);
        inDegree.set(target, inDegree.get(target)! - 1);
        if (inDegree.get(target) === 0) {
          queue.push(target);
        }
      }
    }
  }

  // If not all hooks sorted (cycle detected), return original order
  if (result.length !== hooks.length) {
    console.warn("[MOD] ⚠️ Cycle detected in hook dependencies, using load order");
    return hooks;
  }

  return result;
}

async function scanConfigs() {
  const memStart = Deno.memoryUsage();
  const timeStart = performance.now();
  const fsmPath = "./fsm";

  // First pass: load all configs
  for await (const categoryEntry of Deno.readDir(fsmPath)) {
    if (!categoryEntry.isDirectory) continue;

    const categoryName = categoryEntry.name;
    const categoryPath = `${fsmPath}/${categoryName}`;

    CONFIGS[categoryName] = {};

    // Scan all items in category for config.json
    try {
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
    } catch { /* category has no subdirs */ }
  }

  // Second pass: load all FSM modules
  for await (const categoryEntry of Deno.readDir(fsmPath)) {
    if (!categoryEntry.isDirectory) continue;

    const categoryName = categoryEntry.name;
    const categoryPath = `${fsmPath}/${categoryName}`;

    // Load category-level FSM.ts (e.g., crops/FSM.ts)
    await tryLoadModule(`${categoryPath}/FSM.ts`, categoryName);

    // Load item-level FSM.ts (e.g., animals/dog/FSM.ts)
    try {
      for await (const itemEntry of Deno.readDir(categoryPath)) {
        if (!itemEntry.isDirectory) continue;
        await tryLoadModule(`${categoryPath}/${itemEntry.name}/FSM.ts`, `${categoryName}/${itemEntry.name}`);
      }
    } catch { /* no subdirs */ }
  }

  // Sort hooks for each endpoint
  for (const [name, endpoint] of ENDPOINTS_REGISTRY) {
    endpoint.hooks = sortHooks(endpoint.hooks);
    console.log(`[MOD] Endpoint '${name}' hooks order: [${endpoint.hooks.map(h => h.moduleName).join(", ")}]`);
  }

  // Warn about orphan hooks
  for (const [name, hooks] of PENDING_HOOKS) {
    console.warn(`[MOD] ⚠️ ${hooks.length} hooks for '${name}' have no endpoint!`);
  }

  // Log summary
  const summary: Record<string, number> = {};
  for (const [key, value] of Object.entries(CONFIGS)) {
    summary[key] = Object.keys(value).length;
  }

  const memEnd = Deno.memoryUsage();
  const timeEnd = performance.now();
  const heapDiff = (memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024;

  console.log("Configs loaded:", summary);
  console.log("Endpoints registered:", ENDPOINTS_REGISTRY.size);
  console.log(`[PERF] Initialization: ${(timeEnd - timeStart).toFixed(2)}ms | Heap Delta: ${heapDiff.toFixed(3)}MB | Current Heap: ${(memEnd.heapUsed / 1024 / 1024).toFixed(2)}MB`);
}

async function tryLoadModule(path: string, name: string) {
  const memStart = Deno.memoryUsage();
  const timeStart = performance.now();

  try {
    const mod = await import(path);

    // Call init if exists
    if (mod.init) {
      mod.init(moduleAPI);
    }

    // Register endpoints from ENDPOINTS export
    if (mod.ENDPOINTS) {
      for (const [key, endpointName] of Object.entries(mod.ENDPOINTS)) {
        const handlerName = `handle${key.charAt(0).toUpperCase()}${key.slice(1).toLowerCase()}`;
        if (mod[handlerName]) {
          moduleAPI.registerEndpoint(endpointName as string, mod[handlerName], name);
        }
      }
    }

    // Register hooks from HOOKS export
    if (mod.HOOKS) {
      for (const [endpoint, hook] of Object.entries(mod.HOOKS)) {
        moduleAPI.registerHook(endpoint, hook as ModuleHook, name);
      }
    }

    const memEnd = Deno.memoryUsage();
    const timeEnd = performance.now();
    const heapDiff = (memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024;

    console.log(`[MOD] Loaded: ${name} | ${(timeEnd - timeStart).toFixed(2)}ms | Heap Delta: ${heapDiff.toFixed(3)}MB`);
  } catch {
    // No module - OK
  }
}

// Database API for handlers
function createDbAPI(userId: string): DatabaseAPI {
  return {
    async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
      // For now, use hasuraQuery with raw SQL via Hasura's run_sql
      // In production, this would be a proper parameterized query
      console.log("[DB] Query:", sql.slice(0, 50), params);

      // Convert to GraphQL - this is a simplified version
      // Real implementation would need proper SQL to GraphQL mapping
      const result = await hasuraQuery(`
        query {
          game_objects(limit: 10) { id user_id type_code }
        }
      `, {}, userId);

      return result?.game_objects || [];
    },

    async getObject(id: number) {
      const result = await hasuraQuery(`
        query($id: Int!) {
          game_objects_by_pk(id: $id) {
            id user_id type_code created_at x y
          }
        }
      `, { id }, userId);
      return result?.game_objects_by_pk || null;
    },

    async getPlotByCrop(cropId: number) {
      // Get plot that contains this crop
      const result = await hasuraQuery(`
        query($cropId: Int!) {
          game_objects(where: {id: {_eq: $cropId}}) {
            id user_id x y
          }
        }
      `, { cropId }, userId);

      const crop = result?.game_objects?.[0];
      if (!crop) return null;

      // For now, the crop's x coordinate is the plot index
      // In a real implementation, we'd look up the plot by position
      return {
        id: crop.x,
        user_id: crop.user_id,
        state: "planted",
        crop_id: cropId
      };
    }
  };
}

// Execute endpoint with hooks
async function executeWithHooks(
  endpoint: RegisteredEndpoint,
  req: Request,
  url: URL,
  userId: string
): Promise<Response> {
  const memStart = Deno.memoryUsage();
  const timeStart = performance.now();

  const ctx: HandlerContext = {
    req,
    url,
    userId,
    configs: CONFIGS,
    db: createDbAPI(userId)
  };

  console.log(`[FSM] Executing ${endpoint.name} for user ${userId}`);

  try {
    // Run BEFORE hooks
    for (const { hook } of endpoint.hooks) {
      if (hook.before) {
        const result = await hook.before(ctx);
        if (result) return result;  // Hook blocked request
      }
    }

    // Run main handler
    let response = await endpoint.handler(ctx);

    // Run AFTER hooks
    for (const { hook } of endpoint.hooks) {
      if (hook.after) {
        response = await hook.after(ctx, response);
      }
    }

    return response;
  } finally {
    const memEnd = Deno.memoryUsage();
    const timeEnd = performance.now();
    const heapDiff = (memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024;
    const duration = timeEnd - timeStart;

    console.log(`[PERF] ${endpoint.name}: ${duration.toFixed(2)}ms | Heap Delta: ${heapDiff.toFixed(3)}MB | Current Heap: ${(memEnd.heapUsed / 1024 / 1024).toFixed(2)}MB`);
  }
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

// Helper to add CORS headers to any response
function addCors(response: Response): Response {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Clone headers and add CORS
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

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
    return addCors(await handleAuth(req));
  }

  if (path === "/v1/actions/create_invoice") {
    return addCors(await handleCreateInvoice(req));
  }

  if (path === "/v1/webhook/telegram") {
    return addCors(await handleTelegramWebhook(req));
  }

  // Game API: GET /api/configs/:category?/:code?
  if (path.startsWith("/api/configs")) {
    const parts = path.split("/").filter(Boolean);
    const category = parts[2];
    const code = parts[3];
    return addCors(handleGetConfigs(category, code));
  }

  // NOTE: Crop endpoints (/api/plant, /api/harvest) are now loaded dynamically from crops/FSM.ts

  // List all available endpoints
  if (path === "/api/endpoints") {
    const list = Array.from(ENDPOINTS_REGISTRY.entries()).map(([name, e]) => ({
      name,
      path: e.path,
      module: e.module,
      hooks: e.hooks.map(h => h.moduleName)
    }));
    return new Response(JSON.stringify(list), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Dynamic FSM endpoints with hooks
  for (const [name, endpoint] of ENDPOINTS_REGISTRY) {
    if (endpoint.path === path) {
      try {
        const claims = await getHasuraClaims(req.headers.get("authorization"));
        const userId = claims?.["X-Hasura-User-Id"] || "0";
        return addCors(await executeWithHooks(endpoint, req, url, userId));
      } catch (e) {
        console.error(`[FSM] Error in ${name}:`, e);
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
});