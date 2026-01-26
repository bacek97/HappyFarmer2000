// CropFSM - Конечный автомат для культур
// ========================================

import type { ModuleAPI, HandlerContext } from "../types.ts";

// ENDPOINTS - for documentation only, actual registration in init()
export const ENDPOINTS = {
    PLANT: 'plant',            // ?plot_id=1&crop=tomato&x=1&y=2
    HARVEST: 'harvest',        // ?id=1
    WATER: 'water',            // ?id=1
    REMOVE_PEST: 'remove_pest', // ?id=1
    STEAL: 'steal',            // ?id=1
    THROW_PEST: 'throw_pest'   // ?id=1
} as const;

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
        console.error("[HASURA] Query:", query);
        console.error("[HASURA] Variables:", JSON.stringify(variables, null, 2));
        throw new Error(json.errors[0]?.message || "GraphQL Error");
    }
    return json.data;
}

// ===== MODULE INIT =====
let CONFIGS: Record<string, Record<string, unknown>> = {};

export function init(api: ModuleAPI) {
    CONFIGS = api.configs;
}

// ===== HTTP ENDPOINT HANDLERS =====

export async function handlePlant(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const plotId = parseInt(ctx.url.searchParams.get("plot_id") || "0");
        const cropCode = ctx.url.searchParams.get("crop") || "";

        console.log("[PLANT] Request:", { userId: ctx.userId, plotId, cropCode });

        if (!cropCode || plotId < 0) {
            return new Response(JSON.stringify({ error: "Missing crop or plot_id" }), { status: 400, headers });
        }

        // Get crop config
        const cropConfig = CONFIGS.crops?.[cropCode] as CropConfig | undefined;
        if (!cropConfig) {
            return new Response(JSON.stringify({ error: "Unknown crop", available: Object.keys(CONFIGS.crops || {}) }), { status: 404, headers });
        }

        // Generate checkpoints and yield BEFORE queries
        const checkpoints = generateCropCheckpoints(cropConfig);
        const yieldAmount = generateYield(cropConfig);
        const seedKey = `seed_${cropCode}`;

        // REQUEST 1: Get current seeds count
        const seedCheck = await hasuraQuery(`
            query($userId: bigint!, $key: String!) {
                user_stats(where: {user_id: {_eq: $userId}, key: {_eq: $key}}) {
                    value
                }
            }
        `, { userId: ctx.userId, key: seedKey }, ctx.userId);

        const currentSeeds = seedCheck?.user_stats?.[0]?.value || 0;
        if (currentSeeds < 1) {
            return new Response(JSON.stringify({ error: "No seeds" }), { status: 400, headers });
        }

        // REQUEST 2: Single mutation with nested inserts
        // - Update seeds
        // - Create game_object with checkpoints and params
        const checkpointsData = checkpoints.map(cp => ({
            action: cp.action,
            time_offset: cp.time_offset,
            deadline: cp.deadline || (cp.time_offset + 1800)
        }));

        const paramsData = [
            { key: "yield", value: String(yieldAmount) }
        ];

        const result = await hasuraQuery(`
            mutation PlantCrop(
                $seedKey: String!, 
                $newSeedCount: Int!,
                $typeCode: String!, 
                $x: Int!,
                $checkpoints: [game_checkpoints_insert_input!]!,
                $params: [game_object_params_insert_input!]!
            ) {
                update_user_stats_by_pk(
                    pk_columns: {user_id: "${ctx.userId}", key: $seedKey}, 
                    _set: {value: $newSeedCount}
                ) {
                    value
                }
                
                insert_game_objects_one(object: {
                    type_code: $typeCode,
                    x: $x,
                    y: 0,
                    checkpoints: { data: $checkpoints },
                    params: { data: $params }
                }) {
                    id
                    created_at
                }
            }
        `, {
            seedKey,
            newSeedCount: currentSeeds - 1,
            typeCode: `crop_${cropCode}`,
            x: plotId,
            checkpoints: checkpointsData,
            params: paramsData
        }, ctx.userId);

        const objectId = result?.insert_game_objects_one?.id;

        if (!objectId) {
            return new Response(JSON.stringify({ error: "Failed to create object" }), { status: 500, headers });
        }

        console.log(`[PLANT] User ${ctx.userId} planted ${cropCode} on plot ${plotId}, object ${objectId} (2 requests)`);

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
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}

