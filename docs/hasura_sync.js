// Hasura Subscriptions Synchronization Logic
// Strictly ONLY real-time sync, no UI logic.

class HasuraSync {
    constructor(url, token) {
        this.url = url.replace('http', 'ws');
        this.token = token;
        this.ws = null;
        this.subs = new Map();
        this.connected = false;
    }
    connect() {
        console.log('[SYNC] Connecting to Hasura WS...');
        this.ws = new WebSocket(this.url, 'graphql-ws');
        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                type: 'connection_init',
                payload: { headers: { Authorization: this.token } }
            }));
        };
        this.ws.onmessage = (e) => {
            console.log('[SYNC] Raw message:', e.data);
            const msg = JSON.parse(e.data);
            if (msg.type === 'connection_ack') {
                console.log('[SYNC] Connected to Hasura');
                this.connected = true;
                this.subs.forEach((sub, id) => this.start(id, sub));
            } else if (msg.type === 'data') {
                console.log('[SYNC] Data received for:', msg.id);
                this.subs.get(msg.id)?.callback(msg.payload.data);
            } else if (msg.type === 'error') {
                console.error('[SYNC] Hasura Error:', msg.payload);
            } else if (msg.type === 'ka') {
                // Keep-alive, ignoring
            }
        };
        this.ws.onclose = () => {
            this.connected = false;
            console.warn('[SYNC] Connection lost, reconnecting...');
            setTimeout(() => this.connect(), 3000);
        };
    }
    subscribe(id, query, variables, callback) {
        const sub = { query, variables, callback };
        this.subs.set(id, sub);
        if (this.connected) this.start(id, sub);
    }
    start(id, sub) {
        this.ws.send(JSON.stringify({
            id, type: 'start',
            payload: { query: sub.query, variables: sub.variables }
        }));
    }
    stop(id) {
        if (this.subs.has(id)) {
            if (this.connected) {
                this.ws.send(JSON.stringify({ id, type: 'stop' }));
            }
            this.subs.delete(id);
        }
    }
}

// Global instance to be used by the engine
window.startFarmSubscriptions = function (targetUserId, sync, userId, inventory, factoriesState, animalsState, plots, CONFIGS, updatePlotsCount, updateResourcesUI, renderFactory, renderAnimal, calculateObjectState, restorePlotVisual) {
    console.log('[SYNC] Starting subscriptions for user:', targetUserId);

    // Stats always for current user (userId) - don't re-subscribe if already active
    if (!sync.subs.has('stats')) {
        sync.subscribe('stats', `
            subscription SubscribeStats($userId: bigint!) {
                user_stats(where: {user_id: {_eq: $userId}}) {
                    key
                    value
                }
            }
        `, { userId }, (data) => {
            if (!data?.user_stats) return;
            data.user_stats.forEach(s => {
                if (s.key === 'plots_count') {
                    const count = parseInt(s.value);
                    updatePlotsCount(count);
                } else {
                    inventory[s.key] = parseInt(s.value);
                }
            });
            updateResourcesUI();
        });
    }

    // Objects for the farm we are currently viewing
    sync.stop('objects'); // Stop previous if any
    sync.subscribe('objects', `
        subscription SubscribeObjects($userId: bigint!) {
            game_objects(where: {user_id: {_eq: $userId}}) {
                id
                type_code
                x y
                created_at
                params { key value }
                checkpoints { action deadline time_offset done_at }
            }
        }
    `, { userId: targetUserId }, (data) => {
        if (!data?.game_objects) return;

        const isNeighbor = String(targetUserId) !== String(userId);

        data.game_objects.forEach(obj => {
            const params = {};
            obj.params.forEach(p => params[p.key] = p.value);

            if (obj.type_code.startsWith('factory_')) {
                const code = obj.type_code.replace('factory_', '');
                const state = calculateObjectState(obj.checkpoints, params);
                factoriesState[code] = { ...obj, calculated_state: state };
                renderFactory(code);
            } else if (obj.type_code.startsWith('animal_')) {
                const code = obj.type_code.replace('animal_', '');
                const state = calculateObjectState(obj.checkpoints, params);
                animalsState[obj.id] = { ...obj, calculated_state: state };
                renderAnimal(obj.id);
            } else if (obj.type_code.startsWith('crop_')) {
                const plotId = obj.x;
                const code = obj.type_code.replace('crop_', '');
                const cropCfg = CONFIGS.crops?.[code];
                if (plotId >= 0 && plotId < plots.length) {
                    const state = calculateObjectState(obj.checkpoints, params, obj);
                    plots[plotId] = {
                        state: state.stage === 'ready' ? 'ready' : (state.stage === 'withered' ? 'withered' : 'planted'),
                        crop: code,
                        config: cropCfg,
                        objectId: obj.id,
                        plantedAt: new Date(obj.created_at).getTime(),
                        stage: state.stage,
                        is_neighbor: isNeighbor
                    };
                    restorePlotVisual(plotId, plots[plotId]);
                }
            }
        });
    });
};

window.HasuraSync = HasuraSync;
