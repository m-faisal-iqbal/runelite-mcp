export function actionStep(tool, reason, args, extra = {}) {
    return {
        tool,
        reason,
        arguments: args,
        ...extra,
    };
}
function objectiveCount(objective) {
    const match = String(objective ?? "").match(/\b(\d{1,3})\b/);
    if (!match) {
        return undefined;
    }
    const count = Number(match[1]);
    return Number.isFinite(count) && count > 0 ? Math.min(count, 28) : undefined;
}
function objectiveIncludes(objective, words) {
    const text = String(objective ?? "").toLowerCase();
    return words.some((word) => text.includes(word));
}
function sortByDistance(items) {
    return items.slice().sort((a, b) => (a.distanceToPlayer ?? Number.MAX_SAFE_INTEGER) - (b.distanceToPlayer ?? Number.MAX_SAFE_INTEGER));
}
function nearestMatchingTarget(targets, predicate) {
    return sortByDistance((targets ?? []).filter(predicate))[0];
}
function targetMatches(target, name, id) {
    if (id !== undefined && target.id !== id) {
        return false;
    }
    if (name && String(target.name ?? "").toLowerCase() !== name.toLowerCase()) {
        return false;
    }
    return true;
}
function inventorySlotsUsed(snapshot) {
    return (snapshot.inventory ?? []).filter((item) => item && item.id && item.id !== -1).length;
}
function inventoryQuantity(snapshot, name, id) {
    return (snapshot.inventory ?? [])
        .filter((item) => targetMatches(item, name, id))
        .reduce((total, item) => total + (Number.isFinite(item.quantity) ? Number(item.quantity) : 1), 0);
}
function healthPercent(snapshot) {
    const current = Number(snapshot.state?.health);
    const max = Number(snapshot.skills?.Hitpoints?.level ?? snapshot.skills?.["Hitpoints"]?.level);
    if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) {
        return undefined;
    }
    return (current / max) * 100;
}
function findFoodItem(snapshot) {
    const defaultFoodNeedles = [
        "shrimp", "sardine", "herring", "trout", "salmon", "tuna", "lobster", "swordfish",
        "monkfish", "shark", "sea turtle", "manta ray", "anglerfish", "karambwan",
        "cake", "pie", "pizza", "potato", "stew", "wine",
    ];
    return (snapshot.inventory ?? []).find((item) => {
        const itemName = String(item.name ?? "").toLowerCase();
        return defaultFoodNeedles.some((needle) => itemName.includes(needle));
    });
}
function stopArgsForItem(snapshot, count, itemName) {
    if (count && itemName) {
        return {
            condition: "inventory_quantity_at_least",
            inventoryItemName: itemName,
            inventoryQuantityAtLeast: Math.min(28, inventoryQuantity(snapshot, itemName) + count),
        };
    }
    return { condition: "inventory_full" };
}
function objectiveItemName(objective, mappings) {
    const text = String(objective ?? "").toLowerCase();
    return mappings.find(([needle]) => text.includes(needle))?.[1];
}
function firstInventoryItemName(snapshot) {
    return (snapshot.inventory ?? []).find((item) => item && item.id && item.id !== -1)?.name;
}
function findBankTarget(snapshot) {
    const object = nearestMatchingTarget(snapshot.objects, (target) => String(target.name ?? "").toLowerCase().includes("bank") ||
        String(target.option ?? "").toLowerCase().includes("bank"));
    if (object) {
        return { ...object, entityType: "object" };
    }
    const npc = nearestMatchingTarget(snapshot.npcs, (target) => String(target.name ?? "").toLowerCase().includes("banker") ||
        String(target.option ?? "").toLowerCase().includes("bank"));
    return npc ? { ...npc, entityType: "npc" } : undefined;
}
export function buildNextActionPlan(context, snapshot, objective) {
    const state = snapshot.state ?? {};
    const dialogueType = snapshot.interfaceSummary?.dialogueType ?? snapshot.dialogue?.type ?? "NONE";
    const hpPercent = healthPercent(snapshot);
    const count = objectiveCount(objective);
    const steps = [];
    const notes = [];
    if (context.runtime?.status && context.runtime.status !== "ok" && context.runtime.status !== "not_checked") {
        steps.push(actionStep("diagnose_runtime", "Runtime feature checks are not clean; confirm whether RuneLite needs a plugin reload before acting.", {}, { priority: "blocker" }));
    }
    if (state.status !== "LOGGED_IN") {
        steps.push(actionStep("get_agent_context", "The player is not logged in, so gameplay actions should wait.", { includeDiagnostics: true }, { priority: "blocker" }));
        return { steps, notes, mode: "wait_for_login" };
    }
    if (hpPercent !== undefined && hpPercent <= 35 && findFoodItem(snapshot)) {
        steps.push(actionStep("eat_food_when", "Hitpoints are low and food is available.", { healthPercentAtOrBelow: 35 }, { priority: "safety" }));
    }
    if (dialogueType && dialogueType !== "NONE") {
        steps.push(actionStep("handle_dialogue", "A dialogue or blocking interface is open; resolve it before ordinary movement or skilling.", {}, { priority: "interface" }));
        return { steps, notes, mode: "handle_interface" };
    }
    if (objectiveIncludes(objective, ["deposit", "bank logs", "bank ores", "bank fish", "bank inventory"]) && inventorySlotsUsed(snapshot) > 0) {
        if (snapshot.interfaceSummary?.bankContainerAvailable) {
            steps.push(actionStep("mark_action_baseline", "Capture inventory before depositing items.", { note: objective ?? "bank deposit" }, { priority: "verify_before" }));
            steps.push(actionStep("deposit_inventory_item", "Deposit matching inventory items through the open bank interface.", {
                itemName: firstInventoryItemName(snapshot),
                quantity: "All",
            }, { priority: "action" }));
            steps.push(actionStep("verify_last_action", "Confirm inventory changed after deposit.", { expectInventorySlotsChanged: true, requireAnyChange: true }, { priority: "verify_after" }));
            return { steps, notes, mode: "bank_deposit" };
        }
        const bank = findBankTarget(snapshot);
        if (bank) {
            steps.push(actionStep("interact_with", "Open the nearest visible bank before depositing inventory.", {
                entityType: bank.entityType,
                name: bank.name,
                id: bank.id,
                option: "Bank",
                nearestToPlayer: true,
            }, { priority: "bank_open", target: { name: bank.name, id: bank.id, distanceToPlayer: bank.distanceToPlayer } }));
            return { steps, notes, mode: "open_bank" };
        }
    }
    if (inventorySlotsUsed(snapshot) >= 28) {
        const bank = findBankTarget(snapshot);
        if (bank) {
            steps.push(actionStep("interact_with", "Inventory is full; bank before continuing the objective.", {
                entityType: bank.entityType,
                name: bank.name,
                id: bank.id,
                option: bank.option ?? "Bank",
                nearestToPlayer: true,
            }, { priority: "inventory" }));
        }
        else {
            notes.push("Inventory is full, but no nearby bank object was visible in the loaded scene.");
        }
        return { steps, notes, mode: "inventory_full" };
    }
    if (objectiveIncludes(objective, ["chop", "woodcut", "woodcutting", "tree", "logs"])) {
        const tree = nearestMatchingTarget(snapshot.objects, (object) => {
            const name = String(object.name ?? "").toLowerCase();
            const option = String(object.option ?? "").toLowerCase();
            return (name === "tree" || name.includes("tree")) && (option.includes("chop") || option === "");
        });
        if (tree) {
            const currentLogs = inventoryQuantity(snapshot, "Logs");
            const stopArgs = count
                ? { condition: "inventory_quantity_at_least", inventoryItemName: "Logs", inventoryQuantityAtLeast: Math.min(28, currentLogs + count) }
                : { condition: "inventory_full" };
            steps.push(actionStep("mark_action_baseline", "Capture inventory/location/chat before the woodcutting loop.", { note: objective ?? "woodcutting loop" }, { priority: "verify_before" }));
            steps.push(actionStep("perform_until", "Use repeated in-client tree interactions, stopping at the requested log count or full inventory.", {
                actionEntityType: "object",
                actionName: tree.name ?? "Tree",
                actionId: tree.id,
                actionOption: "Chop down",
                nearestToPlayer: true,
                maxIterations: count ?? 28,
                ...stopArgs,
            }, { priority: "action", target: { name: tree.name, id: tree.id, distanceToPlayer: tree.distanceToPlayer } }));
            steps.push(actionStep("verify_last_action", "Confirm inventory/log or chat changes after the loop.", {
                inventoryItemName: "Logs",
                expectInventoryIncreased: true,
                expectNewChat: true,
                requireAnyChange: true,
            }, { priority: "verify_after" }));
            return { steps, notes, mode: "woodcutting" };
        }
        notes.push("Woodcutting objective detected, but no nearby tree was visible in the loaded scene.");
    }
    if (objectiveIncludes(objective, ["mine", "mining", "ore", "rocks"])) {
        const oreName = objectiveItemName(objective, [
            ["copper", "Copper ore"],
            ["tin", "Tin ore"],
            ["iron", "Iron ore"],
            ["coal", "Coal"],
            ["gold", "Gold ore"],
            ["silver", "Silver ore"],
            ["clay", "Clay"],
            ["mithril", "Mithril ore"],
            ["adamant", "Adamantite ore"],
            ["rune", "Runite ore"],
        ]);
        const rock = nearestMatchingTarget(snapshot.objects, (object) => {
            const name = String(object.name ?? "").toLowerCase();
            const option = String(object.option ?? "").toLowerCase();
            return option.includes("mine") || name.includes("rock");
        });
        if (rock) {
            steps.push(actionStep("mark_action_baseline", "Capture inventory/location/chat before the mining loop.", { note: objective ?? "mining loop" }, { priority: "verify_before" }));
            steps.push(actionStep("perform_until", "Use repeated in-client mining interactions, stopping at the requested ore count when known or full inventory.", {
                actionEntityType: "object",
                actionName: rock.name ?? "Rocks",
                actionId: rock.id,
                actionOption: "Mine",
                nearestToPlayer: true,
                maxIterations: count ?? 28,
                ...stopArgsForItem(snapshot, count, oreName),
            }, { priority: "action", target: { name: rock.name, id: rock.id, distanceToPlayer: rock.distanceToPlayer } }));
            steps.push(actionStep("verify_last_action", "Confirm inventory or chat changed after mining.", {
                inventoryItemName: oreName,
                expectInventoryIncreased: Boolean(oreName),
                expectInventorySlotsChanged: !oreName,
                expectNewChat: true,
                requireAnyChange: true,
            }, { priority: "verify_after" }));
            return { steps, notes, mode: "mining" };
        }
        notes.push("Mining objective detected, but no nearby mineable rock was visible in the loaded scene.");
    }
    if (objectiveIncludes(objective, ["fish", "fishing", "shrimp", "trout", "salmon", "lobster", "tuna", "swordfish"])) {
        const fishName = objectiveItemName(objective, [
            ["shrimp", "Raw shrimps"],
            ["anchov", "Raw anchovies"],
            ["trout", "Raw trout"],
            ["salmon", "Raw salmon"],
            ["tuna", "Raw tuna"],
            ["lobster", "Raw lobster"],
            ["swordfish", "Raw swordfish"],
            ["shark", "Raw shark"],
        ]);
        const fishingSpot = nearestMatchingTarget(snapshot.npcs, (npc) => {
            const name = String(npc.name ?? "").toLowerCase();
            const option = String(npc.option ?? "").toLowerCase();
            return name.includes("fishing spot") || ["net", "bait", "lure", "cage", "harpoon"].some((needle) => option.includes(needle));
        });
        if (fishingSpot) {
            const option = ["Net", "Bait", "Lure", "Cage", "Harpoon"].find((candidate) => String(fishingSpot.option ?? "").toLowerCase().includes(candidate.toLowerCase())) ?? fishingSpot.option ?? "Net";
            steps.push(actionStep("mark_action_baseline", "Capture inventory/location/chat before the fishing loop.", { note: objective ?? "fishing loop" }, { priority: "verify_before" }));
            steps.push(actionStep("perform_until", "Use repeated in-client fishing spot interactions, stopping at the requested catch count when known or full inventory.", {
                actionEntityType: "npc",
                actionName: fishingSpot.name ?? "Fishing spot",
                actionId: fishingSpot.id,
                actionOption: option,
                nearestToPlayer: true,
                maxIterations: count ?? 28,
                ...stopArgsForItem(snapshot, count, fishName),
            }, { priority: "action", target: { name: fishingSpot.name, id: fishingSpot.id, distanceToPlayer: fishingSpot.distanceToPlayer } }));
            steps.push(actionStep("verify_last_action", "Confirm inventory or chat changed after fishing.", {
                inventoryItemName: fishName,
                expectInventoryIncreased: Boolean(fishName),
                expectInventorySlotsChanged: !fishName,
                expectNewChat: true,
                requireAnyChange: true,
            }, { priority: "verify_after" }));
            return { steps, notes, mode: "fishing" };
        }
        notes.push("Fishing objective detected, but no nearby fishing spot was visible in the loaded scene.");
    }
    if (objectiveIncludes(objective, ["attack", "fight", "kill", "combat"])) {
        const npc = nearestMatchingTarget(snapshot.npcs, (target) => {
            const option = String(target.option ?? "").toLowerCase();
            return option.includes("attack") && target.isDead !== true;
        }) ?? nearestMatchingTarget(snapshot.npcs, (target) => target.isDead !== true);
        if (npc) {
            steps.push(actionStep("mark_action_baseline", "Capture health, animation, chat, and target visibility before combat.", { note: objective ?? "combat interaction" }, { priority: "verify_before" }));
            steps.push(actionStep("interact_with", "Attack the nearest visible suitable NPC using in-client menu params.", {
                entityType: "npc",
                name: npc.name,
                id: npc.id,
                option: "Attack",
                nearestToPlayer: true,
            }, { priority: "action", target: { name: npc.name, id: npc.id, distanceToPlayer: npc.distanceToPlayer } }));
            steps.push(actionStep("wait_until_idle", "Wait until the player is idle again before choosing the next combat action.", { timeoutMs: 30000, stablePolls: 2 }, { priority: "wait" }));
            steps.push(actionStep("verify_last_action", "Confirm combat caused snapshot/chat/entity changes.", { entityType: "npc", entityName: npc.name, expectEntityCountChanged: true, expectNewChat: true, requireAnyChange: true }, { priority: "verify_after" }));
            return { steps, notes, mode: "combat" };
        }
        notes.push("Combat objective detected, but no nearby attackable NPC was visible in the loaded scene.");
    }
    if (objectiveIncludes(objective, ["talk", "speak", "dialogue", "quest"])) {
        const npc = nearestMatchingTarget(snapshot.npcs, (target) => String(target.option ?? "").toLowerCase().includes("talk") || Boolean(target.name));
        if (npc) {
            steps.push(actionStep("mark_action_baseline", "Capture dialogue/chat before starting the conversation.", { note: objective ?? "talk to NPC" }, { priority: "verify_before" }));
            steps.push(actionStep("interact_with", "Talk to the nearest likely NPC using in-client menu params.", {
                entityType: "npc",
                name: npc.name,
                id: npc.id,
                option: "Talk-to",
                nearestToPlayer: true,
            }, { priority: "action", target: { name: npc.name, id: npc.id, distanceToPlayer: npc.distanceToPlayer } }));
            steps.push(actionStep("handle_dialogue", "Continue or choose dialogue options after the NPC interaction opens dialogue.", {}, { priority: "followup" }));
            return { steps, notes, mode: "dialogue" };
        }
    }
    if (objectiveIncludes(objective, ["take", "pickup", "pick up", "loot", "collect"])) {
        const item = sortByDistance(snapshot.groundItems ?? [])[0];
        if (item) {
            steps.push(actionStep("mark_action_baseline", "Capture inventory before taking the ground item.", { note: objective ?? "take ground item" }, { priority: "verify_before" }));
            steps.push(actionStep("interact_with", "Take the nearest visible ground item.", {
                entityType: "ground_item",
                name: item.name,
                id: item.id,
                option: "Take",
                nearestToPlayer: true,
            }, { priority: "action", target: { name: item.name, id: item.id, distanceToPlayer: item.distanceToPlayer } }));
            steps.push(actionStep("verify_last_action", "Confirm inventory changed after taking the item.", { expectInventorySlotsChanged: true, requireAnyChange: true }, { priority: "verify_after" }));
            return { steps, notes, mode: "ground_item" };
        }
    }
    steps.push(actionStep("get_agent_context", "No objective-specific action was confidently selected; refresh compact context before deciding manually.", {
        objective,
        includeDiagnostics: true,
    }, { priority: "observe" }));
    notes.push("Planner stayed conservative because the objective did not match a known safe routine or no suitable target was visible.");
    return { steps, notes, mode: "observe" };
}