export async function handleHarvest(ctx: HandlerContext): Promise<Response> {
    const headers = { "Content-Type": "application/json" };

    try {
        if (ctx.userId === "0") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
        }

        const objectId = parseInt(ctx.url.searchParams.get("id") || "0");

        if (!objectId) {
            return new Response(JSON.stringify({ error: "Missing object id" }), { status: 400, headers });
        }

        // REQUEST 1: Get object + user stats in one query
        const data = await hasuraQuery(`
            query GetHarvestData($objectId: Int!, $userId: bigint!) {
                game_objects_by_pk(id: $objectId) {
                    id
                    type_code
                    user_id
                    created_at
                    params { key value }
                    checkpoints { action time_offset deadline done_at }
                }
                user_stats(where: {user_id: {_eq: $userId}}) {
                    key
                    value
                }
            }
        `, { objectId, userId: ctx.userId }, ctx.userId);

        const obj = data?.game_objects_by_pk;
        if (!obj) {
            return new Response(JSON.stringify({ error: "Object not found" }), { status: 404, headers });
        }

        if (String(obj.user_id) !== ctx.userId) {
            return new Response(JSON.stringify({ error: "Not your crop" }), { status: 403, headers });
        }

        // Check if ready to harvest
        const harvestCheckpoint = obj.checkpoints?.find((c: Checkpoint) => c.action === 'harvest');
        if (!harvestCheckpoint) {
            return new Response(JSON.stringify({ error: "No harvest checkpoint" }), { status: 400, headers });
        }

        const now = Date.now();
        const createdAtMs = new Date(obj.created_at).getTime();
        const triggerTimeMs = createdAtMs + (harvestCheckpoint.time_offset * 1000);
        const deadlineMs = createdAtMs + (harvestCheckpoint.deadline * 1000);

        if (now < triggerTimeMs) {
            return new Response(JSON.stringify({ error: "Not ready yet" }), { status: 400, headers });
        }

        if (now > deadlineMs) {
            // Withered - just delete
            await hasuraQuery(`
                mutation($objectId: Int!) {
                    delete_game_objects_by_pk(id: $objectId) { id }
                }
            `, { objectId }, ctx.userId);
            return new Response(JSON.stringify({ error: "Withered", harvested: 0 }), { headers });
        }

        // Get yield from object params
        const yieldParam = obj.params?.find((p: { key: string; value: string }) => p.key === 'yield');
        const yieldAmount = parseInt(yieldParam?.value || "2");

        // Get item code from type_code (crop_tomato -> tomato)
        const itemCode = obj.type_code.replace('crop_', '');
        const itemKey = `item_${itemCode}`;

        // Get crop config for exp
        const cropConfig = CONFIGS.crops?.[itemCode] as CropConfig | undefined;
        const exp = cropConfig?.exp || 5;

        // Get current values from already-fetched user_stats
        const userStats = data?.user_stats || [];
        const currentItemCount = userStats.find((s: { key: string; value: number }) => s.key === itemKey)?.value || 0;
        const currentExp = userStats.find((s: { key: string; value: number }) => s.key === "exp")?.value || 0;

        // REQUEST 2: Single mutation - update items, exp, and delete object
        console.log(`[HARVEST] Completing harvest for user ${ctx.userId}, object ${objectId}`);

        await hasuraQuery(`
            mutation CompleteHarvest(
                $userId: bigint!,
                $itemKey: String!, 
                $newItemCount: Int!,
                $newExp: Int!,
                $objectId: Int!
            ) {
                update_items: insert_user_stats_one(
                    object: {user_id: $userId, key: $itemKey, value: $newItemCount}
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }
                
                update_exp: insert_user_stats_one(
                    object: {user_id: $userId, key: "exp", value: $newExp}
                    on_conflict: {constraint: user_stats_pkey, update_columns: [value]}
                ) { key }
                
                delete_game_objects_by_pk(id: $objectId) { id }
            }
        `, {
            userId: ctx.userId,
            itemKey,
            newItemCount: currentItemCount + yieldAmount,
            newExp: currentExp + exp,
            objectId
        }, ctx.userId);

        console.log(`[HARVEST] User ${ctx.userId} harvested ${itemCode} x${yieldAmount} (2 requests)`);

        return new Response(JSON.stringify({
            success: true,
            item: itemCode,
            harvested: yieldAmount,
            exp: exp
        }), { headers });

    } catch (e) {
        console.error("[HARVEST] Error details:", e);
        return new Response(JSON.stringify({ error: (e as Error).message || "Internal Server Error" }), { status: 500, headers });
    }
}

