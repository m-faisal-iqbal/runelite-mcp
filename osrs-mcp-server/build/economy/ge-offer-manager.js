// ─── GE Offer Manager ────────────────────────────────────────────────────────
// Models GE offer state and provides actions via the plugin widget API.
// The plugin doesn't have a dedicated /api/ge endpoint, so we use
// /api/widgets to read offer state and /api/action/widget to place offers.
// ─── GE Widget IDs ────────────────────────────────────────────────────────────
// RuneLite widget group IDs for Grand Exchange interface
const GE_WIDGET_GROUP = 465; // Main GE window
const GE_OFFER_GROUP = 162; // Individual offer setup window
const GE_SLOT_CHILD_OFFSET = 7; // slot N button = child (7 + N*6)
// ─── Offer slot management ────────────────────────────────────────────────────
/** Generate the widget action to open a specific GE slot */
export function openGeSlot(slot) {
    const childId = GE_SLOT_CHILD_OFFSET + slot * 6;
    return {
        action: "open_ge_slot",
        tool: "semantic_invoke_control",
        toolArgs: { widgetGroup: GE_WIDGET_GROUP, widgetChild: childId, action: "View offer" },
        description: `Open GE slot ${slot}`,
    };
}
/** Generate action to click "Buy" or "Sell" button in an open GE slot */
export function clickOfferType(type) {
    return {
        action: "click_offer_type",
        tool: "semantic_invoke_control",
        toolArgs: {
            widgetGroup: GE_OFFER_GROUP,
            widgetChild: type === "BUY" ? 23 : 24,
            action: type === "BUY" ? "Buy" : "Sell",
        },
        description: `Click ${type} button in GE offer window`,
    };
}
/** Generate action sequence to set the quantity in the GE offer window */
export function setQuantity(quantity) {
    return {
        action: "set_quantity",
        tool: "handle_dialogue",
        toolArgs: { action: "enter_value", value: String(quantity), context: "ge_quantity" },
        description: `Set quantity to ${quantity}`,
    };
}
/** Generate action sequence to set the price in the GE offer window */
export function setPrice(price) {
    return {
        action: "set_price",
        tool: "handle_dialogue",
        toolArgs: { action: "enter_value", value: String(price), context: "ge_price" },
        description: `Set price to ${price.toLocaleString()} gp`,
    };
}
/** Generate the "Confirm" action to submit the offer */
export function confirmOffer() {
    return {
        action: "confirm_offer",
        tool: "semantic_invoke_control",
        toolArgs: { widgetGroup: GE_OFFER_GROUP, widgetChild: 25, action: "Confirm" },
        description: "Confirm GE offer",
    };
}
/** Build the full ordered action sequence to place a GE offer */
export function buildPlaceOfferActions(args) {
    const slot = args.slot ?? 0;
    return [
        { action: "open_ge", tool: "interact_with", toolArgs: { npc: "Grand Exchange Clerk", action: "Exchange" }, description: "Open Grand Exchange" },
        openGeSlot(slot),
        clickOfferType(args.type),
        { action: "search_item", tool: "semantic_invoke_control", toolArgs: { widgetGroup: GE_OFFER_GROUP, widgetChild: 51, action: "Search", searchText: args.itemName }, description: `Search for ${args.itemName}` },
        setQuantity(args.quantity),
        setPrice(args.price),
        confirmOffer(),
    ];
}
/** Build action sequence to collect a completed/partial offer */
export function buildCollectActions(slot) {
    return [
        openGeSlot(slot),
        { action: "collect", tool: "semantic_invoke_control", toolArgs: { widgetGroup: GE_WIDGET_GROUP, widgetChild: GE_SLOT_CHILD_OFFSET + slot * 6 + 2, action: "Collect" }, description: `Collect items from slot ${slot}` },
    ];
}
/** Build action to cancel an active offer */
export function buildCancelActions(slot) {
    return [
        openGeSlot(slot),
        { action: "abort", tool: "semantic_invoke_control", toolArgs: { widgetGroup: GE_OFFER_GROUP, widgetChild: 27, action: "Abort offer" }, description: `Cancel offer in slot ${slot}` },
    ];
}
/** Parse GE offer state from snapshot widgets (returns null if GE not open) */
export function parseOffersFromSnapshot(snapshot) {
    const widgets = snapshot?.widgets;
    if (!widgets)
        return null;
    const geGroup = widgets[String(GE_WIDGET_GROUP)];
    if (!geGroup || !Array.isArray(geGroup))
        return null;
    const offers = [];
    for (let slot = 0; slot < 8; slot++) {
        const childBase = GE_SLOT_CHILD_OFFSET + slot * 6;
        const child = geGroup[childBase];
        if (!child || typeof child !== "object")
            continue;
        const c = child;
        const status = parseOfferStatus(String(c.status ?? "empty"));
        offers.push({
            slot,
            type: String(c.type ?? "BUY").toUpperCase(),
            itemName: String(c.itemName ?? ""),
            itemId: Number(c.itemId ?? 0),
            quantity: Number(c.quantity ?? 0),
            price: Number(c.price ?? 0),
            quantityFilled: Number(c.quantityFilled ?? 0),
            gpSpent: Number(c.gpSpent ?? 0),
            status,
            stale: false,
        });
    }
    return offers;
}
function parseOfferStatus(raw) {
    const s = raw.toLowerCase();
    if (s.includes("empty"))
        return "EMPTY";
    if (s.includes("complete"))
        return "COMPLETE";
    if (s.includes("partial"))
        return "PARTIAL";
    if (s.includes("cancel"))
        return "CANCELLED";
    if (s.includes("pending") || s.includes("active"))
        return "PENDING";
    return "EMPTY";
}
/** Find first empty slot from a list of offers */
export function findEmptySlot(offers) {
    const empty = offers.find((o) => o.status === "EMPTY");
    return empty ? empty.slot : null;
}
