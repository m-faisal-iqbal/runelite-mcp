package com.osrsmcp;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import net.runelite.api.Client;
import net.runelite.api.InventoryID;
import net.runelite.api.Item;
import net.runelite.api.ItemContainer;
import net.runelite.api.MenuEntry;
import net.runelite.api.NPC;
import net.runelite.api.Prayer;
import net.runelite.api.Quest;
import net.runelite.api.GameObject;
import net.runelite.api.GameState;
import net.runelite.api.MenuAction;
import net.runelite.api.QuestState;
import net.runelite.api.Tile;
import net.runelite.api.TileItem;
import net.runelite.api.WorldView;
import net.runelite.api.Perspective;
import net.runelite.api.Player;
import net.runelite.api.Point;
import net.runelite.api.Skill;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.widgets.Widget;
import net.runelite.api.widgets.WidgetInfo;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.game.ItemManager;

import java.io.IOException;
import java.io.OutputStream;
import java.awt.Component;
import java.awt.Dialog;
import java.awt.Frame;
import java.awt.GraphicsConfiguration;
import java.awt.GraphicsDevice;
import java.awt.GraphicsEnvironment;
import java.awt.IllegalComponentStateException;
import java.awt.MouseInfo;
import java.awt.PointerInfo;
import java.awt.Rectangle;
import java.awt.Shape;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.geom.AffineTransform;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import javax.swing.SwingUtilities;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ApiServer {
    private static final long CLIENT_THREAD_TIMEOUT_SECONDS = 2;
    private static final long SNAPSHOT_MIN_INTERVAL_MS = 200;
    private static final long STREAM_INTERVAL_MS = 600;
    private static final long STREAM_MAX_DURATION_MS = 300000;
    private static final int FIRST_API_PORT = 8080;
    private static final int LAST_API_PORT = 8090;
    private static final int RECENT_CHAT_LIMIT = 100;
    private static final int RECENT_EVENT_LIMIT = 200;
    private static final int BLOCK_MOVEMENT_NORTH_WEST = 1;
    private static final int BLOCK_MOVEMENT_NORTH = 2;
    private static final int BLOCK_MOVEMENT_NORTH_EAST = 4;
    private static final int BLOCK_MOVEMENT_EAST = 8;
    private static final int BLOCK_MOVEMENT_SOUTH_EAST = 16;
    private static final int BLOCK_MOVEMENT_SOUTH = 32;
    private static final int BLOCK_MOVEMENT_SOUTH_WEST = 64;
    private static final int BLOCK_MOVEMENT_WEST = 128;
    private static final int BLOCK_MOVEMENT_FULL = 2359552;
    private static final Logger log = LoggerFactory.getLogger(ApiServer.class);

    private HttpServer server;
    private ExecutorService executor;
    private volatile int port = FIRST_API_PORT;
    private final Client client;
    private final ClientThread clientThread;
    private final ItemManager itemManager;
    private final String instanceId = UUID.randomUUID().toString();
    private final Gson gson = new Gson();
    private final AtomicReference<GameStateSnapshot> latestSnapshot = new AtomicReference<>();
    private final List<String> recentChatMessages = new ArrayList<>();
    private final List<String> recentEvents = new ArrayList<>();
    private volatile long gameTick;
    private volatile long clientTick;
    private volatile long lastSnapshotAt;

    public ApiServer(Client client, ClientThread clientThread, ItemManager itemManager) {
        this.client = client;
        this.clientThread = clientThread;
        this.itemManager = itemManager;
    }

    public void start() {
        try {
            server = createHttpServer();
            registerContexts();
            executor = Executors.newCachedThreadPool();
            server.setExecutor(executor);
            server.start();
            log.info("API Server started on port {}", port);
        } catch (IOException e) {
            log.error("Failed to start API server", e);
        }
    }

    private HttpServer createHttpServer() throws IOException {
        IOException lastFailure = null;
        for (int candidatePort = FIRST_API_PORT; candidatePort <= LAST_API_PORT; candidatePort++) {
            try {
                HttpServer candidate = HttpServer.create(new InetSocketAddress(candidatePort), 0);
                port = candidatePort;
                return candidate;
            } catch (BindException e) {
                lastFailure = e;
                log.warn("API port {} is already in use; trying the next port", candidatePort);
            }
        }

        throw lastFailure != null ? lastFailure : new IOException("No API ports available");
    }

    private void registerContexts() {
        server.createContext("/", new ApiIndexHandler());
        server.createContext("/api", new ApiIndexHandler());
        server.createContext("/api/", new ApiIndexHandler());
        server.createContext("/api/action/menu", new ActionMenuHandler());
        server.createContext("/api/action/walk", new ActionWalkHandler());
        server.createContext("/api/action/widget", new ActionWidgetHandler());
        server.createContext("/api/state", new StateHandler());
        server.createContext("/api/inventory", new InventoryHandler());
        server.createContext("/api/npcs", new NpcHandler());
        server.createContext("/api/dialogue", new DialogueHandler());
        server.createContext("/api/objects", new ObjectHandler());
        server.createContext("/api/grounditems", new GroundItemHandler());
        server.createContext("/api/players", new PlayersHandler());
        server.createContext("/api/bank", new BankHandler());
        server.createContext("/api/bank_actions", new BankActionsHandler());
        server.createContext("/api/equipment", new EquipmentHandler());
        server.createContext("/api/skills", new SkillsHandler());
        server.createContext("/api/interface_summary", new InterfaceSummaryHandler());
        server.createContext("/api/widgets", new WidgetsHandler());
        server.createContext("/api/vars", new VarsHandler());
        server.createContext("/api/quest_state", new QuestStateHandler());
        server.createContext("/api/prayers", new PrayersHandler());
        server.createContext("/api/combat", new CombatHandler());
        server.createContext("/api/shop", new ShopHandler());
        server.createContext("/api/camera", new CameraHandler());
        server.createContext("/api/debug/coordinates", new CoordinateDebugHandler());
        server.createContext("/api/snapshot", new SnapshotHandler());
        server.createContext("/api/stream", new StreamHandler());
        server.createContext("/api/context_menu", new ContextMenuHandler());
        server.createContext("/api/minimap", new MinimapHandler());
        server.createContext("/api/path", new PathHandler());
        server.createContext("/api/chat", new ChatHandler());
        server.createContext("/api/events", new EventsHandler());
        server.createContext("/api/identity", new IdentityHandler());
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
            log.info("API Server stopped");
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    private void sendResponse(HttpExchange exchange, int statusCode, String response) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(statusCode, responseBytes.length);
        OutputStream os = exchange.getResponseBody();
        os.write(responseBytes);
        os.close();
    }

    private void sendErrorResponse(HttpExchange exchange, String error, String message) throws IOException {
        JsonObject response = new JsonObject();
        response.addProperty("error", error);
        if (message != null && !message.isEmpty()) {
            response.addProperty("message", message);
        }
        sendResponse(exchange, 503, gson.toJson(response));
    }

    private void sendJsonErrorResponse(HttpExchange exchange, int statusCode, String error, String message) throws IOException {
        JsonObject response = new JsonObject();
        response.addProperty("error", error);
        if (message != null && !message.isEmpty()) {
            response.addProperty("message", message);
        }
        sendResponse(exchange, statusCode, gson.toJson(response));
    }

    private JsonObject readJsonRequestBody(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        JsonObject request = gson.fromJson(body, JsonObject.class);
        if (request == null) {
            throw new IllegalArgumentException("Request body must be a JSON object");
        }
        return request;
    }

    private void handleOnClientThread(HttpExchange exchange, JsonResponseSupplier supplier) throws IOException {
        CompletableFuture<String> future = new CompletableFuture<>();

        try {
            clientThread.invoke(() -> {
                try {
                    future.complete(supplier.get());
                } catch (Throwable e) {
                    future.completeExceptionally(e);
                }
            });

            sendResponse(exchange, 200, future.get(CLIENT_THREAD_TIMEOUT_SECONDS, TimeUnit.SECONDS));
        } catch (TimeoutException e) {
            future.cancel(false);
            log.warn("Timed out waiting for RuneLite client thread response");
            sendErrorResponse(exchange, "CLIENT_THREAD_TIMEOUT", null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("Interrupted while waiting for RuneLite client thread response", e);
            sendErrorResponse(exchange, "CLIENT_THREAD_FAILURE", "Interrupted while waiting for client thread");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            log.error("RuneLite client thread request failed", cause);
            sendErrorResponse(exchange, "CLIENT_THREAD_FAILURE", cause.getMessage());
        } catch (RuntimeException e) {
            log.error("Failed to schedule RuneLite client thread request", e);
            sendErrorResponse(exchange, "CLIENT_THREAD_FAILURE", e.getMessage());
        }
    }

    @FunctionalInterface
    private interface JsonResponseSupplier {
        String get() throws Exception;
    }

    public void onGameTick() {
        gameTick++;
        JsonObject details = new JsonObject();
        details.addProperty("gameTick", gameTick);
        details.addProperty("clientTick", clientTick);
        addPluginEvent("GameTick", details);
    }

    public void updateSnapshotFromClientTick() {
        clientTick++;
        long now = System.currentTimeMillis();
        if (now - lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) {
            return;
        }
        lastSnapshotAt = now;

        try {
            latestSnapshot.set(buildLiveSnapshot(now));
        } catch (Throwable e) {
            log.warn("Failed to update OSRS MCP live snapshot", e);
        }
    }

    private GameStateSnapshot buildLiveSnapshot(long capturedAt) {
        String state = buildStateJson(capturedAt);
        String npcs = buildNpcsJson(capturedAt);
        String dialogue = buildDialogueJson(capturedAt);
        String objects = buildObjectsJson(capturedAt);
        String groundItems = buildGroundItemsJson(capturedAt);
        String players = buildPlayersJson(capturedAt);
        String inventory = buildInventoryJson(capturedAt);
        String bank = buildBankJson(capturedAt);
        String equipment = buildEquipmentJson(capturedAt);
        String skills = buildSkillsJson(capturedAt);
        String prayers = buildPrayersJson(capturedAt);
        String combat = buildCombatJson(capturedAt);
        String chat = buildChatJson(capturedAt, 25);
        String interfaceSummary = buildInterfaceSummaryJson(capturedAt);

        JsonObject snapshot = new JsonObject();
        addCaptureMeta(snapshot, capturedAt);
        snapshot.add("state", gson.fromJson(state, JsonElement.class));
        snapshot.add("npcs", gson.fromJson(npcs, JsonElement.class));
        snapshot.add("dialogue", gson.fromJson(dialogue, JsonElement.class));
        snapshot.add("objects", gson.fromJson(objects, JsonElement.class));
        snapshot.add("groundItems", gson.fromJson(groundItems, JsonElement.class));
        snapshot.add("players", gson.fromJson(players, JsonElement.class));
        snapshot.add("inventory", gson.fromJson(inventory, JsonElement.class));
        snapshot.add("bank", gson.fromJson(bank, JsonElement.class));
        snapshot.add("equipment", gson.fromJson(equipment, JsonElement.class));
        snapshot.add("skills", gson.fromJson(skills, JsonElement.class));
        snapshot.add("prayers", gson.fromJson(prayers, JsonElement.class));
        snapshot.add("combat", gson.fromJson(combat, JsonElement.class));
        snapshot.add("chat", gson.fromJson(chat, JsonElement.class));
        snapshot.add("interfaceSummary", gson.fromJson(interfaceSummary, JsonElement.class));

        return new GameStateSnapshot(capturedAt, state, npcs, dialogue, objects, groundItems, players, inventory, bank, equipment, skills, prayers, combat, chat, interfaceSummary, gson.toJson(snapshot));
    }

    private void addCaptureMeta(JsonObject response, long capturedAt) {
        response.addProperty("tick", gameTick);
        response.addProperty("clientTick", clientTick);
        response.addProperty("capturedAt", capturedAt);
        response.addProperty("ageMs", 0);
    }

    private String withCurrentAge(String json) {
        JsonElement element = gson.fromJson(json, JsonElement.class);
        updateAge(element, System.currentTimeMillis());
        return gson.toJson(element);
    }

    private void updateAge(JsonElement element, long now) {
        if (element == null || element.isJsonNull()) {
            return;
        }

        if (element.isJsonObject()) {
            JsonObject object = element.getAsJsonObject();
            if (object.has("capturedAt")) {
                object.addProperty("ageMs", now - object.get("capturedAt").getAsLong());
            }
            for (String key : object.keySet()) {
                updateAge(object.get(key), now);
            }
        } else if (element.isJsonArray()) {
            for (JsonElement child : element.getAsJsonArray()) {
                updateAge(child, now);
            }
        }
    }

    private String cachedStateOrNull(String key) {
        GameStateSnapshot snapshot = latestSnapshot.get();
        if (snapshot == null) {
            return null;
        }

        switch (key) {
            case "state":
                return withCurrentAge(snapshot.state);
            case "npcs":
                return withCurrentAge(snapshot.npcs);
            case "dialogue":
                return withCurrentAge(snapshot.dialogue);
            case "objects":
                return withCurrentAge(snapshot.objects);
            case "grounditems":
                return withCurrentAge(snapshot.groundItems);
            case "players":
                return withCurrentAge(snapshot.players);
            case "inventory":
                return withCurrentAge(snapshot.inventory);
            case "bank":
                return withCurrentAge(snapshot.bank);
            case "equipment":
                return withCurrentAge(snapshot.equipment);
            case "skills":
                return withCurrentAge(snapshot.skills);
            case "prayers":
                return withCurrentAge(snapshot.prayers);
            case "combat":
                return withCurrentAge(snapshot.combat);
            case "chat":
                return withCurrentAge(snapshot.chat);
            case "interface_summary":
                return withCurrentAge(snapshot.interfaceSummary);
            case "snapshot":
                return withCurrentAge(snapshot.snapshot);
            default:
                return null;
        }
    }

    private boolean sendCachedResponse(HttpExchange exchange, String key) throws IOException {
        String cached = cachedStateOrNull(key);
        if (cached == null) {
            return false;
        }

        sendResponse(exchange, 200, cached);
        return true;
    }

    private JsonObject endpoint(String path, String description) {
        JsonObject endpoint = new JsonObject();
        endpoint.addProperty("path", path);
        endpoint.addProperty("description", description);
        return endpoint;
    }

    private String getBaseUrl() {
        return "http://localhost:" + port + "/api";
    }

    private String getApiIndexJson() {
        JsonObject response = new JsonObject();
        response.addProperty("name", "OSRS MCP RuneLite API");
        response.addProperty("description", "Local RuneLite game-state and action API for the OSRS MCP server. Runtime data and in-client actions are handled safely on the RuneLite client thread.");
        response.addProperty("baseUrl", getBaseUrl());

        JsonArray endpoints = new JsonArray();
        endpoints.add(endpoint("/api/action/menu", "POST a RuneLite menu action on the client thread using param0, param1, menuAction/type, identifier, itemId, option, and target."));
        endpoints.add(endpoint("/api/action/walk", "POST a local-scene walk action using worldX, worldY, and optional plane. Uses RuneLite WALK menu action on the client thread."));
        endpoints.add(endpoint("/api/action/widget", "POST a widget menu action using raw widget/menu params or packedId/groupId/childId plus actionIndex."));
        endpoints.add(endpoint("/api/state", "Current login status, player name, hitpoints, run energy, and world location."));
        endpoints.add(endpoint("/api/inventory", "Inventory item IDs, names, quantities, and slots."));
        endpoints.add(endpoint("/api/npcs", "Nearby NPC IDs, names, world coordinates, canvas coordinates, and absolute screen coordinates."));
        endpoints.add(endpoint("/api/dialogue", "Open NPC/player dialogue text, dialogue options, canvas coordinates, and absolute screen coordinates when available."));
        endpoints.add(endpoint("/api/objects", "Scene game object IDs, names, world coordinates, canvas coordinates, and absolute screen coordinates."));
        endpoints.add(endpoint("/api/grounditems", "Visible ground item IDs, names, quantities, world coordinates, canvas coordinates, and absolute screen coordinates."));
        endpoints.add(endpoint("/api/players", "Visible players with combat level, world coordinates, animation/interacting state, and screen coordinates when available."));
        endpoints.add(endpoint("/api/bank", "Bank item IDs, names, quantities, and slots when the bank container is available."));
        endpoints.add(endpoint("/api/bank_actions", "Visible bank and inventory widgets with Withdraw/Deposit actions and click coordinates."));
        endpoints.add(endpoint("/api/equipment", "Equipped item IDs, names, quantities, and slots."));
        endpoints.add(endpoint("/api/skills", "Real level, boosted level, and XP for each skill."));
        endpoints.add(endpoint("/api/interface_summary", "Compact summary of open/high-value interfaces and visible widget bounds."));
        endpoints.add(endpoint("/api/widgets?filter=withdraw&maxWidgets=250&maxDepth=6", "Bounded generic widget inspector with ids, text, actions, bounds, and screen coordinates for complex interfaces."));
        endpoints.add(endpoint("/api/vars?varbits=1,2&varps=3,4", "Read selected varbit and varp values for quest/state tools without dumping every game variable."));
        endpoints.add(endpoint("/api/quest_state?name=Cook%27s%20Assistant", "Read RuneLite quest state by name, enum name, or id; omit name for all quest states."));
        endpoints.add(endpoint("/api/prayers", "Prayer level, active prayers, prayer varbits, and prayer/quick-prayer orb click coordinates."));
        endpoints.add(endpoint("/api/combat", "Combat style widgets, auto-retaliate widget, tab coordinates, and current player combat state."));
        endpoints.add(endpoint("/api/shop", "Visible shop/trade action widgets and shop inventory-side container data when a shop interface is open."));
        endpoints.add(endpoint("/api/camera", "Camera yaw, pitch, position, map angle, minimap zoom, and player orientation context."));
        endpoints.add(endpoint("/api/debug/coordinates", "Canvas origin, canvas size, DPI transform, mouse position, and player coordinate debug data."));
        endpoints.add(endpoint("/api/snapshot", "Latest cached tick snapshot for state, NPCs, dialogue, objects, and ground items."));
        endpoints.add(endpoint("/api/stream", "Server-Sent Events stream of latest cached snapshots. Keeps realtime state out of prompts unless a tool asks for it."));
        endpoints.add(endpoint("/api/context_menu", "Current RuneLite right-click/context menu options with approximate screen coordinates when open."));
        endpoints.add(endpoint("/api/minimap", "Minimap bounds and optional world tile projection for walk tools."));
        endpoints.add(endpoint("/api/path?worldX=3200&worldY=3200&plane=0", "Collision-aware local-scene A* path from player to a loaded-scene world tile."));
        endpoints.add(endpoint("/api/chat", "Recent buffered RuneLite chat/game messages for feedback and error detection."));
        endpoints.add(endpoint("/api/events", "Recent plugin event buffer including chat, animation changes, item-container changes, and widget loads."));
        endpoints.add(endpoint("/api/identity", "Stable plugin instance identity, player name when available, port, and last snapshot time."));
        response.add("endpoints", endpoints);

        return gson.toJson(response);
    }

    private java.awt.Point getCanvasScreenLocation() {
        try {
            if (client.getCanvas() == null || !client.getCanvas().isShowing()) {
                return null;
            }
            return client.getCanvas().getLocationOnScreen();
        } catch (IllegalComponentStateException e) {
            return null;
        }
    }

    private double getCanvasScaleX() {
        Component canvas = client.getCanvas();
        if (canvas == null || canvas.getGraphicsConfiguration() == null) {
            return 1.0;
        }

        return canvas.getGraphicsConfiguration().getDefaultTransform().getScaleX();
    }

    private double getCanvasScaleY() {
        Component canvas = client.getCanvas();
        if (canvas == null || canvas.getGraphicsConfiguration() == null) {
            return 1.0;
        }

        return canvas.getGraphicsConfiguration().getDefaultTransform().getScaleY();
    }

    private int toNutScreenX(int awtScreenX) {
        Component canvas = client.getCanvas();
        if (canvas == null || canvas.getGraphicsConfiguration() == null) {
            return awtScreenX;
        }

        GraphicsConfiguration config = canvas.getGraphicsConfiguration();
        Rectangle bounds = config.getBounds();
        double scaleX = config.getDefaultTransform().getScaleX();
        return bounds.x + (int) Math.round((awtScreenX - bounds.x) * scaleX);
    }

    private int toNutScreenY(int awtScreenY) {
        Component canvas = client.getCanvas();
        if (canvas == null || canvas.getGraphicsConfiguration() == null) {
            return awtScreenY;
        }

        GraphicsConfiguration config = canvas.getGraphicsConfiguration();
        Rectangle bounds = config.getBounds();
        double scaleY = config.getDefaultTransform().getScaleY();
        return bounds.y + (int) Math.round((awtScreenY - bounds.y) * scaleY);
    }

    private boolean isCanvasOnAnyScreen(java.awt.Point canvasOrigin) {
        Component canvas = client.getCanvas();
        if (canvas == null || canvasOrigin == null) {
            return false;
        }

        Rectangle canvasBounds = new Rectangle(canvasOrigin.x, canvasOrigin.y, canvas.getWidth(), canvas.getHeight());
        try {
            for (GraphicsDevice device : GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices()) {
                GraphicsConfiguration config = device.getDefaultConfiguration();
                if (config != null && config.getBounds().intersects(canvasBounds)) {
                    return true;
                }
            }
        } catch (RuntimeException e) {
            return true;
        }

        return false;
    }

    private boolean isCanvasPointVisible(int canvasX, int canvasY) {
        Component canvas = client.getCanvas();
        if (canvas == null) {
            return false;
        }

        return canvasX >= 0 && canvasY >= 0 && canvasX < canvas.getWidth() && canvasY < canvas.getHeight();
    }

    private void addCanvasAndScreenCoordinates(JsonObject response, int canvasX, int canvasY) {
        response.addProperty("canvasX", canvasX);
        response.addProperty("canvasY", canvasY);

        java.awt.Point canvasOrigin = getCanvasScreenLocation();
        if (canvasOrigin != null) {
            int awtScreenX = canvasOrigin.x + canvasX;
            int awtScreenY = canvasOrigin.y + canvasY;
            response.addProperty("canvasOriginX", canvasOrigin.x);
            response.addProperty("canvasOriginY", canvasOrigin.y);
            response.addProperty("awtScreenX", awtScreenX);
            response.addProperty("awtScreenY", awtScreenY);
            response.addProperty("screenScaleX", getCanvasScaleX());
            response.addProperty("screenScaleY", getCanvasScaleY());
            response.addProperty("canvasOnScreen", isCanvasOnAnyScreen(canvasOrigin));
            response.addProperty("canvasPointVisible", isCanvasPointVisible(canvasX, canvasY));
            if (isCanvasOnAnyScreen(canvasOrigin) && isCanvasPointVisible(canvasX, canvasY)) {
                response.addProperty("screenX", toNutScreenX(awtScreenX));
                response.addProperty("screenY", toNutScreenY(awtScreenY));
            } else if (!isCanvasPointVisible(canvasX, canvasY)) {
                response.addProperty("coordinateWarning", "CANVAS_POINT_OUTSIDE_VISIBLE_CANVAS");
            } else {
                response.addProperty("coordinateWarning", "CANVAS_OFFSCREEN_OR_MINIMIZED");
            }
        }
    }

    private void addPrefixedCanvasAndScreenCoordinates(JsonObject response, String prefix, int canvasX, int canvasY) {
        response.addProperty(prefix + "CanvasX", canvasX);
        response.addProperty(prefix + "CanvasY", canvasY);

        java.awt.Point canvasOrigin = getCanvasScreenLocation();
        if (canvasOrigin != null) {
            int awtScreenX = canvasOrigin.x + canvasX;
            int awtScreenY = canvasOrigin.y + canvasY;
            response.addProperty("canvasOriginX", canvasOrigin.x);
            response.addProperty("canvasOriginY", canvasOrigin.y);
            response.addProperty(prefix + "AwtScreenX", awtScreenX);
            response.addProperty(prefix + "AwtScreenY", awtScreenY);
            response.addProperty("screenScaleX", getCanvasScaleX());
            response.addProperty("screenScaleY", getCanvasScaleY());
            response.addProperty("canvasOnScreen", isCanvasOnAnyScreen(canvasOrigin));
            response.addProperty(prefix + "CanvasPointVisible", isCanvasPointVisible(canvasX, canvasY));
            if (isCanvasOnAnyScreen(canvasOrigin) && isCanvasPointVisible(canvasX, canvasY)) {
                response.addProperty(prefix + "ScreenX", toNutScreenX(awtScreenX));
                response.addProperty(prefix + "ScreenY", toNutScreenY(awtScreenY));
            } else if (!isCanvasPointVisible(canvasX, canvasY)) {
                response.addProperty("coordinateWarning", "CANVAS_POINT_OUTSIDE_VISIBLE_CANVAS");
            } else {
                response.addProperty("coordinateWarning", "CANVAS_OFFSCREEN_OR_MINIMIZED");
            }
        }
    }

    private void addWidgetCenter(JsonObject response, Widget widget, String prefix) {
        if (widget == null || widget.isHidden()) {
            return;
        }

        Rectangle bounds = widget.getBounds();
        if (bounds != null) {
            addBounds(response, prefix + "Bounds", bounds);
            addPrefixedCanvasAndScreenCoordinates(response, prefix, (int) bounds.getCenterX(), (int) bounds.getCenterY());
        }
    }

    private JsonObject buildWidgetJson(String label, WidgetInfo widgetInfo, Widget widget, long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("label", label);
        if (widgetInfo != null) {
            response.addProperty("widgetInfo", widgetInfo.name());
            response.addProperty("packedId", widgetInfo.getPackedId());
            response.addProperty("groupId", widgetInfo.getGroupId());
            response.addProperty("childId", widgetInfo.getChildId());
        }

        if (widget == null) {
            response.addProperty("available", false);
            return response;
        }

        response.addProperty("available", true);
        response.addProperty("hidden", widget.isHidden());
        response.addProperty("text", widget.getText() != null ? widget.getText() : "");
        response.addProperty("name", widget.getName() != null ? widget.getName() : "");
        response.addProperty("itemId", widget.getItemId());
        response.addProperty("itemQuantity", widget.getItemQuantity());

        String[] actions = widget.getActions();
        JsonArray actionsJson = new JsonArray();
        if (actions != null) {
            for (String action : actions) {
                if (action != null && !action.trim().isEmpty()) {
                    actionsJson.add(action);
                }
            }
        }
        response.add("actions", actionsJson);

        Rectangle bounds = widget.getBounds();
        if (bounds != null && !bounds.isEmpty()) {
            addBounds(response, "bounds", bounds);
            response.addProperty("coordinateSource", "widgetBounds");
            addCanvasAndScreenCoordinates(response, (int) bounds.getCenterX(), (int) bounds.getCenterY());
        }
        return response;
    }

    private void addWidgetControl(JsonArray controls, String label, WidgetInfo widgetInfo, long capturedAt) {
        controls.add(buildWidgetJson(label, widgetInfo, client.getWidget(widgetInfo), capturedAt));
    }

    private void addBounds(JsonObject response, String property, Rectangle bounds) {
        if (bounds == null) {
            return;
        }

        JsonObject boundsJson = new JsonObject();
        boundsJson.addProperty("x", bounds.x);
        boundsJson.addProperty("y", bounds.y);
        boundsJson.addProperty("width", bounds.width);
        boundsJson.addProperty("height", bounds.height);
        boundsJson.addProperty("centerX", (int) bounds.getCenterX());
        boundsJson.addProperty("centerY", (int) bounds.getCenterY());
        response.add(property, boundsJson);
    }

    private void addCanvasCoordinateFromShape(JsonObject response, Shape shape, String source) {
        if (shape == null) {
            return;
        }

        Rectangle bounds = shape.getBounds();
        if (bounds == null || bounds.isEmpty()) {
            return;
        }

        response.addProperty("coordinateSource", source);
        addBounds(response, "clickboxBounds", bounds);
        addCanvasAndScreenCoordinates(response, (int) bounds.getCenterX(), (int) bounds.getCenterY());
    }

    private boolean hasCanvasCoordinates(JsonObject response) {
        return response.has("canvasX") && response.has("canvasY");
    }

    private void addRawLocalPoint(JsonObject response, LocalPoint lp, boolean useAsFallback, String fallbackSource) {
        if (lp == null) {
            return;
        }

        Point rawPoint = Perspective.localToCanvas(client, lp, client.getPlane());
        if (rawPoint != null) {
            response.addProperty("rawCanvasX", rawPoint.getX());
            response.addProperty("rawCanvasY", rawPoint.getY());
            if (useAsFallback && !hasCanvasCoordinates(response)) {
                response.addProperty("coordinateSource", fallbackSource);
                addCanvasAndScreenCoordinates(response, rawPoint.getX(), rawPoint.getY());
            }
        }
    }

    private String getItemName(int itemId) {
        if (itemId <= 0) {
            return "";
        }

        String name = itemManager.getItemComposition(itemId).getName();
        return name != null ? name : "";
    }

    private String getObjectName(int objectId) {
        if (objectId <= 0) {
            return "";
        }

        String name = client.getObjectDefinition(objectId).getName();
        return name != null ? name : "";
    }

    private String getNpcName(NPC npc) {
        String name = npc.getName();
        if (name != null && !name.isEmpty()) {
            return name;
        }

        if (npc.getId() <= 0) {
            return "";
        }

        String definitionName = client.getNpcDefinition(npc.getId()).getName();
        return definitionName != null ? definitionName : "";
    }

    private JsonObject getCoordinateDebug() {
        JsonObject response = new JsonObject();
        Component canvas = client.getCanvas();
        java.awt.Point canvasOrigin = getCanvasScreenLocation();

        response.addProperty("coordinateContract", "canvasX/canvasY are RuneLite canvas-relative. screenX/screenY are intended for nut-js absolute desktop pixels.");
        response.addProperty("screenCoordinateFormula", "awtScreen = canvasOrigin + canvas; screen = graphicsConfigBounds.origin + ((awtScreen - graphicsConfigBounds.origin) * defaultTransformScale)");
        response.addProperty("canvasShowing", canvas != null && canvas.isShowing());
        addWindowFocusState(response);

        if (canvas != null) {
            response.addProperty("canvasWidth", canvas.getWidth());
            response.addProperty("canvasHeight", canvas.getHeight());
            response.addProperty("canvasClass", canvas.getClass().getName());

            GraphicsConfiguration config = canvas.getGraphicsConfiguration();
            if (config != null) {
                AffineTransform transform = config.getDefaultTransform();
                AffineTransform normalizingTransform = config.getNormalizingTransform();
                response.addProperty("defaultTransformScaleX", transform.getScaleX());
                response.addProperty("defaultTransformScaleY", transform.getScaleY());
                response.addProperty("normalizingTransformScaleX", normalizingTransform.getScaleX());
                response.addProperty("normalizingTransformScaleY", normalizingTransform.getScaleY());

                Rectangle bounds = config.getBounds();
                addBounds(response, "graphicsConfigBounds", bounds);
            }
        }

        if (canvasOrigin != null) {
            response.addProperty("canvasOriginX", canvasOrigin.x);
            response.addProperty("canvasOriginY", canvasOrigin.y);
            response.addProperty("canvasOnScreen", isCanvasOnAnyScreen(canvasOrigin));
            response.addProperty("screenScaleX", getCanvasScaleX());
            response.addProperty("screenScaleY", getCanvasScaleY());
            response.addProperty("canvasOriginNutX", toNutScreenX(canvasOrigin.x));
            response.addProperty("canvasOriginNutY", toNutScreenY(canvasOrigin.y));
        }

        try {
            response.addProperty("toolkitScreenResolutionDpi", Toolkit.getDefaultToolkit().getScreenResolution());
        } catch (RuntimeException e) {
            response.addProperty("toolkitScreenResolutionError", e.getMessage());
        }

        PointerInfo pointer = MouseInfo.getPointerInfo();
        if (pointer != null && pointer.getLocation() != null) {
            response.addProperty("awtMouseX", pointer.getLocation().x);
            response.addProperty("awtMouseY", pointer.getLocation().y);
        }

        JsonArray devices = new JsonArray();
        try {
            for (GraphicsDevice device : GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices()) {
                JsonObject deviceJson = new JsonObject();
                deviceJson.addProperty("id", device.getIDstring());
                GraphicsConfiguration config = device.getDefaultConfiguration();
                if (config != null) {
                    addBounds(deviceJson, "bounds", config.getBounds());
                    AffineTransform transform = config.getDefaultTransform();
                    deviceJson.addProperty("defaultTransformScaleX", transform.getScaleX());
                    deviceJson.addProperty("defaultTransformScaleY", transform.getScaleY());
                }
                devices.add(deviceJson);
            }
        } catch (RuntimeException e) {
            response.addProperty("screenDevicesError", e.getMessage());
        }
        response.add("screenDevices", devices);

        Player player = client.getLocalPlayer();
        if (player != null) {
            JsonObject playerJson = new JsonObject();
            playerJson.addProperty("name", player.getName());
            WorldPoint wp = player.getWorldLocation();
            if (wp != null) {
                playerJson.addProperty("worldX", wp.getX());
                playerJson.addProperty("worldY", wp.getY());
                playerJson.addProperty("plane", wp.getPlane());
            }
            addRawLocalPoint(playerJson, player.getLocalLocation(), true, "localPoint");
            Shape hull = player.getConvexHull();
            if (hull != null) {
                addBounds(playerJson, "clickboxBounds", hull.getBounds());
            }
            response.add("player", playerJson);
        }

        return response;
    }

    private void addDistanceToPlayer(JsonObject response, WorldPoint wp) {
        Player player = client.getLocalPlayer();
        if (player == null || wp == null || player.getWorldLocation() == null) {
            return;
        }

        WorldPoint playerPoint = player.getWorldLocation();
        if (playerPoint.getPlane() != wp.getPlane()) {
            return;
        }

        int distance = Math.abs(playerPoint.getX() - wp.getX()) + Math.abs(playerPoint.getY() - wp.getY());
        response.addProperty("distanceToPlayer", distance);
    }

    private void addEntityKey(JsonObject response, String type, int id, String name, WorldPoint wp, Integer index) {
        if (wp == null) {
            return;
        }

        String safeName = name != null ? name : "";
        StringBuilder key = new StringBuilder();
        key.append(type)
            .append(":").append(id)
            .append(":").append(safeName)
            .append(":").append(wp.getX())
            .append(":").append(wp.getY())
            .append(":").append(wp.getPlane());
        if (index != null) {
            key.append(":").append(index);
        }
        response.addProperty("entityKey", key.toString());
    }

    public void addChatMessage(String type, String name, String sender, String message, int timestamp) {
        JsonObject chatMessage = new JsonObject();
        chatMessage.addProperty("tick", gameTick);
        chatMessage.addProperty("clientTick", clientTick);
        chatMessage.addProperty("capturedAt", System.currentTimeMillis());
        chatMessage.addProperty("ageMs", 0);
        chatMessage.addProperty("type", type != null ? type : "");
        chatMessage.addProperty("name", name != null ? name : "");
        chatMessage.addProperty("sender", sender != null ? sender : "");
        chatMessage.addProperty("message", message != null ? message : "");
        chatMessage.addProperty("timestamp", timestamp);

        synchronized (recentChatMessages) {
            recentChatMessages.add(gson.toJson(chatMessage));
            while (recentChatMessages.size() > RECENT_CHAT_LIMIT) {
                recentChatMessages.remove(0);
            }
        }
        addPluginEvent("ChatMessage", chatMessage);
    }

    public void addAnimationChanged(String actorName, int animation, boolean localPlayer) {
        JsonObject details = new JsonObject();
        details.addProperty("actorName", actorName != null ? actorName : "");
        details.addProperty("animation", animation);
        details.addProperty("localPlayer", localPlayer);
        addPluginEvent("AnimationChanged", details);
    }

    public void addItemContainerChanged(int containerId, int itemCount) {
        JsonObject details = new JsonObject();
        details.addProperty("containerId", containerId);
        details.addProperty("itemCount", itemCount);
        addPluginEvent("ItemContainerChanged", details);
    }

    public void addWidgetLoaded(int groupId) {
        JsonObject details = new JsonObject();
        details.addProperty("groupId", groupId);
        addPluginEvent("WidgetLoaded", details);
    }

    public void addPluginEvent(String eventType, JsonObject details) {
        JsonObject event = new JsonObject();
        addCaptureMeta(event, System.currentTimeMillis());
        event.addProperty("eventType", eventType != null ? eventType : "");
        event.add("details", details != null ? details : new JsonObject());

        synchronized (recentEvents) {
            recentEvents.add(gson.toJson(event));
            while (recentEvents.size() > RECENT_EVENT_LIMIT) {
                recentEvents.remove(0);
            }
        }
    }

    private String buildStateJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        if (client.getGameState() != GameState.LOGGED_IN) {
            response.addProperty("status", "NOT_LOGGED_IN");
            return gson.toJson(response);
        }

        Player player = client.getLocalPlayer();
        if (player != null) {
            response.addProperty("status", "LOGGED_IN");
            response.addProperty("name", player.getName());
            response.addProperty("health", client.getBoostedSkillLevel(Skill.HITPOINTS));
            response.addProperty("runEnergy", client.getEnergy());
            response.addProperty("animation", player.getAnimation());
            response.addProperty("isIdle", player.getAnimation() == -1 && player.getInteracting() == null);
            if (player.getInteracting() != null) {
                response.addProperty("interactingWith", player.getInteracting().getName());
            }

            WorldPoint wp = player.getWorldLocation();
            JsonObject location = new JsonObject();
            location.addProperty("x", wp.getX());
            location.addProperty("y", wp.getY());
            location.addProperty("plane", wp.getPlane());
            response.add("location", location);
        }

        return gson.toJson(response);
    }

    private String buildNpcsJson(long capturedAt) {
        JsonArray response = new JsonArray();
        if (client.getGameState() != GameState.LOGGED_IN) {
            return gson.toJson(response);
        }

        List<NPC> npcs = client.getNpcs();
        for (NPC npc : npcs) {
            JsonObject npcObj = new JsonObject();
            addCaptureMeta(npcObj, capturedAt);
            String name = getNpcName(npc);
            npcObj.addProperty("id", npc.getId());
            npcObj.addProperty("name", name);
            npcObj.addProperty("index", npc.getIndex());
            npcObj.addProperty("animation", npc.getAnimation());
            npcObj.addProperty("isDead", npc.isDead());
            npcObj.addProperty("healthRatio", npc.getHealthRatio());

            if (npc.getInteracting() != null) {
                npcObj.addProperty("interactingWith", npc.getInteracting().getName());
            }

            WorldPoint wp = npc.getWorldLocation();
            npcObj.addProperty("worldX", wp.getX());
            npcObj.addProperty("worldY", wp.getY());
            npcObj.addProperty("plane", wp.getPlane());
            addDistanceToPlayer(npcObj, wp);
            addEntityKey(npcObj, "npc", npc.getId(), name, wp, npc.getIndex());

            addRawLocalPoint(npcObj, npc.getLocalLocation(), false, "localPoint");
            addCanvasCoordinateFromShape(npcObj, npc.getConvexHull(), "convexHull");
            if (!hasCanvasCoordinates(npcObj)) {
                npcObj.addProperty("coordinateWarning", "CONVEX_HULL_UNAVAILABLE");
            }
            response.add(npcObj);
        }
        return gson.toJson(response);
    }

    private String buildDialogueJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);

        Widget npcDialogueText = client.getWidget(WidgetInfo.DIALOG_NPC_TEXT);
        Widget npcDialogueName = client.getWidget(WidgetInfo.DIALOG_NPC_NAME);

        if (npcDialogueText != null && !npcDialogueText.isHidden()) {
            response.addProperty("type", "NPC_DIALOGUE");
            response.addProperty("npcName", npcDialogueName != null ? npcDialogueName.getText() : "");
            response.addProperty("text", npcDialogueText.getText());
            addWidgetCenter(response, npcDialogueText, "continue");
            return gson.toJson(response);
        }

        Widget playerDialogueText = client.getWidget(WidgetInfo.DIALOG_PLAYER_TEXT);
        if (playerDialogueText != null && !playerDialogueText.isHidden()) {
            response.addProperty("type", "PLAYER_DIALOGUE");
            response.addProperty("text", playerDialogueText.getText());
            addWidgetCenter(response, playerDialogueText, "continue");
            return gson.toJson(response);
        }

        Widget dialogueOptions = client.getWidget(WidgetInfo.DIALOG_OPTION_OPTIONS);
        if (dialogueOptions != null && !dialogueOptions.isHidden()) {
            response.addProperty("type", "DIALOGUE_OPTIONS");
            JsonArray options = new JsonArray();
            Widget[] children = dialogueOptions.getDynamicChildren();
            if (children != null) {
                for (Widget child : children) {
                    if (child.getText() != null && !child.getText().isEmpty() && !child.getText().equals("Please wait...")) {
                        JsonObject opt = new JsonObject();
                        addCaptureMeta(opt, capturedAt);
                        opt.addProperty("text", child.getText());
                        Rectangle bounds = child.getBounds();
                        if (bounds != null) {
                            addBounds(opt, "bounds", bounds);
                            opt.addProperty("coordinateSource", "widgetBounds");
                            addCanvasAndScreenCoordinates(opt, (int) bounds.getCenterX(), (int) bounds.getCenterY());
                        }
                        options.add(opt);
                    }
                }
            }
            response.add("options", options);
            return gson.toJson(response);
        }

        response.addProperty("type", "NONE");
        return gson.toJson(response);
    }

    private String buildObjectsJson(long capturedAt) {
        JsonArray response = new JsonArray();
        if (client.getGameState() != GameState.LOGGED_IN) {
            return gson.toJson(response);
        }

        Tile[][] tiles = client.getScene().getTiles()[client.getPlane()];
        for (Tile[] column : tiles) {
            for (Tile tile : column) {
                if (tile == null) {
                    continue;
                }
                GameObject[] gameObjects = tile.getGameObjects();
                if (gameObjects == null) {
                    continue;
                }
                for (GameObject obj : gameObjects) {
                    if (obj == null || obj.getId() == -1) {
                        continue;
                    }
                    JsonObject jsonObj = new JsonObject();
                    addCaptureMeta(jsonObj, capturedAt);
                    String name = getObjectName(obj.getId());
                    jsonObj.addProperty("id", obj.getId());
                    jsonObj.addProperty("name", name);

                    WorldPoint wp = obj.getWorldLocation();
                    jsonObj.addProperty("worldX", wp.getX());
                    jsonObj.addProperty("worldY", wp.getY());
                    jsonObj.addProperty("plane", wp.getPlane());
                    addDistanceToPlayer(jsonObj, wp);
                    addEntityKey(jsonObj, "object", obj.getId(), name, wp, null);

                    addRawLocalPoint(jsonObj, obj.getLocalLocation(), false, "localPoint");
                    addCanvasCoordinateFromShape(jsonObj, obj.getClickbox(), "clickbox");
                    if (!hasCanvasCoordinates(jsonObj)) {
                        jsonObj.addProperty("coordinateWarning", "CLICKBOX_UNAVAILABLE");
                    }
                    response.add(jsonObj);
                }
            }
        }
        return gson.toJson(response);
    }

    private String buildGroundItemsJson(long capturedAt) {
        JsonArray response = new JsonArray();
        if (client.getGameState() != GameState.LOGGED_IN) {
            return gson.toJson(response);
        }

        Tile[][] tiles = client.getScene().getTiles()[client.getPlane()];
        for (Tile[] column : tiles) {
            for (Tile tile : column) {
                if (tile == null || tile.getGroundItems() == null) {
                    continue;
                }
                for (TileItem item : tile.getGroundItems()) {
                    JsonObject jsonObj = new JsonObject();
                    addCaptureMeta(jsonObj, capturedAt);
                    String name = getItemName(item.getId());
                    jsonObj.addProperty("id", item.getId());
                    jsonObj.addProperty("name", name);
                    jsonObj.addProperty("quantity", item.getQuantity());

                    WorldPoint wp = tile.getWorldLocation();
                    jsonObj.addProperty("worldX", wp.getX());
                    jsonObj.addProperty("worldY", wp.getY());
                    jsonObj.addProperty("plane", wp.getPlane());
                    addDistanceToPlayer(jsonObj, wp);
                    addEntityKey(jsonObj, "groundItem", item.getId(), name, wp, null);

                    addRawLocalPoint(jsonObj, tile.getLocalLocation(), true, "tileLocalPoint");
                    response.add(jsonObj);
                }
            }
        }
        return gson.toJson(response);
    }

    private String buildPlayersJson(long capturedAt) {
        JsonArray response = new JsonArray();
        if (client.getGameState() != GameState.LOGGED_IN) {
            return gson.toJson(response);
        }

        List<Player> players = client.getPlayers();
        for (Player player : players) {
            if (player == null) {
                continue;
            }

            JsonObject playerObj = new JsonObject();
            addCaptureMeta(playerObj, capturedAt);
            playerObj.addProperty("name", player.getName());
            playerObj.addProperty("combatLevel", player.getCombatLevel());
            playerObj.addProperty("animation", player.getAnimation());
            playerObj.addProperty("healthRatio", player.getHealthRatio());
            if (player.getInteracting() != null) {
                playerObj.addProperty("interactingWith", player.getInteracting().getName());
            }

            WorldPoint wp = player.getWorldLocation();
            if (wp != null) {
                playerObj.addProperty("worldX", wp.getX());
                playerObj.addProperty("worldY", wp.getY());
                playerObj.addProperty("plane", wp.getPlane());
                addDistanceToPlayer(playerObj, wp);
                addEntityKey(playerObj, "player", player.getCombatLevel(), player.getName(), wp, null);
            }

            addRawLocalPoint(playerObj, player.getLocalLocation(), false, "localPoint");
            addCanvasCoordinateFromShape(playerObj, player.getConvexHull(), "convexHull");
            if (!hasCanvasCoordinates(playerObj)) {
                playerObj.addProperty("coordinateWarning", "CONVEX_HULL_UNAVAILABLE");
            }
            response.add(playerObj);
        }

        return gson.toJson(response);
    }

    private void addInventorySlotCoordinates(JsonObject itemObj, int slot) {
        Widget inventoryWidget = client.getWidget(WidgetInfo.INVENTORY);
        if (inventoryWidget == null || inventoryWidget.isHidden()) {
            return;
        }

        Widget[] children = inventoryWidget.getDynamicChildren();
        if (children == null || slot < 0 || slot >= children.length || children[slot] == null) {
            return;
        }

        Rectangle bounds = children[slot].getBounds();
        if (bounds == null || bounds.isEmpty()) {
            return;
        }

        addBounds(itemObj, "slotBounds", bounds);
        itemObj.addProperty("coordinateSource", "inventorySlotWidget");
        addPrefixedCanvasAndScreenCoordinates(itemObj, "slot", (int) bounds.getCenterX(), (int) bounds.getCenterY());
    }

    private String buildInventoryJson(long capturedAt) {
        JsonArray response = new JsonArray();
        ItemContainer inventory = client.getItemContainer(InventoryID.INVENTORY);
        if (inventory != null) {
            Item[] items = inventory.getItems();
            for (int i = 0; i < items.length; i++) {
                Item item = items[i];
                if (item.getId() != -1 && item.getId() != 0) {
                    JsonObject itemObj = new JsonObject();
                    addCaptureMeta(itemObj, capturedAt);
                    itemObj.addProperty("id", item.getId());
                    itemObj.addProperty("name", getItemName(item.getId()));
                    itemObj.addProperty("quantity", item.getQuantity());
                    itemObj.addProperty("slot", i);
                    addInventorySlotCoordinates(itemObj, i);
                    response.add(itemObj);
                }
            }
        }
        return gson.toJson(response);
    }

    private String buildBankJson(long capturedAt) {
        JsonArray response = new JsonArray();
        ItemContainer bank = client.getItemContainer(InventoryID.BANK);
        if (bank != null) {
            Item[] items = bank.getItems();
            for (int i = 0; i < items.length; i++) {
                Item item = items[i];
                if (item.getId() != -1 && item.getId() != 0) {
                    JsonObject itemObj = new JsonObject();
                    addCaptureMeta(itemObj, capturedAt);
                    itemObj.addProperty("id", item.getId());
                    itemObj.addProperty("name", getItemName(item.getId()));
                    itemObj.addProperty("quantity", item.getQuantity());
                    itemObj.addProperty("slot", i);
                    response.add(itemObj);
                }
            }
        }
        return gson.toJson(response);
    }

    private String buildEquipmentJson(long capturedAt) {
        JsonArray response = new JsonArray();
        ItemContainer equipment = client.getItemContainer(InventoryID.EQUIPMENT);
        if (equipment != null) {
            Item[] items = equipment.getItems();
            for (int i = 0; i < items.length; i++) {
                Item item = items[i];
                if (item.getId() != -1 && item.getId() != 0) {
                    JsonObject itemObj = new JsonObject();
                    addCaptureMeta(itemObj, capturedAt);
                    itemObj.addProperty("id", item.getId());
                    itemObj.addProperty("name", getItemName(item.getId()));
                    itemObj.addProperty("quantity", item.getQuantity());
                    itemObj.addProperty("slot", i);
                    response.add(itemObj);
                }
            }
        }
        return gson.toJson(response);
    }

    private String buildSkillsJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        for (Skill skill : Skill.values()) {
            if (skill != Skill.OVERALL) {
                JsonObject skillObj = new JsonObject();
                addCaptureMeta(skillObj, capturedAt);
                skillObj.addProperty("level", client.getRealSkillLevel(skill));
                skillObj.addProperty("boostedLevel", client.getBoostedSkillLevel(skill));
                skillObj.addProperty("xp", client.getSkillExperience(skill));
                response.add(skill.getName(), skillObj);
            }
        }
        return gson.toJson(response);
    }

    private Window getCanvasWindow() {
        Component canvas = client.getCanvas();
        if (canvas == null) {
            return null;
        }
        return SwingUtilities.getWindowAncestor(canvas);
    }

    private void addWindowFocusState(JsonObject response) {
        Component canvas = client.getCanvas();
        Window window = getCanvasWindow();
        response.addProperty("windowActive", window != null && window.isActive());
        response.addProperty("windowFocused", window != null && window.isFocused());
        response.addProperty("windowShowing", window != null && window.isShowing());
        response.addProperty("canvasFocusOwner", canvas != null && canvas.isFocusOwner());
        response.addProperty("canvasHasFocus", canvas != null && canvas.hasFocus());
    }

    private String buildContextMenuJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("isOpen", client.isMenuOpen());
        response.addProperty("menuX", client.getMenuX());
        response.addProperty("menuY", client.getMenuY());
        response.addProperty("menuWidth", client.getMenuWidth());
        response.addProperty("menuHeight", client.getMenuHeight());
        response.addProperty("menuScroll", client.getMenuScroll());

        JsonArray entries = new JsonArray();
        MenuEntry[] menuEntries = client.getMenuEntries();
        int displayIndex = 0;
        for (int i = menuEntries.length - 1; i >= 0; i--) {
            MenuEntry entry = menuEntries[i];
            JsonObject item = new JsonObject();
            addCaptureMeta(item, capturedAt);
            item.addProperty("index", i);
            item.addProperty("displayIndex", displayIndex);
            item.addProperty("option", entry.getOption());
            item.addProperty("target", entry.getTarget());
            item.addProperty("identifier", entry.getIdentifier());
            item.addProperty("param0", entry.getParam0());
            item.addProperty("param1", entry.getParam1());
            item.addProperty("type", entry.getType() != null ? entry.getType().name() : "");
            item.addProperty("itemId", entry.getItemId());

            if (client.isMenuOpen()) {
                int rowCanvasX = client.getMenuX() + Math.max(8, client.getMenuWidth() / 2);
                int rowCanvasY = client.getMenuY() + 21 + (displayIndex * 15);
                item.addProperty("coordinateSource", "contextMenuRow");
                addCanvasAndScreenCoordinates(item, rowCanvasX, rowCanvasY);
            }

            entries.add(item);
            displayIndex++;
        }
        response.add("entries", entries);
        return gson.toJson(response);
    }

    private MenuAction parseMenuAction(JsonObject request) {
        String action = getString(request, "menuAction", getString(request, "type", ""));
        if (action == null || action.trim().isEmpty()) {
            throw new IllegalArgumentException("menuAction or type is required");
        }
        return MenuAction.valueOf(action.trim().toUpperCase());
    }

    private int getRequiredInt(JsonObject request, String key) {
        if (!request.has(key) || request.get(key).isJsonNull()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return request.get(key).getAsInt();
    }

    private int getOptionalInt(JsonObject request, String key, int fallback) {
        if (!request.has(key) || request.get(key).isJsonNull()) {
            return fallback;
        }
        return request.get(key).getAsInt();
    }

    private boolean getOptionalBoolean(JsonObject request, String key, boolean fallback) {
        if (!request.has(key) || request.get(key).isJsonNull()) {
            return fallback;
        }
        return request.get(key).getAsBoolean();
    }

    private String getString(JsonObject request, String key, String fallback) {
        if (!request.has(key) || request.get(key).isJsonNull()) {
            return fallback;
        }
        return request.get(key).getAsString();
    }

    private String invokeMenuActionJson(JsonObject request) {
        long capturedAt = System.currentTimeMillis();
        int param0 = getRequiredInt(request, "param0");
        int param1 = getRequiredInt(request, "param1");
        int identifier = request.has("identifier")
            ? getRequiredInt(request, "identifier")
            : getRequiredInt(request, "id");
        int itemId = getOptionalInt(request, "itemId", -1);
        String option = getString(request, "option", "");
        String target = getString(request, "target", "");
        MenuAction menuAction = parseMenuAction(request);
        boolean dryRun = getOptionalBoolean(request, "dryRun", false);

        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("success", true);
        response.addProperty("dryRun", dryRun);
        response.addProperty("param0", param0);
        response.addProperty("param1", param1);
        response.addProperty("identifier", identifier);
        response.addProperty("itemId", itemId);
        response.addProperty("menuAction", menuAction.name());
        response.addProperty("option", option);
        response.addProperty("target", target);

        if (!dryRun) {
            client.menuAction(param0, param1, menuAction, identifier, itemId, option, target);
        }

        return gson.toJson(response);
    }

    private MenuAction widgetMenuActionForIndex(int actionIndex) {
        switch (actionIndex) {
            case 1:
                return MenuAction.WIDGET_FIRST_OPTION;
            case 2:
                return MenuAction.WIDGET_SECOND_OPTION;
            case 3:
                return MenuAction.WIDGET_THIRD_OPTION;
            case 4:
                return MenuAction.WIDGET_FOURTH_OPTION;
            case 5:
                return MenuAction.WIDGET_FIFTH_OPTION;
            default:
                throw new IllegalArgumentException("actionIndex must be between 1 and 5 for WIDGET_*_OPTION actions; pass menuAction explicitly for other widget action types");
        }
    }

    private int packedWidgetId(JsonObject request) {
        if (request.has("packedId") && !request.get("packedId").isJsonNull()) {
            return request.get("packedId").getAsInt();
        }
        if (request.has("param1") && !request.get("param1").isJsonNull()) {
            return request.get("param1").getAsInt();
        }
        if (request.has("groupId") && request.has("childId")) {
            return (request.get("groupId").getAsInt() << 16) | request.get("childId").getAsInt();
        }
        throw new IllegalArgumentException("packedId, param1, or groupId+childId is required");
    }

    private String invokeWidgetActionJson(JsonObject request) {
        long capturedAt = System.currentTimeMillis();
        int actionIndex = getOptionalInt(request, "actionIndex", 1);
        int param0 = getOptionalInt(request, "param0", 0);
        int param1 = packedWidgetId(request);
        int identifier = getOptionalInt(request, "identifier", getOptionalInt(request, "id", actionIndex));
        int itemId = getOptionalInt(request, "itemId", -1);
        String option = getString(request, "option", "");
        String target = getString(request, "target", "");
        MenuAction menuAction = (request.has("menuAction") || request.has("type"))
            ? parseMenuAction(request)
            : widgetMenuActionForIndex(actionIndex);
        boolean dryRun = getOptionalBoolean(request, "dryRun", false);

        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("success", true);
        response.addProperty("dryRun", dryRun);
        response.addProperty("param0", param0);
        response.addProperty("param1", param1);
        response.addProperty("identifier", identifier);
        response.addProperty("itemId", itemId);
        response.addProperty("menuAction", menuAction.name());
        response.addProperty("option", option);
        response.addProperty("target", target);

        if (!dryRun) {
            client.menuAction(param0, param1, menuAction, identifier, itemId, option, target);
        }

        return gson.toJson(response);
    }

    private String invokeWalkActionJson(JsonObject request) {
        long capturedAt = System.currentTimeMillis();
        if (client.getGameState() != GameState.LOGGED_IN) {
            throw new IllegalStateException("Client is not logged in");
        }

        int worldX = getRequiredInt(request, "worldX");
        int worldY = getRequiredInt(request, "worldY");
        int plane = getOptionalInt(request, "plane", client.getPlane());
        boolean dryRun = getOptionalBoolean(request, "dryRun", false);
        WorldPoint worldPoint = new WorldPoint(worldX, worldY, plane);
        LocalPoint localPoint = LocalPoint.fromWorld(client, worldPoint);
        if (localPoint == null) {
            throw new IllegalArgumentException("Target world tile is not in the loaded scene");
        }

        int param0 = localPoint.getSceneX();
        int param1 = localPoint.getSceneY();
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("success", true);
        response.addProperty("dryRun", dryRun);
        response.addProperty("worldX", worldX);
        response.addProperty("worldY", worldY);
        response.addProperty("plane", plane);
        response.addProperty("param0", param0);
        response.addProperty("param1", param1);
        response.addProperty("identifier", 0);
        response.addProperty("itemId", -1);
        response.addProperty("menuAction", MenuAction.WALK.name());
        response.addProperty("option", "Walk here");
        response.addProperty("target", "");

        if (!dryRun) {
            client.menuAction(param0, param1, MenuAction.WALK, 0, -1, "Walk here", "");
        }

        return gson.toJson(response);
    }

    private Widget firstVisibleWidget(WidgetInfo... widgetInfos) {
        for (WidgetInfo widgetInfo : widgetInfos) {
            Widget widget = client.getWidget(widgetInfo);
            if (widget != null && !widget.isHidden()) {
                return widget;
            }
        }
        return null;
    }

    private String buildMinimapJson(long capturedAt, WorldPoint targetPoint) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        Widget minimap = firstVisibleWidget(
            WidgetInfo.RESIZABLE_MINIMAP_DRAW_AREA,
            WidgetInfo.RESIZABLE_MINIMAP_STONES_DRAW_AREA,
            WidgetInfo.FIXED_VIEWPORT_MINIMAP_DRAW_AREA,
            WidgetInfo.FIXED_VIEWPORT_MINIMAP
        );

        if (minimap != null) {
            addBounds(response, "minimapBounds", minimap.getBounds());
            Rectangle bounds = minimap.getBounds();
            if (bounds != null) {
                addPrefixedCanvasAndScreenCoordinates(response, "minimapCenter", (int) bounds.getCenterX(), (int) bounds.getCenterY());
            }
        } else {
            response.addProperty("coordinateWarning", "MINIMAP_WIDGET_UNAVAILABLE");
        }

        response.addProperty("mapAngle", client.getMapAngle());
        response.addProperty("minimapZoom", client.getMinimapZoom());

        Player player = client.getLocalPlayer();
        if (player != null && player.getWorldLocation() != null) {
            JsonObject playerJson = new JsonObject();
            WorldPoint playerPoint = player.getWorldLocation();
            playerJson.addProperty("worldX", playerPoint.getX());
            playerJson.addProperty("worldY", playerPoint.getY());
            playerJson.addProperty("plane", playerPoint.getPlane());
            Point playerMiniMapPoint = Perspective.localToMinimap(client, player.getLocalLocation());
            if (playerMiniMapPoint != null) {
                playerJson.addProperty("coordinateSource", "minimapProjection");
                addCanvasAndScreenCoordinates(playerJson, playerMiniMapPoint.getX(), playerMiniMapPoint.getY());
            }
            response.add("player", playerJson);
        }

        if (targetPoint != null) {
            JsonObject target = new JsonObject();
            target.addProperty("worldX", targetPoint.getX());
            target.addProperty("worldY", targetPoint.getY());
            target.addProperty("plane", targetPoint.getPlane());
            LocalPoint localPoint = LocalPoint.fromWorld(client, targetPoint);
            if (localPoint != null) {
                Point minimapPoint = Perspective.localToMinimap(client, localPoint);
                if (minimapPoint != null) {
                    target.addProperty("coordinateSource", "minimapProjection");
                    addCanvasAndScreenCoordinates(target, minimapPoint.getX(), minimapPoint.getY());
                } else {
                    target.addProperty("coordinateWarning", "TARGET_OUTSIDE_MINIMAP_RANGE");
                }
            } else {
                target.addProperty("coordinateWarning", "TARGET_OUTSIDE_LOADED_SCENE");
            }
            response.add("target", target);
        }

        return gson.toJson(response);
    }

    private String buildPathJson(long capturedAt, WorldPoint targetPoint, int maxNodes) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("collisionAware", true);
        response.addProperty("scope", "loaded_scene");

        Player player = client.getLocalPlayer();
        WorldView worldView = client.getTopLevelWorldView();
        if (player == null || player.getWorldLocation() == null) {
            response.addProperty("success", false);
            response.addProperty("error", "PLAYER_UNAVAILABLE");
            return gson.toJson(response);
        }
        if (worldView == null || worldView.getCollisionMaps() == null) {
            response.addProperty("success", false);
            response.addProperty("error", "COLLISION_MAP_UNAVAILABLE");
            return gson.toJson(response);
        }

        WorldPoint startWorld = player.getWorldLocation();
        int plane = targetPoint.getPlane() >= 0 ? targetPoint.getPlane() : startWorld.getPlane();
        targetPoint = new WorldPoint(targetPoint.getX(), targetPoint.getY(), plane);
        if (plane < 0 || plane >= worldView.getCollisionMaps().length || worldView.getCollisionMaps()[plane] == null) {
            response.addProperty("success", false);
            response.addProperty("error", "PLANE_UNAVAILABLE");
            return gson.toJson(response);
        }

        if (startWorld.getPlane() != plane) {
            response.addProperty("success", false);
            response.addProperty("error", "TARGET_ON_DIFFERENT_PLANE");
            response.addProperty("startPlane", startWorld.getPlane());
            response.addProperty("targetPlane", plane);
            return gson.toJson(response);
        }

        int baseX = worldView.getBaseX();
        int baseY = worldView.getBaseY();
        int sizeX = worldView.getSizeX();
        int sizeY = worldView.getSizeY();
        int startX = startWorld.getX() - baseX;
        int startY = startWorld.getY() - baseY;
        int targetX = targetPoint.getX() - baseX;
        int targetY = targetPoint.getY() - baseY;
        int[][] flags = worldView.getCollisionMaps()[plane].getFlags();

        addPathEndpoint(response, "start", startWorld, startX, startY);
        addPathEndpoint(response, "target", targetPoint, targetX, targetY);
        response.addProperty("baseX", baseX);
        response.addProperty("baseY", baseY);
        response.addProperty("sceneSizeX", sizeX);
        response.addProperty("sceneSizeY", sizeY);

        if (!isSceneCoordinate(startX, startY, sizeX, sizeY) || !isSceneCoordinate(targetX, targetY, sizeX, sizeY)) {
            response.addProperty("success", false);
            response.addProperty("error", "TARGET_OUTSIDE_LOADED_SCENE");
            return gson.toJson(response);
        }
        if (isTileBlocked(flags, targetX, targetY, sizeX, sizeY)) {
            response.addProperty("success", false);
            response.addProperty("error", "TARGET_TILE_BLOCKED");
            return gson.toJson(response);
        }

        List<PathNode> path = findLocalPath(flags, startX, startY, targetX, targetY, sizeX, sizeY, Math.max(128, maxNodes));
        if (path.isEmpty()) {
            response.addProperty("success", false);
            response.addProperty("error", "NO_LOCAL_PATH");
            return gson.toJson(response);
        }

        JsonArray steps = new JsonArray();
        for (PathNode node : path) {
            JsonObject step = new JsonObject();
            step.addProperty("sceneX", node.x);
            step.addProperty("sceneY", node.y);
            step.addProperty("worldX", baseX + node.x);
            step.addProperty("worldY", baseY + node.y);
            step.addProperty("plane", plane);
            steps.add(step);
        }

        response.addProperty("success", true);
        response.addProperty("distance", Math.max(Math.abs(targetX - startX), Math.abs(targetY - startY)));
        response.addProperty("stepsCount", steps.size());
        response.add("steps", steps);
        response.add("waypoints", buildPathWaypoints(path, baseX, baseY, plane));
        return gson.toJson(response);
    }

    private void addPathEndpoint(JsonObject response, String prefix, WorldPoint worldPoint, int sceneX, int sceneY) {
        JsonObject endpoint = new JsonObject();
        endpoint.addProperty("worldX", worldPoint.getX());
        endpoint.addProperty("worldY", worldPoint.getY());
        endpoint.addProperty("plane", worldPoint.getPlane());
        endpoint.addProperty("sceneX", sceneX);
        endpoint.addProperty("sceneY", sceneY);
        response.add(prefix, endpoint);
    }

    private boolean isSceneCoordinate(int x, int y, int sizeX, int sizeY) {
        return x >= 0 && y >= 0 && x < sizeX && y < sizeY;
    }

    private boolean isTileBlocked(int[][] flags, int x, int y, int sizeX, int sizeY) {
        return !isSceneCoordinate(x, y, sizeX, sizeY) || (flags[x][y] & BLOCK_MOVEMENT_FULL) != 0;
    }

    private boolean canMove(int[][] flags, int x, int y, int dx, int dy, int sizeX, int sizeY) {
        int nx = x + dx;
        int ny = y + dy;
        if (isTileBlocked(flags, nx, ny, sizeX, sizeY)) {
            return false;
        }

        int current = flags[x][y];
        int next = flags[nx][ny];
        if (dx == 1 && ((current & BLOCK_MOVEMENT_EAST) != 0 || (next & BLOCK_MOVEMENT_WEST) != 0)) {
            return false;
        }
        if (dx == -1 && ((current & BLOCK_MOVEMENT_WEST) != 0 || (next & BLOCK_MOVEMENT_EAST) != 0)) {
            return false;
        }
        if (dy == 1 && ((current & BLOCK_MOVEMENT_NORTH) != 0 || (next & BLOCK_MOVEMENT_SOUTH) != 0)) {
            return false;
        }
        if (dy == -1 && ((current & BLOCK_MOVEMENT_SOUTH) != 0 || (next & BLOCK_MOVEMENT_NORTH) != 0)) {
            return false;
        }

        if (dx != 0 && dy != 0) {
            if (!canMove(flags, x, y, dx, 0, sizeX, sizeY) || !canMove(flags, x, y, 0, dy, sizeX, sizeY)) {
                return false;
            }
            if (dx == 1 && dy == 1 && ((current & BLOCK_MOVEMENT_NORTH_EAST) != 0 || (next & BLOCK_MOVEMENT_SOUTH_WEST) != 0)) {
                return false;
            }
            if (dx == 1 && dy == -1 && ((current & BLOCK_MOVEMENT_SOUTH_EAST) != 0 || (next & BLOCK_MOVEMENT_NORTH_WEST) != 0)) {
                return false;
            }
            if (dx == -1 && dy == 1 && ((current & BLOCK_MOVEMENT_NORTH_WEST) != 0 || (next & BLOCK_MOVEMENT_SOUTH_EAST) != 0)) {
                return false;
            }
            if (dx == -1 && dy == -1 && ((current & BLOCK_MOVEMENT_SOUTH_WEST) != 0 || (next & BLOCK_MOVEMENT_NORTH_EAST) != 0)) {
                return false;
            }
        }

        return true;
    }

    private int heuristic(int x, int y, int targetX, int targetY) {
        return Math.max(Math.abs(targetX - x), Math.abs(targetY - y)) * 10;
    }

    private List<PathNode> findLocalPath(int[][] flags, int startX, int startY, int targetX, int targetY, int sizeX, int sizeY, int maxNodes) {
        boolean[][] visited = new boolean[sizeX][sizeY];
        int[][] bestCost = new int[sizeX][sizeY];
        PathNode[][] parents = new PathNode[sizeX][sizeY];
        for (int x = 0; x < sizeX; x++) {
            for (int y = 0; y < sizeY; y++) {
                bestCost[x][y] = Integer.MAX_VALUE;
            }
        }

        PriorityQueue<PathNode> open = new PriorityQueue<>(Comparator.comparingInt(node -> node.priority));
        PathNode start = new PathNode(startX, startY, 0, heuristic(startX, startY, targetX, targetY));
        open.add(start);
        bestCost[startX][startY] = 0;
        int searched = 0;
        int[] directions = {-1, 0, 1};

        while (!open.isEmpty() && searched < maxNodes) {
            PathNode current = open.poll();
            if (visited[current.x][current.y]) {
                continue;
            }
            visited[current.x][current.y] = true;
            searched++;

            if (current.x == targetX && current.y == targetY) {
                return reconstructPath(parents, current);
            }

            for (int dx : directions) {
                for (int dy : directions) {
                    if (dx == 0 && dy == 0) {
                        continue;
                    }
                    int nx = current.x + dx;
                    int ny = current.y + dy;
                    if (!isSceneCoordinate(nx, ny, sizeX, sizeY) || visited[nx][ny] || !canMove(flags, current.x, current.y, dx, dy, sizeX, sizeY)) {
                        continue;
                    }

                    int stepCost = dx != 0 && dy != 0 ? 14 : 10;
                    int cost = current.cost + stepCost;
                    if (cost < bestCost[nx][ny]) {
                        bestCost[nx][ny] = cost;
                        parents[nx][ny] = current;
                        open.add(new PathNode(nx, ny, cost, cost + heuristic(nx, ny, targetX, targetY)));
                    }
                }
            }
        }

        return Collections.emptyList();
    }

    private List<PathNode> reconstructPath(PathNode[][] parents, PathNode end) {
        ArrayDeque<PathNode> path = new ArrayDeque<>();
        PathNode current = end;
        while (current != null) {
            path.addFirst(current);
            current = parents[current.x][current.y];
        }
        return new ArrayList<>(path);
    }

    private JsonArray buildPathWaypoints(List<PathNode> path, int baseX, int baseY, int plane) {
        JsonArray waypoints = new JsonArray();
        if (path.isEmpty()) {
            return waypoints;
        }

        int lastDx = 0;
        int lastDy = 0;
        for (int i = 1; i < path.size(); i++) {
            PathNode previous = path.get(i - 1);
            PathNode current = path.get(i);
            int dx = Integer.compare(current.x - previous.x, 0);
            int dy = Integer.compare(current.y - previous.y, 0);
            boolean directionChanged = i > 1 && (dx != lastDx || dy != lastDy);
            boolean isLast = i == path.size() - 1;
            if (directionChanged || isLast) {
                PathNode waypoint = directionChanged ? previous : current;
                JsonObject step = new JsonObject();
                step.addProperty("sceneX", waypoint.x);
                step.addProperty("sceneY", waypoint.y);
                step.addProperty("worldX", baseX + waypoint.x);
                step.addProperty("worldY", baseY + waypoint.y);
                step.addProperty("plane", plane);
                waypoints.add(step);
            }
            lastDx = dx;
            lastDy = dy;
        }
        return waypoints;
    }

    private static final class PathNode {
        final int x;
        final int y;
        final int cost;
        final int priority;

        PathNode(int x, int y, int cost, int priority) {
            this.x = x;
            this.y = y;
            this.cost = cost;
            this.priority = priority;
        }
    }

    private String buildCameraJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("cameraX", client.getCameraX());
        response.addProperty("cameraY", client.getCameraY());
        response.addProperty("cameraZ", client.getCameraZ());
        response.addProperty("cameraYaw", client.getCameraYaw());
        response.addProperty("cameraPitch", client.getCameraPitch());
        response.addProperty("mapAngle", client.getMapAngle());
        response.addProperty("minimapZoom", client.getMinimapZoom());
        response.addProperty("viewportWidth", client.getViewportWidth());
        response.addProperty("viewportHeight", client.getViewportHeight());

        Player player = client.getLocalPlayer();
        if (player != null) {
            JsonObject playerJson = new JsonObject();
            playerJson.addProperty("name", player.getName());
            playerJson.addProperty("orientation", player.getOrientation());
            WorldPoint worldPoint = player.getWorldLocation();
            if (worldPoint != null) {
                playerJson.addProperty("worldX", worldPoint.getX());
                playerJson.addProperty("worldY", worldPoint.getY());
                playerJson.addProperty("plane", worldPoint.getPlane());
            }
            addRawLocalPoint(playerJson, player.getLocalLocation(), false, "localPoint");
            response.add("player", playerJson);
        }

        Widget minimap = firstVisibleWidget(
            WidgetInfo.RESIZABLE_MINIMAP_DRAW_AREA,
            WidgetInfo.RESIZABLE_MINIMAP_STONES_DRAW_AREA,
            WidgetInfo.FIXED_VIEWPORT_MINIMAP_DRAW_AREA,
            WidgetInfo.FIXED_VIEWPORT_MINIMAP
        );
        if (minimap != null) {
            response.add("minimap", buildWidgetJson("minimap", null, minimap, capturedAt));
        }

        return gson.toJson(response);
    }

    private String buildChatJson(long capturedAt, int limit) {
        JsonArray messages = new JsonArray();
        synchronized (recentChatMessages) {
            int start = Math.max(0, recentChatMessages.size() - Math.max(1, limit));
            for (int i = start; i < recentChatMessages.size(); i++) {
                messages.add(gson.fromJson(recentChatMessages.get(i), JsonElement.class));
            }
        }
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.add("messages", messages);
        return withCurrentAge(gson.toJson(response));
    }

    private String buildChatJson(int limit) {
        return buildChatJson(System.currentTimeMillis(), limit);
    }

    private String buildEventsJson(long capturedAt, int limit, String eventTypeFilter) {
        JsonArray events = new JsonArray();
        ArrayDeque<JsonElement> selectedEvents = new ArrayDeque<>();
        String normalizedFilter = eventTypeFilter != null ? eventTypeFilter.trim().toLowerCase() : "";
        synchronized (recentEvents) {
            int remaining = Math.max(1, limit);
            for (int i = recentEvents.size() - 1; i >= 0 && remaining > 0; i--) {
                JsonElement eventElement = gson.fromJson(recentEvents.get(i), JsonElement.class);
                if (!normalizedFilter.isEmpty()
                    && (!eventElement.isJsonObject()
                        || !eventElement.getAsJsonObject().has("eventType")
                        || !eventElement.getAsJsonObject().get("eventType").getAsString().toLowerCase().equals(normalizedFilter))) {
                    continue;
                }
                selectedEvents.addFirst(eventElement);
                remaining--;
            }
        }
        for (JsonElement eventElement : selectedEvents) {
            events.add(eventElement);
        }
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        if (!normalizedFilter.isEmpty()) {
            response.addProperty("eventType", eventTypeFilter);
        }
        response.add("events", events);
        return withCurrentAge(gson.toJson(response));
    }

    private String buildEventsJson(int limit) {
        return buildEventsJson(System.currentTimeMillis(), limit, "");
    }

    private void addVisibleWidgetSummary(JsonArray widgets, String label, Widget widget, long capturedAt) {
        if (widget == null || widget.isHidden()) {
            return;
        }
        widgets.add(buildWidgetJson(label, null, widget, capturedAt));
    }

    private String buildInterfaceSummaryJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("gameState", client.getGameState() != null ? client.getGameState().name() : "");
        response.addProperty("loggedIn", client.getGameState() == GameState.LOGGED_IN);
        response.addProperty("contextMenuOpen", client.isMenuOpen());
        response.addProperty("bankContainerAvailable", client.getItemContainer(InventoryID.BANK) != null);
        response.addProperty("inventoryContainerAvailable", client.getItemContainer(InventoryID.INVENTORY) != null);
        response.addProperty("equipmentContainerAvailable", client.getItemContainer(InventoryID.EQUIPMENT) != null);

        Widget npcDialogueText = client.getWidget(WidgetInfo.DIALOG_NPC_TEXT);
        Widget playerDialogueText = client.getWidget(WidgetInfo.DIALOG_PLAYER_TEXT);
        Widget dialogueOptions = client.getWidget(WidgetInfo.DIALOG_OPTION_OPTIONS);
        if (npcDialogueText != null && !npcDialogueText.isHidden()) {
            response.addProperty("dialogueType", "NPC_DIALOGUE");
        } else if (playerDialogueText != null && !playerDialogueText.isHidden()) {
            response.addProperty("dialogueType", "PLAYER_DIALOGUE");
        } else if (dialogueOptions != null && !dialogueOptions.isHidden()) {
            response.addProperty("dialogueType", "DIALOGUE_OPTIONS");
        } else {
            response.addProperty("dialogueType", "NONE");
        }

        JsonArray visibleWidgets = new JsonArray();
        addVisibleWidgetSummary(visibleWidgets, "inventory", client.getWidget(WidgetInfo.INVENTORY), capturedAt);
        addVisibleWidgetSummary(visibleWidgets, "dialogueNpcText", npcDialogueText, capturedAt);
        addVisibleWidgetSummary(visibleWidgets, "dialoguePlayerText", playerDialogueText, capturedAt);
        addVisibleWidgetSummary(visibleWidgets, "dialogueOptions", dialogueOptions, capturedAt);
        addVisibleWidgetSummary(visibleWidgets, "shopInventoryItemsContainer", client.getWidget(WidgetInfo.SHOP_INVENTORY_ITEMS_CONTAINER), capturedAt);
        addVisibleWidgetSummary(visibleWidgets, "combatTabFixed", client.getWidget(WidgetInfo.FIXED_VIEWPORT_COMBAT_TAB), capturedAt);
        addVisibleWidgetSummary(visibleWidgets, "combatTabResizable", client.getWidget(WidgetInfo.RESIZABLE_VIEWPORT_COMBAT_TAB), capturedAt);
        Widget minimap = firstVisibleWidget(
            WidgetInfo.RESIZABLE_MINIMAP_DRAW_AREA,
            WidgetInfo.RESIZABLE_MINIMAP_STONES_DRAW_AREA,
            WidgetInfo.FIXED_VIEWPORT_MINIMAP_DRAW_AREA,
            WidgetInfo.FIXED_VIEWPORT_MINIMAP
        );
        addVisibleWidgetSummary(visibleWidgets, "minimap", minimap, capturedAt);
        response.add("visibleWidgets", visibleWidgets);

        return gson.toJson(response);
    }

    private String buildWidgetsJson(long capturedAt, boolean includeHidden, int maxWidgets, int maxDepth, String filter) {
        int safeMaxWidgets = Math.max(1, Math.min(maxWidgets, 1000));
        int safeMaxDepth = Math.max(0, Math.min(maxDepth, 12));
        String normalizedFilter = filter != null ? filter.trim().toLowerCase() : "";

        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("gameState", client.getGameState() != null ? client.getGameState().name() : "");
        response.addProperty("topLevelInterfaceId", client.getTopLevelInterfaceId());
        response.addProperty("includeHidden", includeHidden);
        response.addProperty("maxWidgets", safeMaxWidgets);
        response.addProperty("maxDepth", safeMaxDepth);
        if (!normalizedFilter.isEmpty()) {
            response.addProperty("filter", filter);
        }

        JsonArray widgets = new JsonArray();
        Widget[] roots = client.getWidgetRoots();
        if (roots != null) {
            for (int i = 0; i < roots.length; i++) {
                Widget root = roots[i];
                if (root == null || widgets.size() >= safeMaxWidgets) {
                    continue;
                }
                addWidgetTree(widgets, root, capturedAt, includeHidden, safeMaxWidgets, safeMaxDepth, normalizedFilter, 0, "root", i);
            }
        }

        response.addProperty("returnedWidgets", widgets.size());
        response.add("widgets", widgets);
        return gson.toJson(response);
    }

    private void addWidgetTree(JsonArray response, Widget widget, long capturedAt, boolean includeHidden, int maxWidgets, int maxDepth, String filter, int depth, String childCollection, int arrayIndex) {
        if (widget == null || response.size() >= maxWidgets || depth > maxDepth) {
            return;
        }
        if ((includeHidden || !widget.isHidden()) && widgetMatchesFilter(widget, filter)) {
            JsonObject widgetJson = buildWidgetJson("widget", null, widget, capturedAt);
            widgetJson.addProperty("widgetId", widget.getId());
            widgetJson.addProperty("packedId", widget.getId());
            widgetJson.addProperty("groupId", widget.getId() >>> 16);
            widgetJson.addProperty("childId", widget.getId() & 0xFFFF);
            widgetJson.addProperty("parentId", widget.getParentId());
            widgetJson.addProperty("type", widget.getType());
            widgetJson.addProperty("depth", depth);
            widgetJson.addProperty("childCollection", childCollection);
            widgetJson.addProperty("arrayIndex", arrayIndex);
            addChildCounts(widgetJson, widget);
            response.add(widgetJson);
        }

        if (depth >= maxDepth) {
            return;
        }
        addWidgetChildren(response, widget.getNestedChildren(), capturedAt, includeHidden, maxWidgets, maxDepth, filter, depth + 1, "nested");
        addWidgetChildren(response, widget.getDynamicChildren(), capturedAt, includeHidden, maxWidgets, maxDepth, filter, depth + 1, "dynamic");
        addWidgetChildren(response, widget.getStaticChildren(), capturedAt, includeHidden, maxWidgets, maxDepth, filter, depth + 1, "static");
    }

    private void addWidgetChildren(JsonArray response, Widget[] children, long capturedAt, boolean includeHidden, int maxWidgets, int maxDepth, String filter, int depth, String childCollection) {
        if (children == null || response.size() >= maxWidgets) {
            return;
        }
        for (int i = 0; i < children.length; i++) {
            Widget child = children[i];
            if (response.size() >= maxWidgets) {
                return;
            }
            addWidgetTree(response, child, capturedAt, includeHidden, maxWidgets, maxDepth, filter, depth, childCollection, i);
        }
    }

    private void addChildCounts(JsonObject response, Widget widget) {
        response.addProperty("nestedChildCount", widget.getNestedChildren() != null ? widget.getNestedChildren().length : 0);
        response.addProperty("dynamicChildCount", widget.getDynamicChildren() != null ? widget.getDynamicChildren().length : 0);
        response.addProperty("staticChildCount", widget.getStaticChildren() != null ? widget.getStaticChildren().length : 0);
    }

    private boolean widgetMatchesFilter(Widget widget, String filter) {
        if (filter == null || filter.isEmpty()) {
            return true;
        }
        if (String.valueOf(widget.getId()).contains(filter)) {
            return true;
        }
        return hasTextNameOrActionContaining(widget, filter);
    }

    private Map<String, String> parseQuery(HttpExchange exchange) {
        Map<String, String> params = new HashMap<>();
        String query = exchange.getRequestURI().getRawQuery();
        if (query == null || query.isEmpty()) {
            return params;
        }

        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            String key = URLDecoder.decode(parts[0], StandardCharsets.UTF_8);
            String value = parts.length > 1 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "";
            params.put(key, value);
        }
        return params;
    }

    private int getIntParam(Map<String, String> params, String key, int fallback) {
        try {
            return params.containsKey(key) ? Integer.parseInt(params.get(key)) : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private List<Integer> getCsvIntParam(Map<String, String> params, String key) {
        List<Integer> values = new ArrayList<>();
        String rawValue = params.get(key);
        if (rawValue == null || rawValue.trim().isEmpty()) {
            return values;
        }

        for (String part : rawValue.split(",")) {
            try {
                values.add(Integer.parseInt(part.trim()));
            } catch (NumberFormatException e) {
                log.debug("Ignoring invalid integer query value {}={}", key, part);
            }
        }
        return values;
    }

    private String buildVarsJson(List<Integer> varbits, List<Integer> varps) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, System.currentTimeMillis());

        JsonObject varbitValues = new JsonObject();
        for (Integer id : varbits) {
            try {
                varbitValues.addProperty(String.valueOf(id), client.getVarbitValue(id));
            } catch (RuntimeException e) {
                varbitValues.addProperty(String.valueOf(id), "ERROR:" + e.getMessage());
            }
        }
        response.add("varbits", varbitValues);

        JsonObject varpValues = new JsonObject();
        for (Integer id : varps) {
            try {
                varpValues.addProperty(String.valueOf(id), client.getVarpValue(id));
            } catch (RuntimeException e) {
                varpValues.addProperty(String.valueOf(id), "ERROR:" + e.getMessage());
            }
        }
        response.add("varps", varpValues);

        return gson.toJson(response);
    }

    private boolean questMatches(Quest quest, String query) {
        if (query == null || query.trim().isEmpty()) {
            return true;
        }

        String normalizedQuery = query.trim().toLowerCase().replace("_", " ");
        if (String.valueOf(quest.getId()).equals(normalizedQuery)) {
            return true;
        }

        String enumName = quest.name().toLowerCase().replace("_", " ");
        String displayName = quest.getName().toLowerCase();
        return enumName.equals(normalizedQuery) ||
            displayName.equals(normalizedQuery) ||
            enumName.contains(normalizedQuery) ||
            displayName.contains(normalizedQuery);
    }

    private String buildQuestStateJson(String query) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, System.currentTimeMillis());
        response.addProperty("query", query != null ? query : "");

        JsonArray quests = new JsonArray();
        for (Quest quest : Quest.values()) {
            if (!questMatches(quest, query)) {
                continue;
            }

            JsonObject questJson = new JsonObject();
            addCaptureMeta(questJson, System.currentTimeMillis());
            questJson.addProperty("enumName", quest.name());
            questJson.addProperty("name", quest.getName());
            questJson.addProperty("id", quest.getId());
            try {
                QuestState state = quest.getState(client);
                questJson.addProperty("state", state != null ? state.name() : "UNKNOWN");
            } catch (RuntimeException e) {
                questJson.addProperty("state", "ERROR");
                questJson.addProperty("message", e.getMessage());
            }
            quests.add(questJson);
        }

        response.addProperty("count", quests.size());
        response.add("quests", quests);
        return gson.toJson(response);
    }

    private String buildPrayersJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("level", client.getRealSkillLevel(Skill.PRAYER));
        response.addProperty("boostedLevel", client.getBoostedSkillLevel(Skill.PRAYER));

        JsonArray controls = new JsonArray();
        addWidgetControl(controls, "prayerOrb", WidgetInfo.MINIMAP_PRAYER_ORB, capturedAt);
        addWidgetControl(controls, "quickPrayerOrb", WidgetInfo.MINIMAP_QUICK_PRAYER_ORB, capturedAt);
        addWidgetControl(controls, "quickPrayerPrayers", WidgetInfo.QUICK_PRAYER_PRAYERS, capturedAt);
        response.add("controls", controls);

        int activeCount = 0;
        JsonArray prayers = new JsonArray();
        for (Prayer prayer : Prayer.values()) {
            JsonObject prayerJson = new JsonObject();
            addCaptureMeta(prayerJson, capturedAt);
            prayerJson.addProperty("enumName", prayer.name());
            prayerJson.addProperty("varbit", prayer.getVarbit());
            boolean active = client.isPrayerActive(prayer);
            prayerJson.addProperty("active", active);
            if (active) {
                activeCount++;
            }
            try {
                prayerJson.addProperty("varbitValue", client.getVarbitValue(prayer.getVarbit()));
            } catch (RuntimeException e) {
                prayerJson.addProperty("varbitValueError", e.getMessage());
            }
            prayers.add(prayerJson);
        }
        response.addProperty("activeCount", activeCount);
        response.add("prayers", prayers);
        return gson.toJson(response);
    }

    private String buildCombatJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);

        Player player = client.getLocalPlayer();
        if (player != null) {
            response.addProperty("playerAnimation", player.getAnimation());
            response.addProperty("playerIdle", player.getAnimation() == -1 && player.getInteracting() == null);
            if (player.getInteracting() != null) {
                response.addProperty("interactingWith", player.getInteracting().getName());
            }
        }

        JsonArray controls = new JsonArray();
        addWidgetControl(controls, "combatTabFixed", WidgetInfo.FIXED_VIEWPORT_COMBAT_TAB, capturedAt);
        addWidgetControl(controls, "combatTabResizable", WidgetInfo.RESIZABLE_VIEWPORT_COMBAT_TAB, capturedAt);
        addWidgetControl(controls, "style1", WidgetInfo.COMBAT_STYLE_ONE, capturedAt);
        addWidgetControl(controls, "style2", WidgetInfo.COMBAT_STYLE_TWO, capturedAt);
        addWidgetControl(controls, "style3", WidgetInfo.COMBAT_STYLE_THREE, capturedAt);
        addWidgetControl(controls, "style4", WidgetInfo.COMBAT_STYLE_FOUR, capturedAt);
        addWidgetControl(controls, "autoRetaliate", WidgetInfo.COMBAT_AUTO_RETALIATE, capturedAt);
        response.add("controls", controls);

        JsonArray specialAttackWidgets = new JsonArray();
        Widget[] roots = client.getWidgetRoots();
        if (roots != null) {
            for (Widget root : roots) {
                if (root == null || specialAttackWidgets.size() >= 20) {
                    continue;
                }
                addSpecialAttackWidgets(specialAttackWidgets, root.getNestedChildren(), capturedAt, 20);
                addSpecialAttackWidgets(specialAttackWidgets, root.getDynamicChildren(), capturedAt, 20);
                addSpecialAttackWidgets(specialAttackWidgets, root.getStaticChildren(), capturedAt, 20);
            }
        }
        response.add("specialAttackWidgets", specialAttackWidgets);
        return gson.toJson(response);
    }

    private boolean hasActionContaining(Widget widget, String needle) {
        String[] actions = widget.getActions();
        if (actions == null) {
            return false;
        }
        String lowerNeedle = needle.toLowerCase();
        for (String action : actions) {
            if (action != null && action.toLowerCase().contains(lowerNeedle)) {
                return true;
            }
        }
        return false;
    }

    private boolean hasTextNameOrActionContaining(Widget widget, String needle) {
        if (widget == null || needle == null) {
            return false;
        }
        String lowerNeedle = needle.toLowerCase();
        String text = widget.getText();
        if (text != null && text.toLowerCase().contains(lowerNeedle)) {
            return true;
        }
        String name = widget.getName();
        if (name != null && name.toLowerCase().contains(lowerNeedle)) {
            return true;
        }
        return hasActionContaining(widget, needle);
    }

    private void addSpecialAttackWidgets(JsonArray response, Widget[] widgets, long capturedAt, int limit) {
        if (widgets == null || response.size() >= limit) {
            return;
        }

        for (Widget widget : widgets) {
            if (widget == null || response.size() >= limit) {
                continue;
            }
            if (!widget.isHidden() && hasTextNameOrActionContaining(widget, "special")) {
                response.add(buildWidgetJson("specialAttack", null, widget, capturedAt));
            }
            addSpecialAttackWidgets(response, widget.getNestedChildren(), capturedAt, limit);
            addSpecialAttackWidgets(response, widget.getDynamicChildren(), capturedAt, limit);
            addSpecialAttackWidgets(response, widget.getStaticChildren(), capturedAt, limit);
        }
    }

    private void addActionWidgets(JsonArray response, Widget[] widgets, long capturedAt, int limit) {
        if (widgets == null || response.size() >= limit) {
            return;
        }

        for (Widget widget : widgets) {
            if (widget == null || response.size() >= limit) {
                continue;
            }
            if (!widget.isHidden() && (hasActionContaining(widget, "buy") || hasActionContaining(widget, "sell"))) {
                response.add(buildWidgetJson("shopAction", null, widget, capturedAt));
            }
        }
    }

    private void addWidgetsWithAction(JsonArray response, Widget[] widgets, long capturedAt, int limit, String label, String actionNeedle) {
        if (widgets == null || response.size() >= limit) {
            return;
        }

        for (Widget widget : widgets) {
            if (widget == null || response.size() >= limit) {
                continue;
            }
            if (!widget.isHidden() && hasActionContaining(widget, actionNeedle)) {
                response.add(buildWidgetJson(label, null, widget, capturedAt));
            }
            addWidgetsWithAction(response, widget.getNestedChildren(), capturedAt, limit, label, actionNeedle);
            addWidgetsWithAction(response, widget.getDynamicChildren(), capturedAt, limit, label, actionNeedle);
            addWidgetsWithAction(response, widget.getStaticChildren(), capturedAt, limit, label, actionNeedle);
        }
    }

    private String buildBankActionsJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("topLevelInterfaceId", client.getTopLevelInterfaceId());
        response.addProperty("bankContainerAvailable", client.getItemContainer(InventoryID.BANK) != null);

        JsonArray withdrawWidgets = new JsonArray();
        JsonArray depositWidgets = new JsonArray();
        Widget[] roots = client.getWidgetRoots();
        if (roots != null) {
            for (Widget root : roots) {
                if (root == null) {
                    continue;
                }
                addWidgetsWithAction(withdrawWidgets, root.getNestedChildren(), capturedAt, 160, "bankWithdrawAction", "withdraw");
                addWidgetsWithAction(withdrawWidgets, root.getDynamicChildren(), capturedAt, 160, "bankWithdrawAction", "withdraw");
                addWidgetsWithAction(withdrawWidgets, root.getStaticChildren(), capturedAt, 160, "bankWithdrawAction", "withdraw");
                addWidgetsWithAction(depositWidgets, root.getNestedChildren(), capturedAt, 160, "bankDepositAction", "deposit");
                addWidgetsWithAction(depositWidgets, root.getDynamicChildren(), capturedAt, 160, "bankDepositAction", "deposit");
                addWidgetsWithAction(depositWidgets, root.getStaticChildren(), capturedAt, 160, "bankDepositAction", "deposit");
            }
        }
        response.add("withdrawWidgets", withdrawWidgets);
        response.add("depositWidgets", depositWidgets);
        return gson.toJson(response);
    }

    private String buildShopJson(long capturedAt) {
        JsonObject response = new JsonObject();
        addCaptureMeta(response, capturedAt);
        response.addProperty("topLevelInterfaceId", client.getTopLevelInterfaceId());

        Widget inventoryContainer = client.getWidget(WidgetInfo.SHOP_INVENTORY_ITEMS_CONTAINER);
        response.add("inventoryContainer", buildWidgetJson("shopInventoryItemsContainer", WidgetInfo.SHOP_INVENTORY_ITEMS_CONTAINER, inventoryContainer, capturedAt));

        JsonArray actionWidgets = new JsonArray();
        Widget[] roots = client.getWidgetRoots();
        if (roots != null) {
            for (Widget root : roots) {
                if (root == null || actionWidgets.size() >= 120) {
                    continue;
                }
                addActionWidgets(actionWidgets, root.getNestedChildren(), capturedAt, 120);
                addActionWidgets(actionWidgets, root.getDynamicChildren(), capturedAt, 120);
                addActionWidgets(actionWidgets, root.getStaticChildren(), capturedAt, 120);
            }
        }
        response.add("actionWidgets", actionWidgets);
        return gson.toJson(response);
    }

    private String buildIdentityJson() {
        JsonObject response = new JsonObject();
        response.addProperty("instanceId", instanceId);
        response.addProperty("apiVersion", 2);
        response.addProperty("supportsConcurrentStreams", true);
        response.addProperty("supportsEventBuffer", true);
        response.addProperty("port", port);
        response.addProperty("baseUrl", getBaseUrl());
        response.addProperty("lastSeen", System.currentTimeMillis());
        GameStateSnapshot snapshot = latestSnapshot.get();
        response.addProperty("lastSnapshotAt", snapshot != null ? snapshot.capturedAt : 0);
        response.addProperty("gameTick", gameTick);
        response.addProperty("clientTick", clientTick);
        response.addProperty("pid", getProcessId());
        if (client.getGameState() == GameState.LOGGED_IN && client.getLocalPlayer() != null) {
            response.addProperty("playerName", client.getLocalPlayer().getName());
        }
        response.addProperty("world", client.getWorld());

        Component canvas = client.getCanvas();
        response.addProperty("canvasShowing", canvas != null && canvas.isShowing());
        if (canvas != null) {
            JsonObject canvasBounds = new JsonObject();
            canvasBounds.addProperty("width", canvas.getWidth());
            canvasBounds.addProperty("height", canvas.getHeight());
            java.awt.Point canvasOrigin = getCanvasScreenLocation();
            if (canvasOrigin != null) {
                canvasBounds.addProperty("x", canvasOrigin.x);
                canvasBounds.addProperty("y", canvasOrigin.y);
                canvasBounds.addProperty("screenX", toNutScreenX(canvasOrigin.x));
                canvasBounds.addProperty("screenY", toNutScreenY(canvasOrigin.y));
            }
            response.add("canvasBounds", canvasBounds);
        }

        Window window = getCanvasWindow();
        addWindowFocusState(response);
        if (window instanceof Frame) {
            Frame frame = (Frame) window;
            response.addProperty("windowTitle", frame.getTitle());
            response.addProperty("windowMinimized", (frame.getExtendedState() & Frame.ICONIFIED) != 0);
        } else if (window instanceof Dialog) {
            response.addProperty("windowTitle", ((Dialog) window).getTitle());
            response.addProperty("windowMinimized", false);
        } else {
            response.addProperty("windowMinimized", false);
        }
        return gson.toJson(response);
    }

    private long getProcessId() {
        try {
            return ProcessHandle.current().pid();
        } catch (Throwable e) {
            return -1;
        }
    }

    class ApiIndexHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            String path = t.getRequestURI().getPath();
            if (!"/".equals(path) && !"/api".equals(path) && !"/api/".equals(path)) {
                JsonObject response = new JsonObject();
                response.addProperty("error", "NOT_FOUND");
                response.addProperty("message", "Unknown endpoint. Open /api/ for the endpoint list.");
                sendResponse(t, 404, gson.toJson(response));
                return;
            }

            sendResponse(t, 200, getApiIndexJson());
        }
    }

    class ActionMenuHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (!"POST".equalsIgnoreCase(t.getRequestMethod())) {
                sendJsonErrorResponse(t, 405, "METHOD_NOT_ALLOWED", "Use POST with a JSON body");
                return;
            }

            JsonObject request;
            try {
                request = readJsonRequestBody(t);
            } catch (RuntimeException e) {
                sendJsonErrorResponse(t, 400, "BAD_REQUEST", e.getMessage());
                return;
            }

            handleOnClientThread(t, () -> invokeMenuActionJson(request));
        }
    }

    class ActionWalkHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (!"POST".equalsIgnoreCase(t.getRequestMethod())) {
                sendJsonErrorResponse(t, 405, "METHOD_NOT_ALLOWED", "Use POST with a JSON body");
                return;
            }

            JsonObject request;
            try {
                request = readJsonRequestBody(t);
            } catch (RuntimeException e) {
                sendJsonErrorResponse(t, 400, "BAD_REQUEST", e.getMessage());
                return;
            }

            handleOnClientThread(t, () -> invokeWalkActionJson(request));
        }
    }

    class ActionWidgetHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (!"POST".equalsIgnoreCase(t.getRequestMethod())) {
                sendJsonErrorResponse(t, 405, "METHOD_NOT_ALLOWED", "Use POST with a JSON body");
                return;
            }

            JsonObject request;
            try {
                request = readJsonRequestBody(t);
            } catch (RuntimeException e) {
                sendJsonErrorResponse(t, 400, "BAD_REQUEST", e.getMessage());
                return;
            }

            handleOnClientThread(t, () -> invokeWidgetActionJson(request));
        }
    }

    class StateHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "state")) {
                return;
            }
            handleOnClientThread(t, () -> buildStateJson(System.currentTimeMillis()));
        }
    }

    class InventoryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "inventory")) {
                return;
            }
            handleOnClientThread(t, () -> buildInventoryJson(System.currentTimeMillis()));
        }
    }

    class NpcHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "npcs")) {
                return;
            }
            handleOnClientThread(t, () -> buildNpcsJson(System.currentTimeMillis()));
        }
    }

    class DialogueHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "dialogue")) {
                return;
            }
            handleOnClientThread(t, () -> buildDialogueJson(System.currentTimeMillis()));
        }
    }

    class ObjectHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "objects")) {
                return;
            }
            handleOnClientThread(t, () -> buildObjectsJson(System.currentTimeMillis()));
        }
    }

    class GroundItemHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "grounditems")) {
                return;
            }
            handleOnClientThread(t, () -> buildGroundItemsJson(System.currentTimeMillis()));
        }
    }

    class PlayersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "players")) {
                return;
            }
            handleOnClientThread(t, () -> buildPlayersJson(System.currentTimeMillis()));
        }
    }

    class BankHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "bank")) {
                return;
            }
            handleOnClientThread(t, () -> buildBankJson(System.currentTimeMillis()));
        }
    }

    class BankActionsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> buildBankActionsJson(System.currentTimeMillis()));
        }
    }

    class EquipmentHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "equipment")) {
                return;
            }
            handleOnClientThread(t, () -> buildEquipmentJson(System.currentTimeMillis()));
        }
    }

    class SkillsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "skills")) {
                return;
            }
            handleOnClientThread(t, () -> buildSkillsJson(System.currentTimeMillis()));
        }
    }

    class InterfaceSummaryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "interface_summary")) {
                return;
            }
            handleOnClientThread(t, () -> buildInterfaceSummaryJson(System.currentTimeMillis()));
        }
    }

    class WidgetsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            boolean includeHidden = Boolean.parseBoolean(params.getOrDefault("includeHidden", "false"));
            int maxWidgets = getIntParam(params, "maxWidgets", 250);
            int maxDepth = getIntParam(params, "maxDepth", 6);
            String filter = params.getOrDefault("filter", "");
            handleOnClientThread(t, () -> buildWidgetsJson(System.currentTimeMillis(), includeHidden, maxWidgets, maxDepth, filter));
        }
    }

    class VarsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            List<Integer> varbits = getCsvIntParam(params, "varbits");
            List<Integer> varps = getCsvIntParam(params, "varps");
            handleOnClientThread(t, () -> buildVarsJson(varbits, varps));
        }
    }

    class QuestStateHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            String query = params.containsKey("name") ? params.get("name") : params.get("id");
            handleOnClientThread(t, () -> buildQuestStateJson(query));
        }
    }

    class PrayersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> buildPrayersJson(System.currentTimeMillis()));
        }
    }

    class CombatHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> buildCombatJson(System.currentTimeMillis()));
        }
    }

    class ShopHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> buildShopJson(System.currentTimeMillis()));
        }
    }

    class CameraHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> buildCameraJson(System.currentTimeMillis()));
        }
    }

    class CoordinateDebugHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> gson.toJson(getCoordinateDebug()));
        }
    }

    class SnapshotHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            if (sendCachedResponse(t, "snapshot")) {
                return;
            }
            handleOnClientThread(t, () -> buildLiveSnapshot(System.currentTimeMillis()).snapshot);
        }
    }

    class StreamHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            t.getResponseHeaders().set("Content-Type", "text/event-stream");
            t.getResponseHeaders().set("Cache-Control", "no-cache");
            t.getResponseHeaders().set("Connection", "keep-alive");
            t.sendResponseHeaders(200, 0);

            long startedAt = System.currentTimeMillis();
            OutputStream os = t.getResponseBody();
            try {
                while (System.currentTimeMillis() - startedAt < STREAM_MAX_DURATION_MS) {
                    String snapshot = cachedStateOrNull("snapshot");
                    if (snapshot != null) {
                        String event = "event: snapshot\n" + "data: " + snapshot + "\n\n";
                        os.write(event.getBytes(StandardCharsets.UTF_8));
                        os.flush();
                    }
                    String events = buildEventsJson(50);
                    String event = "event: events\n" + "data: " + events + "\n\n";
                    os.write(event.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                    try {
                        Thread.sleep(STREAM_INTERVAL_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            } catch (IOException e) {
                log.debug("SSE stream closed", e);
            } finally {
                os.close();
            }
        }
    }

    class ContextMenuHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> buildContextMenuJson(System.currentTimeMillis()));
        }
    }

    class MinimapHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            boolean hasTarget = params.containsKey("worldX") && params.containsKey("worldY");
            WorldPoint target = null;
            if (hasTarget) {
                int worldX = getIntParam(params, "worldX", -1);
                int worldY = getIntParam(params, "worldY", -1);
                int plane = getIntParam(params, "plane", 0);
                if (worldX > 0 && worldY > 0) {
                    target = new WorldPoint(worldX, worldY, plane);
                }
            }
            WorldPoint targetPoint = target;
            handleOnClientThread(t, () -> buildMinimapJson(System.currentTimeMillis(), targetPoint));
        }
    }

    class PathHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            int worldX = getIntParam(params, "worldX", -1);
            int worldY = getIntParam(params, "worldY", -1);
            int plane = getIntParam(params, "plane", -1);
            int maxNodes = getIntParam(params, "maxNodes", 4096);
            if (worldX <= 0 || worldY <= 0) {
                sendJsonErrorResponse(t, 400, "BAD_REQUEST", "worldX and worldY query parameters are required");
                return;
            }
            WorldPoint targetPoint = new WorldPoint(worldX, worldY, plane);
            handleOnClientThread(t, () -> buildPathJson(System.currentTimeMillis(), targetPoint, maxNodes));
        }
    }

    class ChatHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            int limit = getIntParam(params, "limit", 20);
            sendResponse(t, 200, buildChatJson(limit));
        }
    }

    class EventsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            Map<String, String> params = parseQuery(t);
            int limit = getIntParam(params, "limit", 50);
            sendResponse(t, 200, buildEventsJson(System.currentTimeMillis(), limit, params.get("eventType")));
        }
    }

    class IdentityHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, this::getIdentity);
        }

        private String getIdentity() {
            return buildIdentityJson();
        }
    }
}
