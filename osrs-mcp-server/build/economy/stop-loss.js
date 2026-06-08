// ─── Stop Loss & Budget Tracker ───────────────────────────────────────────────
// Tracks GP spending per session and halts trading if configured limits are hit.
export function defaultBudgetConfig() {
    return {
        sessionBudget: 5_000_000, // 5M gp max spend per session
        stopLossGp: 500_000, // halt on 500k loss
        stopLossPercent: 10, // halt on 10% loss
        profitTarget: 0, // no auto-stop on profit
        maxFlipsPerHour: 20, // max 20 offer placements/hr
        maxActiveOffers: 4, // max 4 concurrent offers
    };
}
export function createBudgetState(startGp) {
    return {
        sessionStartGp: startGp,
        currentGp: startGp,
        gpSpent: 0,
        gpEarned: 0,
        netPnl: 0,
        flipsThisHour: 0,
        activeOffers: 0,
        sessionStartTime: Date.now(),
        lastFlipTime: 0,
        halted: false,
        haltReason: "",
    };
}
/** Update state after spending GP (placing a buy offer) */
export function recordSpend(state, amount) {
    return {
        ...state,
        currentGp: state.currentGp - amount,
        gpSpent: state.gpSpent + amount,
        netPnl: state.currentGp - amount - state.sessionStartGp + state.gpEarned,
        flipsThisHour: state.flipsThisHour + 1,
        activeOffers: state.activeOffers + 1,
        lastFlipTime: Date.now(),
    };
}
/** Update state after receiving GP (sell offer collected) */
export function recordEarning(state, amount) {
    return {
        ...state,
        currentGp: state.currentGp + amount,
        gpEarned: state.gpEarned + amount,
        netPnl: state.currentGp + amount - state.sessionStartGp - state.gpSpent + state.gpEarned,
        activeOffers: Math.max(0, state.activeOffers - 1),
    };
}
/** Reset the per-hour flip counter (call every 60 min) */
export function resetHourlyFlips(state) {
    return { ...state, flipsThisHour: 0 };
}
/** Check whether the agent is allowed to place a new offer */
export function checkBudget(state, config, cost // GP cost of the proposed offer
) {
    const warnings = [];
    if (state.halted) {
        return { allowed: false, reason: `Session halted: ${state.haltReason}`, warnings, state };
    }
    // Stop-loss: absolute GP loss
    const absLoss = state.sessionStartGp - state.currentGp;
    if (absLoss >= config.stopLossGp) {
        const halted = { ...state, halted: true, haltReason: `Stop-loss triggered: lost ${absLoss.toLocaleString()} gp (limit ${config.stopLossGp.toLocaleString()})` };
        return { allowed: false, reason: halted.haltReason, warnings, state: halted };
    }
    // Stop-loss: percent
    const pctLoss = state.sessionStartGp > 0 ? (absLoss / state.sessionStartGp) * 100 : 0;
    if (pctLoss >= config.stopLossPercent) {
        const halted = { ...state, halted: true, haltReason: `Stop-loss triggered: lost ${pctLoss.toFixed(1)}% of starting GP (limit ${config.stopLossPercent}%)` };
        return { allowed: false, reason: halted.haltReason, warnings, state: halted };
    }
    // Profit target
    if (config.profitTarget > 0 && state.netPnl >= config.profitTarget) {
        const halted = { ...state, halted: true, haltReason: `Profit target reached: ${state.netPnl.toLocaleString()} gp >= ${config.profitTarget.toLocaleString()} gp` };
        return { allowed: false, reason: halted.haltReason, warnings, state: halted };
    }
    // Session budget
    if (state.gpSpent + cost > config.sessionBudget) {
        return { allowed: false, reason: `Session budget exhausted (spent ${state.gpSpent.toLocaleString()}, budget ${config.sessionBudget.toLocaleString()})`, warnings, state };
    }
    // Rate limit
    if (state.flipsThisHour >= config.maxFlipsPerHour) {
        return { allowed: false, reason: `Flip rate limit: ${state.flipsThisHour}/${config.maxFlipsPerHour} per hour`, warnings, state };
    }
    // Active offer limit
    if (state.activeOffers >= config.maxActiveOffers) {
        return { allowed: false, reason: `Active offer limit: ${state.activeOffers}/${config.maxActiveOffers}`, warnings, state };
    }
    // Warnings (non-blocking)
    if (pctLoss > config.stopLossPercent * 0.7) {
        warnings.push(`Approaching stop-loss: ${pctLoss.toFixed(1)}% loss (limit ${config.stopLossPercent}%)`);
    }
    if (state.flipsThisHour > config.maxFlipsPerHour * 0.8) {
        warnings.push(`Approaching rate limit: ${state.flipsThisHour}/${config.maxFlipsPerHour} flips this hour`);
    }
    return { allowed: true, reason: "OK", warnings, state };
}
/** Human-readable session summary */
export function formatSessionSummary(state) {
    const elapsedMin = Math.round((Date.now() - state.sessionStartTime) / 60_000);
    const gpPerHour = elapsedMin > 0 ? Math.round((state.netPnl / elapsedMin) * 60) : 0;
    return [
        `Session: ${elapsedMin}min | Net P&L: ${state.netPnl >= 0 ? "+" : ""}${state.netPnl.toLocaleString()} gp`,
        `Spent: ${state.gpSpent.toLocaleString()} | Earned: ${state.gpEarned.toLocaleString()}`,
        `GP/hr: ${gpPerHour.toLocaleString()} | Flips this hour: ${state.flipsThisHour} | Active offers: ${state.activeOffers}`,
        state.halted ? `HALTED: ${state.haltReason}` : "Status: RUNNING",
    ].join("\n");
}
