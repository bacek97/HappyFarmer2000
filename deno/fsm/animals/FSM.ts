// AnimalsFSM - Manage farm animals
import type { ModuleAPI, HandlerContext } from "../../types.ts";

export const ENDPOINTS = {
    LIST: 'animals',
    BUY: 'buy_animal',
    FEED: 'feed_animal',
    COLLECT: 'collect_animal'
} as const;

let CONFIGS: Record<string, Record<string, any>> = {};

export function init(api: ModuleAPI) {
    CONFIGS = api.configs;
}

// ===== HASURA HELPER =====
const HASURA_URL = Deno.env.get("HASURA_GRAPHQL_ENDPOINT") || "https://happy-farmer-2000.hasura.app/v1/graphql";
const SERVICE_USER_TOKEN = Deno.env.get("SERVICE_USER_TOKEN") || "";

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

    const res = await fetch(HASURA_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
    });

    const json = await res.json();
    if (json.errors) {
        console.error("[HASURA] Error Response:", JSON.stringify(json.errors, null, 2));
        throw new Error(json.errors[0]?.message || "GraphQL Error");
    }
    return json.data;
}

export async function handleList(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const result = await hasuraQuery(`
            query($userId: bigint!) {
                game_objects(where: {user_id: {_eq: $userId}, type_code: {_like: "animal_%"}}) {
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
        `, { userId: ctx.userId }, ctx.userId);

        return new Response(JSON.stringify(result.game_objects || []), { headers });
    } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleBuy(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const { code } = await ctx.req.json();
        const animalCfg = CONFIGS.animals?.[code];

        if (!animalCfg) {
            return new Response(JSON.stringify({ error: "Animal not found" }), { status: 404, headers });
        }

        // 1. Get current silver
        const silverCheck = await hasuraQuery(`
            query($userId: bigint!) {
                user_stats(where: {user_id: {_eq: $userId}, key: {_eq: "silver"}}) {
                    value
                }
            }
        `, { userId: ctx.userId }, ctx.userId);

        const currentSilver = silverCheck?.user_stats?.[0]?.value || 0;
        const price = animalCfg.buy_silver || 0;

        if (currentSilver < price) {
            return new Response(JSON.stringify({ error: "Not enough silver" }), { status: 400, headers });
        }

        // 2. Create animal and deduct silver
        const result = await hasuraQuery(`
            mutation BuyAnimal($userId: bigint!, $typeCode: String!, $newSilver: Int!, $x: Int!, $y: Int!) {
                update_user_stats_by_pk(
                    pk_columns: {user_id: $userId, key: "silver"},
                    _set: {value: $newSilver}
                ) { value }

                insert_game_objects_one(object: {
                    user_id: $userId,
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
            userId: ctx.userId,
            typeCode: `animal_${code}`,
            newSilver: currentSilver - price,
            x: animalCfg.position?.x || 0,
            y: animalCfg.position?.y || 0
        }, ctx.userId);

        return new Response(JSON.stringify({ success: true, id: result.insert_game_objects_one.id }), { headers });
    } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleFeed(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    try {
        const { id } = await ctx.req.json();
        const animalId = parseInt(id);

        // 1. Get animal config and current state
        const animal = await ctx.db.getObject(animalId);
        if (!animal) return new Response(JSON.stringify({ error: "Animal not found" }), { status: 404, headers });

        const code = animal.type_code.replace('animal_', '');
        const animalCfg = CONFIGS.animals?.[code];

        // 2. Update stage to fed and set checkpoint
        const readyAt = Math.floor(Date.now() / 1000) + (animalCfg.feed_interval || 3600);

        await hasuraQuery(`
            mutation FeedAnimal($id: Int!, $readyAt: String!) {
                insert_game_object_params(
                    objects: [{object_id: $id, key: "stage", value: "fed"}, {object_id: $id, key: "ready_at", value: $readyAt}],
                    on_conflict: {constraint: game_object_params_pkey, update_columns: [value]}
                ) { affected_rows }
                
                insert_game_checkpoints_one(object: {
                    object_id: $id,
                    action: "ready",
                    time_offset: ${animalCfg.feed_interval || 3600},
                    deadline: ${readyAt + 3600}
                }) { id }
            }
        `, { id: animalId, readyAt: String(readyAt) }, ctx.userId);

        return new Response(JSON.stringify({ success: true, ready_at: readyAt }), { headers });
    } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleCollect(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    try {
        const { id } = await ctx.req.json();
        const animalId = parseInt(id);

        // 1. Get animal and its products
        const animal = await ctx.db.getObject(animalId);
        if (!animal) return new Response(JSON.stringify({ error: "Animal not found" }), { status: 404, headers });

        const code = animal.type_code.replace('animal_', '');
        const animalCfg = CONFIGS.animals?.[code];
        const products = animalCfg.products || [];

        // 2. Update stage to hungry and add products
        // Simplified: just add first product for now
        const product = products[0];
        if (!product) return new Response(JSON.stringify({ error: "No products" }), { status: 400, headers });

        const itemKey = `item_${product.code}`;

        // Get current item count
        const invCheck = await hasuraQuery(`
            query($userId: bigint!, $key: String!) {
                user_stats(where: {user_id: {_eq: $userId}, key: {_eq: $key}}) {
                    value
                }
            }
        `, { userId: ctx.userId, key: itemKey }, ctx.userId);

        const currentCount = invCheck?.user_stats?.[0]?.value || 0;

        await hasuraQuery(`
            mutation CollectProduct($userId: bigint!, $id: Int!, $itemKey: String!, $newCount: Int!) {
                insert_user_stats_one(
                    object: {user_id: $userId, key: $itemKey, value: $newCount},
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }

                insert_game_object_params(
                    objects: [{object_id: $id, key: "stage", value: "hungry"}],
                    on_conflict: {constraint: game_object_params_pkey, update_columns: [value]}
                ) { affected_rows }
            }
        `, {
            userId: ctx.userId,
            id: animalId,
            itemKey,
            newCount: currentCount + (product.count || 1)
        }, ctx.userId);

        return new Response(JSON.stringify({ success: true, product: product.code, count: product.count }), { headers });
    } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}
