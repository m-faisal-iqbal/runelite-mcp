export class ReflexEngine {
    deps;
    defaults;
    activePolicy;
    timer;
    ticking = false;
    history = [];
    constructor(deps, defaults = {}) {
        this.deps = deps;
        this.defaults = defaults;
    }
    loadPolicy(policy, options = {}) {
        assertReflexPolicySafe(policy);
        this.stop("REPLACED_BY_NEW_POLICY");
        const now = this.now();
        const loaded = {
            ...policy,
            id: policy.id ?? `policy_${now}_${Math.random().toString(36).slice(2, 8)}`,
            status: "loaded",
            executionMode: options.executionMode ?? policy.executionMode ?? "dry_run",
            targetClient: policy.targetClient ?? {},
            tickMs: Math.max(100, Number(policy.tickMs ?? this.defaults.tickMs ?? 600)),
            maxTicks: Math.max(1, Number(policy.maxTicks ?? this.defaults.maxTicks ?? 500)),
            loadedAt: now,
            updatedAt: now,
            tickCount: 0,
            stepIndex: 0,
        };
        this.activePolicy = loaded;
        this.record("policy_loaded", this.publicPolicy(loaded));
        if (options.start !== false) {
            this.start();
        }
        return this.status();
    }
    start() {
        const policy = this.requirePolicy();
        if (policy.status === "running") {
            return this.status();
        }
        policy.status = "running";
        policy.startedAt ??= this.now();
        policy.updatedAt = this.now();
        this.record("policy_started", { id: policy.id, tickMs: policy.tickMs, executionMode: policy.executionMode });
        this.schedule(this.deps.readGameTick ? 0 : policy.tickMs);
        return this.status();
    }
    pause(reason = "PAUSED_BY_REQUEST") {
        const policy = this.activePolicy;
        if (!policy) {
            return this.status();
        }
        this.clearTimer();
        policy.status = "paused";
        policy.stopReason = reason;
        policy.updatedAt = this.now();
        this.record("policy_paused", { id: policy.id, reason });
        return this.status();
    }
    resume() {
        const policy = this.requirePolicy();
        if (policy.status !== "paused" && policy.status !== "loaded") {
            return this.status();
        }
        policy.stopReason = undefined;
        return this.start();
    }
    stop(reason = "STOPPED_BY_REQUEST") {
        this.clearTimer();
        const policy = this.activePolicy;
        if (policy && !["stopped", "completed", "blocked"].includes(policy.status)) {
            policy.status = "stopped";
            policy.stopReason = reason;
            policy.updatedAt = this.now();
            this.record("policy_stopped", { id: policy.id, reason });
        }
        return this.status();
    }
    async runSingleTick() {
        const policy = this.activePolicy;
        if (!policy || policy.status !== "running") {
            return this.status();
        }
        if (this.ticking) {
            this.record("tick_skipped", { id: policy.id, reason: "PREVIOUS_TICK_STILL_RUNNING" });
            return this.status();
        }
        this.ticking = true;
        try {
            const tickReady = await this.waitForNextGameTick(policy);
            if (!tickReady) {
                return this.status();
            }
            await this.executeTick(policy);
        }
        catch (error) {
            this.block(policy, `TICK_FAILURE:${error?.message ?? String(error)}`);
        }
        finally {
            this.ticking = false;
            if (this.activePolicy?.id === policy.id && policy.status === "running") {
                this.schedule(this.deps.readGameTick ? 0 : policy.tickMs);
            }
        }
        return this.status();
    }
    status() {
        return {
            activePolicy: this.publicPolicy(this.activePolicy),
            running: this.activePolicy?.status === "running",
            historyCount: this.history.length,
            lastEvents: this.history.slice(-12),
        };
    }
    getHistory(limit = 50) {
        return this.history.slice(-Math.max(1, limit));
    }
    async executeTick(policy) {
        policy.tickCount += 1;
        policy.updatedAt = this.now();
        const tickIndex = policy.tickCount;
        const observation = await this.deps.observe(policy);
        this.record("tick_observed", { id: policy.id, tickIndex, observation: compactObservation(observation) });
        if (tickIndex > policy.maxTicks) {
            this.complete(policy, "MAX_TICKS_REACHED");
            return;
        }
        const success = this.successReached(policy, observation);
        if (success.reached) {
            this.complete(policy, success.reason);
            return;
        }
        const guardStep = this.guardStep(policy, observation);
        if (policy.status !== "running") {
            return;
        }
        if (guardStep) {
            await this.runPolicyStep(policy, guardStep, "guard");
            return;
        }
        const cooldownMs = actionCooldownMs(policy);
        if (cooldownMs > 0 && policy.lastActionAt && this.now() - policy.lastActionAt < cooldownMs) {
            this.record("action_cooldown", {
                id: policy.id,
                tickIndex,
                elapsedMs: this.now() - policy.lastActionAt,
                cooldownMs,
            });
            return;
        }
        const nextStep = this.nextPolicyStep(policy, observation);
        if (!nextStep) {
            this.block(policy, "NO_POLICY_STEP_AVAILABLE");
            return;
        }
        await this.runPolicyStep(policy, nextStep, "policy");
    }
    async runPolicyStep(policy, step, source) {
        const result = await this.deps.runStep(step, policy, policy.executionMode);
        this.record("step_result", { id: policy.id, source, tickIndex: policy.tickCount, result });
        if (result.status === "EXECUTION_BLOCKED" || result.status === "BLOCKED" || result.actionResult?.success === false) {
            this.block(policy, result.reason ?? result.actionResult?.reason ?? "STEP_BLOCKED");
            return;
        }
        if (result.executed) {
            policy.lastActionAt = this.now();
        }
        if (source === "policy" && policy.steps?.length) {
            policy.stepIndex = Math.min(policy.stepIndex + 1, policy.steps.length);
            if (policy.stepIndex >= policy.steps.length) {
                this.complete(policy, "POLICY_STEPS_COMPLETED");
            }
        }
    }
    async waitForNextGameTick(policy) {
        if (!this.deps.readGameTick) {
            return true;
        }
        const startedAt = this.now();
        const pollMs = Math.max(25, Number(policy.tickPollMs ?? 100));
        const stallMs = Math.max(pollMs, Number(policy.tickStallMs ?? 1200));
        while (this.now() - startedAt <= stallMs) {
            const currentTick = await this.deps.readGameTick(policy).catch((error) => {
                this.record("tick_poll_failed", { id: policy.id, message: error?.message ?? String(error) });
                return undefined;
            });
            if (Number.isFinite(currentTick)) {
                if (policy.lastProcessedGameTick === undefined) {
                    policy.lastProcessedGameTick = currentTick;
                }
                else if (currentTick !== policy.lastProcessedGameTick) {
                    policy.lastProcessedGameTick = currentTick;
                    return true;
                }
            }
            await sleep(pollMs);
        }
        this.record("tick_stalled", {
            id: policy.id,
            lastProcessedGameTick: policy.lastProcessedGameTick,
            stallMs,
        });
        this.pause("TICK_STALLED");
        return false;
    }
    guardStep(policy, observation) {
        if (policy.stopOnVisiblePlayers && (observation.visiblePlayers?.length ?? 0) > 0) {
            this.block(policy, "VISIBLE_PLAYER_THREAT_DETECTED");
            return undefined;
        }
        if (policy.stopOnMinimapPlayerThreat && observation.minimapPlayerThreat) {
            this.block(policy, "MINIMAP_PLAYER_THREAT_DETECTED");
            return undefined;
        }
        if (observation.inventoryFull) {
            const behavior = policy.inventoryFullBehavior ?? "stop";
            if (behavior === "stop") {
                this.complete(policy, "INVENTORY_FULL");
                return undefined;
            }
            if (behavior === "drop") {
                return {
                    tool: "drop_inventory_item",
                    reason: "Inventory guard: inventory is full, dropping the policy item to make space.",
                    arguments: {
                        name: policy.dropItemName ?? policy.itemName,
                        id: policy.dropItemId,
                    },
                };
            }
            if (behavior === "bank") {
                if (!observation.bankOpen) {
                    this.block(policy, "INVENTORY_FULL_BANK_NOT_OPEN");
                    return undefined;
                }
                return {
                    tool: "deposit_inventory_item",
                    reason: "Inventory guard: inventory is full and bank is open, depositing the policy item.",
                    arguments: {
                        quantity: "All",
                        itemName: policy.bankItemName ?? policy.itemName,
                        itemId: policy.bankItemId,
                    },
                };
            }
        }
        const hp = observation.health;
        const hpPercent = observation.healthPercent;
        const shouldEatByHp = policy.eatAtHp !== undefined && hp !== undefined && hp <= policy.eatAtHp;
        const shouldEatByPercent = policy.eatAtHpPercent !== undefined && hpPercent !== undefined && hpPercent <= policy.eatAtHpPercent;
        if (shouldEatByHp || shouldEatByPercent) {
            return {
                tool: "eat_food_when",
                reason: "Survival guard: hitpoints are at or below the policy threshold.",
                arguments: {
                    hpBelow: policy.eatAtHp,
                    hpBelowPercent: policy.eatAtHpPercent,
                    foodName: policy.foodName,
                    foodNames: policy.foodNames,
                },
            };
        }
        return undefined;
    }
    nextPolicyStep(policy, observation) {
        const explicit = policy.steps?.[policy.stepIndex];
        if (explicit) {
            return normalizePolicyStep(explicit);
        }
        const taskText = `${policy.task ?? ""} ${policy.objective ?? ""} ${policy.method ?? ""}`.toLowerCase();
        if (wantsBankDeposit(policy, taskText)) {
            if (!observation.bankOpen) {
                return bankOpenStep(policy, "Policy executor selected bank opening before depositing inventory items.");
            }
            return {
                tool: "deposit_inventory_item",
                reason: "Policy executor selected bank deposit for the requested inventory item.",
                arguments: {
                    itemName: policy.bankItemName ?? policy.itemName,
                    itemId: policy.bankItemId,
                    quantity: policy.bankQuantity ?? "All",
                },
            };
        }
        if (wantsBankWithdraw(policy, taskText)) {
            if (!observation.bankOpen) {
                return bankOpenStep(policy, "Policy executor selected bank opening before withdrawing bank items.");
            }
            return {
                tool: "withdraw_bank_item",
                reason: "Policy executor selected bank withdraw for the requested bank item.",
                arguments: {
                    itemName: policy.bankItemName ?? policy.itemName,
                    itemId: policy.bankItemId,
                    quantity: policy.bankQuantity ?? policy.quantity ?? 1,
                },
            };
        }
        if (wantsBankOpen(policy, taskText)) {
            return bankOpenStep(policy, "Policy executor selected nearest bank interaction.");
        }
        if (policy.destination || taskText.includes("travel") || taskText.includes("navigate") || taskText.includes("walk to")) {
            return {
                tool: "navigate_to",
                reason: "Policy executor selected one bounded System 1 navigation step toward the destination.",
                arguments: {
                    destination: policy.destination ?? policy.targetName ?? policy.objective,
                    from: policy.from,
                    maxStepTiles: policy.maxStepTiles,
                    waypointRadius: policy.waypointRadius,
                },
            };
        }
        if (taskText.includes("woodcut") || taskText.includes("chop") || taskText.includes("log")) {
            return {
                tool: "interact_with",
                reason: "Policy executor selected nearest tree interaction for woodcutting/log acquisition.",
                arguments: {
                    entityType: "object",
                    name: policy.targetName ?? (policy.itemName?.toLowerCase().includes("oak") ? "Oak" : "Tree"),
                    id: policy.targetId,
                    option: policy.actionOption ?? "Chop down",
                    nearestToPlayer: true,
                },
            };
        }
        if (taskText.includes("mining") || taskText.includes("mine") || taskText.includes(" ore")) {
            return {
                tool: "interact_with",
                reason: "Policy executor selected nearest rock interaction for mining/resource acquisition.",
                arguments: {
                    entityType: "object",
                    name: policy.targetName ?? miningRockNameForItem(policy.itemName ?? policy.objective ?? policy.task ?? "ore"),
                    id: policy.targetId,
                    option: policy.actionOption ?? "Mine",
                    nearestToPlayer: true,
                },
            };
        }
        if (taskText.includes("loot") || taskText.includes("take bones") || taskText.includes("take feather") || taskText.includes("take ground")) {
            return {
                tool: "interact_with",
                reason: "Policy executor selected nearest ground-item loot interaction.",
                arguments: {
                    entityType: "ground_item",
                    name: policy.targetName ?? policy.itemName ?? defaultLootNameForText(taskText),
                    id: policy.targetId,
                    option: policy.actionOption ?? "Take",
                    nearestToPlayer: true,
                },
            };
        }
        if (taskText.includes("combat") || taskText.includes("attack")) {
            return {
                tool: "interact_with",
                reason: "Policy executor selected nearest NPC attack interaction.",
                arguments: {
                    entityType: "npc",
                    name: policy.targetName,
                    id: policy.targetId,
                    option: policy.actionOption ?? "Attack",
                    nearestToPlayer: true,
                },
            };
        }
        if (policy.targetType && (policy.targetName || policy.targetId) && policy.actionOption) {
            return {
                tool: "interact_with",
                reason: "Policy executor selected explicit target interaction.",
                arguments: {
                    entityType: policy.targetType,
                    name: policy.targetName,
                    id: policy.targetId,
                    option: policy.actionOption,
                    nearestToPlayer: true,
                },
            };
        }
        return undefined;
    }
    successReached(policy, observation) {
        const requestedQuantity = Number(policy.quantity);
        if (Number.isFinite(requestedQuantity) && requestedQuantity > 0 && policy.itemName) {
            const quantity = inventoryQuantity(observation.inventory, policy.itemName);
            const quantityMode = policy.quantityMode ?? "absolute";
            if (quantityMode === "gain") {
                if (!Number.isFinite(policy.startQuantity)) {
                    policy.startQuantity = quantity;
                    policy.targetQuantity = quantity + requestedQuantity;
                }
            }
            else {
                policy.targetQuantity = requestedQuantity;
            }
            const targetQuantity = Number(policy.targetQuantity);
            if (quantity >= targetQuantity) {
                return { reached: true, reason: `TARGET_QUANTITY_REACHED:${policy.itemName}:${quantity}/${targetQuantity}` };
            }
        }
        if (Number.isFinite(policy.destinationWorldX) && Number.isFinite(policy.destinationWorldY)) {
            const distance = tileDistance(observation.location, policy.destinationWorldX, policy.destinationWorldY, policy.destinationPlane);
            if (distance <= (policy.destinationRadius ?? 2)) {
                return { reached: true, reason: `DESTINATION_REACHED:${policy.destinationWorldX}:${policy.destinationWorldY}:${distance}` };
            }
        }
        return { reached: false, reason: "NOT_YET" };
    }
    complete(policy, reason) {
        this.clearTimer();
        policy.status = "completed";
        policy.stopReason = reason;
        policy.updatedAt = this.now();
        this.record("policy_completed", { id: policy.id, reason });
        this.emitPolicyOutcome(policy, { status: "completed", success: true, reason });
    }
    block(policy, reason) {
        this.clearTimer();
        policy.status = "blocked";
        policy.stopReason = reason;
        policy.updatedAt = this.now();
        this.record("policy_blocked", { id: policy.id, reason });
        this.emitPolicyOutcome(policy, { status: "blocked", success: false, reason });
    }
    emitPolicyOutcome(policy, outcome) {
        if (!this.deps.onPolicyOutcome) {
            return;
        }
        Promise.resolve(this.deps.onPolicyOutcome(policy, outcome)).catch((error) => {
            this.record("policy_outcome_record_failed", {
                id: policy.id,
                message: error?.message ?? String(error),
            });
        });
    }
    schedule(tickMs) {
        this.clearTimer();
        this.timer = setTimeout(() => {
            void this.runSingleTick();
        }, tickMs);
    }
    clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    requirePolicy() {
        if (!this.activePolicy) {
            throw new Error("No Reflex Engine policy is loaded.");
        }
        return this.activePolicy;
    }
    record(type, data) {
        this.history.push({ at: this.now(), type, data });
        if (this.history.length > 500) {
            this.history.splice(0, this.history.length - 500);
        }
        // Log to stderr so the MCP client can stream it back to the console
        if (type !== "tick_observed" && type !== "tick_skipped" && type !== "tick_stalled") {
            const displayData = { ...data };
            if (displayData.observation) {
                displayData.observation = "[OBSERVATION_OMITTED]";
            }
            console.error(`[Reflex Engine] [${type.toUpperCase()}] ${JSON.stringify(displayData)}`);
        }
        else if (type === "tick_observed") {
            const loc = data?.observation?.location;
            const locStr = loc ? ` @ (${loc.x},${loc.y})` : "";
            console.error(`[Reflex Engine] [TICK ${data?.tickIndex ?? "?"}] Evaluating policy...${locStr}`);
        }
    }
    publicPolicy(policy) {
        if (!policy) {
            return null;
        }
        return {
            id: policy.id,
            kind: policy.kind,
            task: policy.task,
            objective: policy.objective,
            status: policy.status,
            executionMode: policy.executionMode,
            targetClient: policy.targetClient,
            itemName: policy.itemName,
            quantity: policy.quantity,
            quantityMode: policy.quantityMode ?? "absolute",
            startQuantity: policy.startQuantity,
            targetQuantity: policy.targetQuantity,
            tickMs: policy.tickMs,
            maxTicks: policy.maxTicks,
            lastProcessedGameTick: policy.lastProcessedGameTick,
            loadedAt: policy.loadedAt,
            startedAt: policy.startedAt,
            updatedAt: policy.updatedAt,
            tickCount: policy.tickCount,
            stepIndex: policy.stepIndex,
            stopReason: policy.stopReason,
            safety: {
                eatAtHp: policy.eatAtHp,
                eatAtHpPercent: policy.eatAtHpPercent,
                inventoryFullBehavior: policy.inventoryFullBehavior ?? "stop",
                dropItemName: policy.dropItemName,
                bankAction: policy.bankAction,
                bankItemName: policy.bankItemName,
                bankQuantity: policy.bankQuantity,
                destination: policy.destination,
                destinationWorldX: policy.destinationWorldX,
                destinationWorldY: policy.destinationWorldY,
                waypointRadius: policy.waypointRadius,
                stopOnVisiblePlayers: policy.stopOnVisiblePlayers ?? false,
                stopOnMinimapPlayerThreat: policy.stopOnMinimapPlayerThreat ?? false,
            },
        };
    }
    now() {
        return this.deps.now?.() ?? Date.now();
    }
}
const FORBIDDEN_REFLEX_CAPABILITY_NEEDLES = [
    "click",
    "invoke_",
    "move_mouse",
    "keyboard",
    "perform_until",
    "execute_agent_step",
    "run_agent_cycle",
    "agent_run_goal",
];
export function validateReflexPolicySafety(policy) {
    const errors = [];
    scanReflexPolicyValue(policy, "policy", errors);
    return errors;
}
export function assertReflexPolicySafe(policy) {
    const errors = validateReflexPolicySafety(policy);
    if (errors.length > 0) {
        throw new Error(`Reflex policy contains forbidden raw action capabilities: ${errors.join("; ")}`);
    }
}
function scanReflexPolicyValue(value, path, errors) {
    if (!value || typeof value !== "object") {
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => scanReflexPolicyValue(entry, `${path}[${index}]`, errors));
        return;
    }
    const record = value;
    for (const [key, nested] of Object.entries(record)) {
        const lowerKey = key.toLowerCase();
        if (["tool", "capability", "preferredsystem1capability", "actiontool"].includes(lowerKey)) {
            const needle = forbiddenReflexNeedle(nested);
            if (needle) {
                errors.push(`${path}.${key}='${String(nested)}' matched '${needle}'`);
            }
        }
        if (nested && typeof nested === "object") {
            scanReflexPolicyValue(nested, `${path}.${key}`, errors);
        }
    }
}
function forbiddenReflexNeedle(value) {
    const text = String(value ?? "").toLowerCase();
    return FORBIDDEN_REFLEX_CAPABILITY_NEEDLES.find((needle) => text.includes(needle));
}
// Aliases the LLM commonly generates → correct Reflex Engine tool name
const TOOL_ALIASES = {
    travel: "navigate_to",
    walk: "navigate_to",
    walk_to: "navigate_to",
    go_to: "navigate_to",
    move_to: "navigate_to",
    navigate: "navigate_to",
    pathfind: "navigate_to",
    interact: "interact_with",
    use: "interact_with",
    attack: "interact_with",
    chop: "interact_with",
    mine: "interact_with",
    fish: "interact_with",
    eat: "eat_food_when",
    eat_food: "eat_food_when",
    deposit: "deposit_inventory_item",
    deposit_item: "deposit_inventory_item",
    withdraw: "withdraw_bank_item",
    withdraw_item: "withdraw_bank_item",
    drop: "drop_inventory_item",
    drop_item: "drop_inventory_item",
};
function normalizePolicyStep(step) {
    const resolveTool = (raw) => TOOL_ALIASES[raw.toLowerCase().trim()] ?? raw;
    if (typeof step?.tool === "string") {
        return {
            tool: resolveTool(step.tool),
            reason: step.reason ?? step.intent ?? step.name,
            arguments: step.arguments ?? step.inputs ?? {},
        };
    }
    const capability = String(step?.preferredSystem1Capability ?? step?.capability ?? "").trim();
    if (capability) {
        return {
            tool: resolveTool(capability),
            reason: step.intent ?? step.name,
            arguments: step.inputs ?? {},
        };
    }
    return {
        tool: "unsupported_policy_step",
        reason: "Policy step did not include a System 1 capability.",
        arguments: { step },
    };
}
function inventoryQuantity(inventory, name) {
    const needle = name.toLowerCase();
    const items = inventory ?? [];
    const exactMatches = items.filter((item) => String(item?.name ?? "").toLowerCase() === needle);
    const matches = exactMatches.length > 0
        ? exactMatches
        : items.filter((item) => {
            const itemName = String(item?.name ?? "").toLowerCase();
            return itemName.includes(needle);
        });
    return matches.reduce((total, item) => {
        const itemName = String(item?.name ?? "").toLowerCase();
        if (!itemName) {
            return total;
        }
        return total + Math.max(1, Number(item.quantity ?? 1));
    }, 0);
}
function actionCooldownMs(policy) {
    const explicit = Number(policy.actionCooldownMs);
    if (Number.isFinite(explicit) && explicit >= 0) {
        return explicit;
    }
    const taskText = `${policy.task ?? ""} ${policy.objective ?? ""} ${policy.method ?? ""}`.toLowerCase();
    if (taskText.includes("woodcut") ||
        taskText.includes("chop") ||
        taskText.includes("log") ||
        taskText.includes("mining") ||
        taskText.includes("mine") ||
        taskText.includes(" ore")) {
        return 2200;
    }
    return 0;
}
function miningRockNameForItem(itemName) {
    const item = itemName.toLowerCase();
    if (item.includes("tin")) {
        return "Tin rocks";
    }
    if (item.includes("copper")) {
        return "Copper rocks";
    }
    if (item.includes("iron")) {
        return "Iron rocks";
    }
    if (item.includes("coal")) {
        return "Coal rocks";
    }
    if (item.includes("clay")) {
        return "Clay rocks";
    }
    if (item.includes("silver")) {
        return "Silver rocks";
    }
    if (item.includes("gold")) {
        return "Gold rocks";
    }
    if (item.includes("mithril")) {
        return "Mithril rocks";
    }
    if (item.includes("adamant")) {
        return "Adamantite rocks";
    }
    if (item.includes("rune") || item.includes("runite")) {
        return "Runite rocks";
    }
    if (item.endsWith(" ore")) {
        return `${itemName.replace(/\s+ore$/i, "")} rocks`;
    }
    return "Rocks";
}
function wantsBankDeposit(policy, taskText) {
    const bankAction = String(policy.bankAction ?? "").toLowerCase();
    return bankAction === "deposit" ||
        taskText.includes("deposit") ||
        taskText.includes("bank inventory") ||
        taskText.includes("bank item");
}
function wantsBankWithdraw(policy, taskText) {
    const bankAction = String(policy.bankAction ?? "").toLowerCase();
    return bankAction === "withdraw" ||
        taskText.includes("withdraw");
}
function wantsBankOpen(policy, taskText) {
    const bankAction = String(policy.bankAction ?? "").toLowerCase();
    return bankAction === "open" ||
        taskText.includes("open bank") ||
        taskText === "bank" ||
        taskText.includes(" banking ");
}
function bankOpenStep(policy, reason) {
    const explicitTargetType = policy.targetType === "object" || policy.targetType === "npc" ? policy.targetType : undefined;
    const targetName = policy.targetName ?? (explicitTargetType === "object" ? "Bank booth" : "Banker");
    return {
        tool: "interact_with",
        reason,
        arguments: {
            entityType: explicitTargetType ?? "npc",
            name: targetName,
            id: policy.targetId,
            option: policy.actionOption ?? "Bank",
            nearestToPlayer: true,
        },
    };
}
function defaultLootNameForText(taskText) {
    if (taskText.includes("feather")) {
        return "Feather";
    }
    if (taskText.includes("cowhide")) {
        return "Cowhide";
    }
    return "Bones";
}
function compactObservation(observation) {
    return {
        baseURL: observation.baseURL,
        health: observation.health,
        healthPercent: observation.healthPercent,
        inventorySlotsUsed: observation.inventorySlotsUsed,
        inventoryFull: observation.inventoryFull,
        visiblePlayers: observation.visiblePlayers?.length ?? 0,
        minimapPlayerThreat: observation.minimapPlayerThreat ?? false,
        bankOpen: observation.bankOpen,
        location: observation.location,
        isIdle: observation.isIdle,
        capturedAt: observation.capturedAt,
        summary: observation.summary,
    };
}
function tileDistance(location, worldX, worldY, plane) {
    if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
        return Number.MAX_SAFE_INTEGER;
    }
    if (plane !== undefined && location.plane !== plane) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(Math.abs(location.x - worldX), Math.abs(location.y - worldY));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
