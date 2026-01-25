// ===== FSM Module Types =====
// Shared types for the modular FSM system

export interface HandlerContext {
    req: Request;
    url: URL;
    userId: string;
    configs: Record<string, Record<string, unknown>>;
    db: DatabaseAPI;
    // Dynamic properties set by hooks
    [key: string]: unknown;
}

export interface DatabaseAPI {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    getObject: (id: number) => Promise<GameObjectRecord | null>;
    getPlotByCrop: (cropId: number) => Promise<PlotRecord | null>;
}

export interface GameObjectRecord {
    id: number;
    user_id: string;
    type_code: string;
    state?: string;
    created_at: string;
    x?: number;
    y?: number;
}

export interface PlotRecord {
    id: number;
    user_id: string;
    state: string;
    crop_id?: number;
}

export interface ModuleHook {
    before?: (ctx: HandlerContext) => Promise<Response | null>;
    after?: (ctx: HandlerContext, response: Response) => Promise<Response>;
    runBefore?: string[];  // Execute this hook BEFORE these modules
    runAfter?: string[];   // Execute this hook AFTER these modules
}

export interface PendingHook {
    hook: ModuleHook;
    moduleName: string;
}

export interface RegisteredEndpoint {
    name: string;
    path: string;
    handler: (ctx: HandlerContext) => Promise<Response>;
    hooks: PendingHook[];
    module: string;
}

export interface ModuleAPI {
    registerEndpoint: (name: string, handler: (ctx: HandlerContext) => Promise<Response>, moduleName: string) => void;
    registerHook: (endpointName: string, hook: ModuleHook, moduleName: string) => void;
    configs: Record<string, Record<string, unknown>>;
}
