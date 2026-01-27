// AnimalsFSM - Manage farm animals
import type { ModuleAPI, HandlerContext } from "../types.ts";

export const ENDPOINTS = {
    LIST: 'animals',
    BUY: 'buy_animal',
    FEED: 'feed_animal',
    COLLECT: 'collect_animal'
} as const;

export function init(_api: ModuleAPI) {
    console.log("[ANIMALS] 🐄 Animals module initialized");
}

// ===== HASURA HELPER =====
const HASURA_URL = Deno.env.get("HASURA_GRAPHQL_ENDPOINT") || "https://happy-farmer-2000.hasura.app/v1/graphql";
const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN") || "";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function hasuraQuery(query: string, variables: Record<string, unknown> = {}, userId?: string) {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (SERVICE_USER_TOKEN) {
        headers["Authorization"] = SERVICE_USER_TOKEN;
    }

    if (userId) {
        headers["X-Hasura-Role"] = "user";
        headers["X-Hasura-User-Id"] = userId;
    }

    try {
        const res = await fetch(HASURA_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables }),
        });

        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            console.error("[HASURA] Non-JSON response:", text);
            throw new Error(`Hasura returned non-JSON response (status ${res.status})`);
        }

        if (json.errors) {
            console.error("[HASURA] GraphQL Errors:", JSON.stringify(json.errors, null, 2));
            const errMsg = json.errors[0]?.message || "GraphQL Error";
            const errCode = json.errors[0]?.extensions?.code || "unknown";
            throw new Error(`[Hasura ${errCode}] ${errMsg}`);
        }
        return json.data;
    } catch (e) {
        console.error("[HASURA] Fetch error:", e);
        throw e;
    }
}