// TYPES
interface CropConfig {
    name: string;
    stage_times: number[];
    wither_time: number;
    buy_silver: number;
    exp: number;
    level: number;
    pest_chance?: number;
    water_chance?: number;
    social?: {
        steal_percent?: number;
        steals_per_neighbor?: number;
        waters_per_neighbor?: number;
        water_exp?: number;
        remove_pest_exp?: number;
    };
    products: Array<{
        code: string;
        name: Record<string, string>;
        yield: [number, number];
        sell_silver: number;
    }>;
}

interface Checkpoint {
    time_offset: number;
    action: string;
    deadline: number;
    done_at?: Date | null;
}

interface CropState {
    stage: number;
    isReady: boolean;
    isWithered: boolean;
    needsAction?: string;
    timeToNext?: number;
}

// STATE CALCULATION
export function getCropState(
    createdAt: Date,
    config: CropConfig,
    checkpoints: Checkpoint[]
): CropState {
    const now = Date.now();
    const elapsed = (now - createdAt.getTime()) / 1000;

    let totalTime = 0;
    for (let i = 0; i < config.stage_times.length; i++) {
        totalTime += config.stage_times[i];
        if (elapsed < totalTime) {
            return {
                stage: i + 1,
                isReady: false,
                isWithered: false,
                timeToNext: Math.ceil(totalTime - elapsed)
            };
        }
    }

    // Handle wither_time = 0 as "never withers"
    const witherTime = config.wither_time > 0 ? totalTime + config.wither_time : Infinity;

    if (config.wither_time > 0 && elapsed > witherTime) {
        return { stage: config.stage_times.length, isReady: false, isWithered: true };
    }

    const pending = checkpoints.find(c => !c.done_at && elapsed >= c.time_offset);
    if (pending && elapsed > pending.deadline) {
        return { stage: config.stage_times.length, isReady: false, isWithered: true };
    }

    if (pending) {
        return {
            stage: config.stage_times.length,
            isReady: false,
            isWithered: false,
            needsAction: pending.action,
            timeToNext: Math.ceil(pending.deadline - elapsed)
        };
    }

    return {
        stage: config.stage_times.length,
        isReady: true,
        isWithered: false,
        timeToNext: Math.ceil(witherTime - elapsed)
    };
}

// CHECKPOINT GENERATION
export function generateCropCheckpoints(config: CropConfig): Checkpoint[] {
    const checkpoints: Checkpoint[] = [];
    let currentTime = 0;

    for (let i = 0; i < config.stage_times.length; i++) {
        currentTime += config.stage_times[i];

        if (Math.random() < (config.pest_chance || 0.1)) {
            checkpoints.push({
                time_offset: currentTime,
                action: 'remove_pest',
                deadline: currentTime + 600
            });
        }

        if (Math.random() < (config.water_chance || 0.3)) {
            checkpoints.push({
                time_offset: currentTime,
                action: 'water',
                deadline: currentTime + 1800
            });
        }
    }

    // Handle wither_time = 0 as "never withers" (use very large deadline)
    const harvestDeadline = config.wither_time > 0
        ? currentTime + config.wither_time
        : currentTime + 999999999; // effectively infinite

    checkpoints.push({
        time_offset: currentTime,
        action: 'harvest',
        deadline: harvestDeadline
    });

    return checkpoints;
}

export function generateYield(config: CropConfig): number {
    const product = config.products?.[0];
    if (!product || !product.yield) return 2;
    const [min, max] = product.yield;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
