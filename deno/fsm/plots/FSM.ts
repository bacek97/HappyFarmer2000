// PlotsFSM - Manage farm plots
import type { ModuleAPI, HandlerContext } from "../types.ts";

export const ENDPOINTS = {
    LIST: 'plots',
    BUY: 'buy_plot'
} as const;

let CONFIGS: Record<string, Record<string, unknown>> = {};

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

        const plotCfg = CONFIGS.plots?.plot as any;
        const basePlots = plotCfg?.base_plots || 6;

        const result = await hasuraQuery(`
            query($userId: bigint!) {
                user_stats(where: {user_id: {_eq: $userId}, key: {_eq: "plots_count"}}) {
                    value
                }
            }
        `, { userId: ctx.userId }, ctx.userId);

        const plotsCount = result?.user_stats?.[0]?.value || basePlots;

        return new Response(JSON.stringify({
            plots_count: plotsCount,
            base_plots: basePlots,
            total_plots: plotCfg?.total_plots || 32
        }), { headers });

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

        const plotCfg = CONFIGS.plots?.plot as any;
        const basePlots = plotCfg?.base_plots || 6;
        const plotPrice = plotCfg?.plot_price || 100;
        const priceMultiplier = plotCfg?.price_multiplier || 1.5;

        // 1. Get current plots and silver
        const result = await hasuraQuery(`
            query($userId: bigint!) {
                user_stats(where: {user_id: {_eq: $userId}, key: {_in: ["plots_count", "silver"]}}) {
                    key
                    value
                }
            }
        `, { userId: ctx.userId }, ctx.userId);

        const stats: Record<string, number> = {};
        result?.user_stats?.forEach((s: any) => stats[s.key] = s.value);

        const currentPlots = stats.plots_count || basePlots;
        const currentSilver = stats.silver || 0;

        // 2. Calculate price: price = base_price * (multiplier ^ (current - base))
        const extraPlots = currentPlots - basePlots;
        const price = Math.floor(plotPrice * Math.pow(priceMultiplier, extraPlots));

        if (currentSilver < price) {
            return new Response(JSON.stringify({ error: "Not enough silver", price, silver: currentSilver }), { status: 400, headers });
        }

        if (currentPlots >= (plotCfg?.max_plots || 32)) {
            return new Response(JSON.stringify({ error: "Max plots reached" }), { status: 400, headers });
        }

        // 3. Update DB
        await hasuraQuery(`
            mutation BuyPlot($userId: bigint!, $newPlots: Int!, $newSilver: Int!) {
                insert_user_stats(objects: [
                    {user_id: $userId, key: "plots_count", value: $newPlots},
                    {user_id: $userId, key: "silver", value: $newSilver}
                ], on_conflict: {constraint: user_stats_pkey, update_columns: [value]}) {
                    affected_rows
                }
            }
        `, {
            userId: ctx.userId,
            newPlots: currentPlots + 1,
            newSilver: currentSilver - price
        }, ctx.userId);

        return new Response(JSON.stringify({
            success: true,
            plots_count: currentPlots + 1,
            price,
            silver: currentSilver - price
        }), { headers });

    } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers });
    }
}
