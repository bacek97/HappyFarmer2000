import type { ModuleAPI, HandlerContext } from "../types.ts";

export const ENDPOINTS = {
    LIST: 'factories',
    START: 'start_production',
    COLLECT: 'collect_production'
} as const;

export function init(_api: ModuleAPI) {
    console.log("[FACTORIES] 🏭 Factories module initialized");
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

        const json = await res.json();
        if (json.errors) {
            console.error("[HASURA] GraphQL Errors:", JSON.stringify(json.errors, null, 2));
            throw new Error(json.errors[0]?.message || "GraphQL Error");
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
                game_objects(where: {user_id: {_eq: "${ctx.userId}"}, type_code: {_like: "factory_%"}}) {
                    id
                    type_code
                    params {
                        key
                        value
                    }
                    checkpoints {
                        action
                        time_offset
                        deadline
                        done_at
                    }
                }
            }
        `, {}, ctx.userId);

        const factories = (result.game_objects || []).map((obj: any) => {
            const params: Record<string, string> = {};
            obj.params.forEach((p: any) => params[p.key] = p.value);

            const state = getFactoryState(obj.checkpoints, params);

            return {
                ...obj,
                calculated_state: state
            };
        });

        return new Response(JSON.stringify(factories), { headers });
    } catch (e) {
        console.error("[FACTORIES] handleList error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

function getFactoryState(checkpoints: any[], params: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000);

    const readyCheckpoint = checkpoints.find(c => c.action === 'ready' && !c.done_at);
    if (readyCheckpoint) {
        const readyAt = parseInt(params.ready_at || "0");
        if (now >= readyAt) {
            return { stage: 'ready', recipe_code: params.recipe_code };
        } else {
            return { stage: 'processing', recipe_code: params.recipe_code, ready_at: readyAt };
        }
    }

    return { stage: 'idle' };
}

export async function handleStart(ctx: HandlerContext): Promise<Response> {
    const headers = { ...corsHeaders, "Content-Type": "application/json" };

    try {
        if (ctx.req.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers });
        }

        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const body = await ctx.req.json();
        const { factoryCode, recipeCode } = body;

        const factoryCfg = ctx.configs?.factories?.[factoryCode] as any;
        if (!factoryCfg) {
            return new Response(JSON.stringify({ error: "Factory config not found" }), { status: 404, headers });
        }

        const recipe = factoryCfg.recipes?.find((r: any) => r.code === recipeCode);
        if (!recipe) {
            return new Response(JSON.stringify({ error: "Recipe not found" }), { status: 404, headers });
        }

        // 1. Check and deduct ingredients
        const mutations = [];
        const variables: Record<string, any> = {};

        for (let i = 0; i < (recipe.inputs || []).length; i++) {
            const input = recipe.inputs[i];
            const itemKey = `item_${input.item}`;

            // Get current count
            const invCheck = await hasuraQuery(`
                query {
                    user_stats(where: {user_id: {_eq: "${ctx.userId}"}, key: {_eq: "${itemKey}"}}) {
                        value
                    }
                }
            `, {}, ctx.userId);

            const currentCount = invCheck?.user_stats?.[0]?.value || 0;
            if (currentCount < input.count) {
                return new Response(JSON.stringify({ error: `Not enough ${input.item}` }), { status: 400, headers });
            }

            mutations.push(`
                update_${i}: insert_user_stats_one(
                    object: {user_id: "${ctx.userId}", key: "${itemKey}", value: ${currentCount - input.count}},
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }
            `);
        }

        // 2. Find or create factory object
        const factoryObjCheck = await hasuraQuery(`
            query {
                game_objects(where: {user_id: {_eq: "${ctx.userId}"}, type_code: {_eq: "factory_${factoryCode}"}}) {
                    id
                }
            }
        `, {}, ctx.userId);

        let factoryId = factoryObjCheck?.game_objects?.[0]?.id;
        if (!factoryId) {
            const newFactory = await hasuraQuery(`
                mutation {
                    insert_game_objects_one(object: {
                        user_id: "${ctx.userId}",
                        type_code: "factory_${factoryCode}",
                        x: ${factoryCfg.position?.x || 0},
                        y: ${factoryCfg.position?.y || 0}
                    }) { id }
                }
            `, {}, ctx.userId);
            factoryId = newFactory.insert_game_objects_one.id;
        }

        // 3. Set production params
        const productionTime = recipe.time || 0;
        const readyAt = Math.floor(Date.now() / 1000) + productionTime;

        await hasuraQuery(`
            mutation StartProduction($factoryId: Int!, $readyAt: String!, $recipeCode: String!, $timeOffset: Int!, $deadline: Int!) {
                ${mutations.join('\n')}
                
                insert_game_object_params(
                    objects: [
                        {object_id: $factoryId, key: "ready_at", value: $readyAt},
                        {object_id: $factoryId, key: "recipe_code", value: $recipeCode},
                        {object_id: $factoryId, key: "stage", value: "processing"}
                    ],
                    on_conflict: {constraint: game_object_params_pkey, update_columns: [value]}
                ) { affected_rows }

                insert_game_checkpoints_one(object: {
                    object_id: $factoryId,
                    action: "ready",
                    time_offset: $timeOffset,
                    deadline: $deadline
                }) { id }
            }
        `, {
            factoryId,
            readyAt: String(readyAt),
            recipeCode,
            timeOffset: productionTime,
            deadline: readyAt + 86400
        }, ctx.userId);

        return new Response(JSON.stringify({ success: true, ready_at: readyAt }), { headers });
    } catch (e) {
        console.error("[FACTORIES] handleStart error:", e);
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
        const { factoryCode } = body;

        // 1. Get factory state
        const factoryResult = await hasuraQuery(`
            query {
                game_objects(where: {user_id: {_eq: "${ctx.userId}"}, type_code: {_eq: "factory_${factoryCode}"}}) {
                    id
                    params {
                        key
                        value
                    }
                }
            }
        `, {}, ctx.userId);

        const factory = factoryResult?.game_objects?.[0];
        if (!factory) {
            console.log(`[FACTORIES] Collect: Factory factory_${factoryCode} not found for user ${ctx.userId}`);
            return new Response(JSON.stringify({ error: "Factory not found" }), { status: 404, headers });
        }

        const params: Record<string, string> = {};
        factory.params.forEach((p: any) => params[p.key] = p.value);

        console.log(`[FACTORIES] Collect: Factory ${factoryCode} params:`, JSON.stringify(params));

        const readyAt = parseInt(params.ready_at || "0");
        const recipeCode = params.recipe_code;

        console.log(`[FACTORIES] Collect: readyAt=${readyAt}, recipeCode=${recipeCode}, now=${Math.floor(Date.now() / 1000)}`);

        if (!recipeCode || readyAt === 0) {
            console.log(`[FACTORIES] Collect: Nothing to collect - recipeCode=${recipeCode}, readyAt=${readyAt}`);
            return new Response(JSON.stringify({ error: "Nothing to collect", debug: { params, recipeCode, readyAt } }), { status: 400, headers });
        }

        if (Date.now() / 1000 < readyAt) {
            const remaining = readyAt - Math.floor(Date.now() / 1000);
            console.log(`[FACTORIES] Collect: Not ready yet, ${remaining}s remaining`);
            return new Response(JSON.stringify({ error: "Production not finished yet", remaining }), { status: 400, headers });
        }

        // 2. Get recipe config
        const factoryCfg = ctx.configs?.factories?.[factoryCode] as any;
        const recipe = factoryCfg?.recipes?.find((r: any) => r.code === recipeCode);
        if (!recipe) {
            throw new Error("Recipe config not found for collection");
        }

        // 3. Add products and reset factory
        const mutations = [];
        for (let i = 0; i < (recipe.products || []).length; i++) {
            const product = recipe.products[i];
            const itemKey = `item_${product.code}`;

            const invCheck = await hasuraQuery(`
                query {
                    user_stats(where: {user_id: {_eq: "${ctx.userId}"}, key: {_eq: "${itemKey}"}}) {
                        value
                    }
                }
            `, {}, ctx.userId);

            const currentCount = invCheck?.user_stats?.[0]?.value || 0;
            mutations.push(`
                prod_${i}: insert_user_stats_one(
                    object: {user_id: "${ctx.userId}", key: "${itemKey}", value: ${currentCount + product.count}},
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }
            `);
        }

        // Add experience
        const expCheck = await hasuraQuery(`
            query {
                user_stats(where: {user_id: {_eq: "${ctx.userId}"}, key: {_eq: "exp"}}) {
                    value
                }
            }
        `, {}, ctx.userId);
        const currentExp = expCheck?.user_stats?.[0]?.value || 0;
        mutations.push(`
            exp: insert_user_stats_one(
                object: {user_id: "${ctx.userId}", key: "exp", value: ${currentExp + (recipe.exp || 10)}},
                on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
            ) { key }
        `);

        await hasuraQuery(`
            mutation CollectProduction($factoryId: Int!) {
                ${mutations.join('\n')}
                
                delete_game_object_params(where: {object_id: {_eq: $factoryId}, key: {_in: ["ready_at", "recipe_code", "stage"]}}) {
                    affected_rows
                }

                delete_game_checkpoints(where: {object_id: {_eq: $factoryId}, action: {_eq: "ready"}}) {
                    affected_rows
                }
            }
        `, { factoryId: factory.id }, ctx.userId);

        return new Response(JSON.stringify({ success: true, recipe: recipeCode }), { headers });
    } catch (e) {
        console.error("[FACTORIES] handleCollect error:", e);
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}
