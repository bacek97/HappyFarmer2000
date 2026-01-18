// PlotFSM - Конечный автомат для грядок
// ======================================

// ENDPOINTS
export const ENDPOINTS = {
    PLOW: '/plow',             // ?id=1
    BUY_PLOT: '/buy_plot'      // ?x=1&y=2
} as const;

// CONSTANTS
export const PLOW_COST = 5;

// TYPES
type PlotState = 'empty' | 'plowed' | 'planted';

interface PlotStatus {
    state: PlotState;
    canPlow: boolean;
    canPlant: boolean;
    cropId?: number;
}

// STATE CALCULATION
export function getPlotState(currentState: string, cropId: number | null): PlotStatus {
    switch (currentState) {
        case 'empty':
            return { state: 'empty', canPlow: true, canPlant: false };
        case 'plowed':
            return { state: 'plowed', canPlow: false, canPlant: true };
        case 'planted':
            return { state: 'planted', canPlow: false, canPlant: false, cropId: cropId || undefined };
        default:
            return { state: 'empty', canPlow: true, canPlant: false };
    }
}

// ENDPOINT HANDLERS
export async function handlePlow(
    userId: bigint,
    plotId: number,
    db: {
        getObject: (id: number) => Promise<any>;
        updateObjectState: (id: number, state: string) => Promise<void>;
        deductSilver: (userId: bigint, amount: number) => Promise<boolean>;
    }
): Promise<{ success: boolean; error?: string }> {
    const plot = await db.getObject(plotId);
    if (!plot || plot.user_id !== userId) return { success: false, error: 'Not found' };

    const status = getPlotState(plot.state || 'empty', null);
    if (!status.canPlow) return { success: false, error: 'Cannot plow' };

    const paid = await db.deductSilver(userId, PLOW_COST);
    if (!paid) return { success: false, error: 'Not enough silver' };

    await db.updateObjectState(plotId, 'plowed');

    return { success: true };
}

export async function handleBuyPlot(
    userId: bigint,
    x: number,
    y: number,
    db: {
        insertObject: (obj: any) => Promise<{ id: number }>;
        deductSilver: (userId: bigint, amount: number) => Promise<boolean>;
    }
): Promise<{ success: boolean; plotId?: number; error?: string }> {
    const PLOT_PRICE = 50;

    const paid = await db.deductSilver(userId, PLOT_PRICE);
    if (!paid) return { success: false, error: 'Not enough silver' };

    const plot = await db.insertObject({
        user_id: userId,
        type_code: 'plot',
        x,
        y
    });

    return { success: true, plotId: plot.id };
}
