export function tileDistance(location, worldX, worldY, plane) {
    if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) {
        return Number.MAX_SAFE_INTEGER;
    }
    if (plane !== undefined && location.plane !== plane) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(Math.abs(location.x - worldX), Math.abs(location.y - worldY));
}
export function calculateStraightLineSteps(from, to, maxStepTiles = 18, maxSteps = 12) {
    if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) {
        throw new Error("Current player location is unavailable");
    }
    if (!Number.isFinite(to.worldX) || !Number.isFinite(to.worldY)) {
        throw new Error("Target worldX/worldY are required");
    }
    const safeMaxStep = Math.max(1, Math.floor(maxStepTiles));
    const totalDx = to.worldX - from.x;
    const totalDy = to.worldY - from.y;
    const distance = Math.max(Math.abs(totalDx), Math.abs(totalDy));
    const stepsNeeded = Math.max(1, Math.ceil(distance / safeMaxStep));
    const stepsToReturn = Math.min(stepsNeeded, Math.max(1, Math.floor(maxSteps)));
    const steps = [];
    for (let i = 1; i <= stepsToReturn; i += 1) {
        const factor = Math.min(1, i / stepsNeeded);
        steps.push({
            worldX: Math.round(from.x + totalDx * factor),
            worldY: Math.round(from.y + totalDy * factor),
            plane: to.plane ?? from.plane ?? 0,
            final: i === stepsNeeded,
        });
    }
    return {
        from,
        target: { worldX: to.worldX, worldY: to.worldY, plane: to.plane ?? from.plane ?? 0 },
        distance,
        maxStepTiles: safeMaxStep,
        stepsNeeded,
        returnedSteps: steps.length,
        truncated: stepsNeeded > steps.length,
        collisionAware: false,
        note: "Straight-line minimap steps only; obstacles and doors are not pathfound.",
        steps,
    };
}
export function withStraightLineFallback(snapshot, target, maxStepTiles, maxSteps, collisionPath) {
    const fallback = calculateStraightLineSteps(snapshot.state?.location, target, maxStepTiles, maxSteps);
    return {
        ...fallback,
        fallbackUsed: true,
        fallbackReason: collisionPath?.error ?? "COLLISION_PATH_UNAVAILABLE",
        collisionPath,
    };
}
export function chooseLocalPathStep(path, maxStepTiles = 18) {
    const steps = Array.isArray(path.steps) ? path.steps : [];
    if (steps.length <= 1) {
        return steps[0];
    }
    const safeMaxStep = Math.max(1, Math.floor(maxStepTiles));
    return steps[Math.min(safeMaxStep, steps.length - 1)];
}