export async function handleList(ctx: HandlerContext): Promise<Response> {
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const result = await hasuraQuery(`
            query {
                game_objects(where: {user_id: {_eq: "${ctx.userId}"}, type_code: {_like: "animal_%"}}) {
                    id
                    type_code
                    x
                    y
                    params {
                        key
                        value
                    }
                }
            }
        `, {}, ctx.userId);

        return new Response(JSON.stringify(result.game_objects || []), { headers });
    } catch (e) {
        console.error("[ANIMALS] handleList error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleBuy(ctx: HandlerContext): Promise<Response> {
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {
        console.log(`[ANIMALS] handleBuy | Method: ${ctx.req.method} | User: ${ctx.userId} | Headers: ${JSON.stringify(Object.fromEntries(ctx.req.headers.entries()))}`);
        if (ctx.req.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers });
        }

        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const body = await ctx.req.json();
        const { code } = body;
        console.log(`[ANIMALS] handleBuy | User: ${ctx.userId} | Animal: ${code}`);

        const animalsConfig = ctx.configs?.animals;
        if (!animalsConfig) {
            throw new Error("Animals configuration not found on server");
        }

        const animalCfg = animalsConfig[code] as any;
        if (!animalCfg) {
            return new Response(JSON.stringify({ error: `Animal config not found for: ${code}` }), { status: 404, headers });
        }

        // 1. Get current silver
        const silverCheck = await hasuraQuery(`
            query {
                user_stats(where: {user_id: {_eq: "${ctx.userId}"}, key: {_eq: "silver"}}) {
                    value
                }
            }
        `, {}, ctx.userId);

        const currentSilver = silverCheck?.user_stats?.[0]?.value || 0;
        const price = animalCfg.buy_silver || 0;

        if (currentSilver < price) {
            return new Response(JSON.stringify({ error: "Not enough silver", current: currentSilver, price }), { status: 400, headers });
        }

        // 2. Create animal and deduct silver
        const result = await hasuraQuery(`
            mutation BuyAnimal($typeCode: String!, $newSilver: Int!, $x: Int!, $y: Int!) {
                insert_user_stats_one(
                    object: {user_id: "${ctx.userId}", key: "silver", value: $newSilver},
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }

                insert_game_objects_one(object: {
                    user_id: "${ctx.userId}",
                    type_code: $typeCode,
                    x: $x,
                    y: $y,
                    params: {
                        data: [
                            { key: "stage", value: "hungry" }
                        ]
                    }
                }) {
                    id
                }
            }
        `, {
            typeCode: `animal_${code}`,
            newSilver: currentSilver - price,
            x: animalCfg.position?.x || 0,
            y: animalCfg.position?.y || 0
        }, ctx.userId);

        if (!result?.insert_game_objects_one) {
            throw new Error("Failed to create animal object - mutation returned no data");
        }

        return new Response(JSON.stringify({ success: true, id: result.insert_game_objects_one.id }), { headers });
    } catch (e) {
        console.error("[ANIMALS] handleBuy error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleFeed(ctx: HandlerContext): Promise<Response> {
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {
        if (ctx.req.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers });
        }

        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const body = await ctx.req.json();
        const { id } = body;
        const animalId = parseInt(id);

        // 1. Get animal config and current state
        const animal = await ctx.db.getObject(animalId);
        if (!animal) {
            return new Response(JSON.stringify({ error: "Animal not found" }), { status: 404, headers });
        }

        const code = animal.type_code.replace('animal_', '');
        const animalCfg = ctx.configs?.animals?.[code] as any;
        if (!animalCfg) {
            return new Response(JSON.stringify({ error: "Animal config not found" }), { status: 404, headers });
        }

        // 2. Update stage to fed and set checkpoint
        const feedInterval = animalCfg.feed_interval || 3600;
        const readyAt = Math.floor(Date.now() / 1000) + feedInterval;

        await hasuraQuery(`
            mutation FeedAnimal($id: Int!, $readyAt: String!, $timeOffset: Int!, $deadline: Int!) {
                insert_game_object_params(
                    objects: [{object_id: $id, key: "stage", value: "fed"}, {object_id: $id, key: "ready_at", value: $readyAt}],
                    on_conflict: {constraint: game_object_params_pkey, update_columns: [value]}
                ) { affected_rows }
                
                insert_game_checkpoints_one(object: {
                    object_id: $id,
                    action: "ready",
                    time_offset: $timeOffset,
                    deadline: $deadline
                }) { id }
            }
        `, {
            id: animalId,
            readyAt: String(readyAt),
            timeOffset: feedInterval,
            deadline: readyAt + 3600
        }, ctx.userId);

        return new Response(JSON.stringify({ success: true, ready_at: readyAt }), { headers });
    } catch (e) {
        console.error("[ANIMALS] handleFeed error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleCollect(ctx: HandlerContext): Promise<Response> {
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {
        if (ctx.req.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers });
        }

        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const body = await ctx.req.json();
        const { id } = body;
        const animalId = parseInt(id);

        // 1. Get animal and its products
        const animal = await ctx.db.getObject(animalId);
        if (!animal) {
            return new Response(JSON.stringify({ error: "Animal not found" }), { status: 404, headers });
        }

        const code = animal.type_code.replace('animal_', '');
        const animalCfg = ctx.configs?.animals?.[code] as any;
        if (!animalCfg) {
            return new Response(JSON.stringify({ error: "Animal config not found" }), { status: 404, headers });
        }

        const products = animalCfg.products || [];
        const product = products[0];
        if (!product) {
            return new Response(JSON.stringify({ error: "No products defined for animal" }), { status: 400, headers });
        }

        const itemKey = `item_${product.code}`;

        // Get current item count
        const invCheck = await hasuraQuery(`
            query {
                user_stats(where: {user_id: {_eq: "${ctx.userId}"}, key: {_eq: "${itemKey}"}}) {
                    value
                }
            }
        `, {}, ctx.userId);

        const currentCount = invCheck?.user_stats?.[0]?.value || 0;

        await hasuraQuery(`
            mutation CollectProduct($id: Int!, $newCount: Int!) {
                insert_user_stats_one(
                    object: {user_id: "${ctx.userId}", key: "${itemKey}", value: $newCount},
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }

                insert_game_object_params(
                    objects: [{object_id: $id, key: "stage", value: "hungry"}],
                    on_conflict: {constraint: game_object_params_pkey, update_columns: [value]}
                ) { affected_rows }
            }
        `, {
            id: animalId,
            newCount: currentCount + (product.count || 1)
        }, ctx.userId);

        return new Response(JSON.stringify({ success: true, product: product.code, count: product.count }), { headers });
    } catch (e) {
        console.error("[ANIMALS] handleCollect error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}
