package com.osrsmcp;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import net.runelite.api.Client;
import net.runelite.api.InventoryID;
import net.runelite.api.Item;
import net.runelite.api.ItemContainer;
import net.runelite.api.NPC;
import net.runelite.api.GameObject;
import net.runelite.api.GameState;
import net.runelite.api.Tile;
import net.runelite.api.TileItem;
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
import java.awt.GraphicsConfiguration;
import java.awt.GraphicsDevice;
import java.awt.GraphicsEnvironment;
import java.awt.IllegalComponentStateException;
import java.awt.MouseInfo;
import java.awt.PointerInfo;
import java.awt.Rectangle;
import java.awt.Shape;
import java.awt.Toolkit;
import java.awt.geom.AffineTransform;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ApiServer {
    private static final long CLIENT_THREAD_TIMEOUT_SECONDS = 2;
    private static final Logger log = LoggerFactory.getLogger(ApiServer.class);

    private HttpServer server;
    private final Client client;
    private final ClientThread clientThread;
    private final ItemManager itemManager;
    private final Gson gson = new Gson();

    public ApiServer(Client client, ClientThread clientThread, ItemManager itemManager) {
        this.client = client;
        this.clientThread = clientThread;
        this.itemManager = itemManager;
    }

    public void start() {
        try {
            server = HttpServer.create(new InetSocketAddress(8080), 0);
            server.createContext("/", new ApiIndexHandler());
            server.createContext("/api", new ApiIndexHandler());
            server.createContext("/api/", new ApiIndexHandler());
            server.createContext("/api/state", new StateHandler());
            server.createContext("/api/inventory", new InventoryHandler());
            server.createContext("/api/npcs", new NpcHandler());
            server.createContext("/api/dialogue", new DialogueHandler());
            server.createContext("/api/objects", new ObjectHandler());
            server.createContext("/api/grounditems", new GroundItemHandler());
            server.createContext("/api/bank", new BankHandler());
            server.createContext("/api/equipment", new EquipmentHandler());
            server.createContext("/api/skills", new SkillsHandler());
            server.createContext("/api/debug/coordinates", new CoordinateDebugHandler());
            server.setExecutor(null); // creates a default executor
            server.start();
            log.info("API Server started on port 8080");
        } catch (IOException e) {
            log.error("Failed to start API server", e);
        }
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
            log.info("API Server stopped");
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

    private JsonObject endpoint(String path, String description) {
        JsonObject endpoint = new JsonObject();
        endpoint.addProperty("path", path);
        endpoint.addProperty("description", description);
        return endpoint;
    }

    private String getApiIndexJson() {
        JsonObject response = new JsonObject();
        response.addProperty("name", "OSRS MCP RuneLite API");
        response.addProperty("description", "Local read-only RuneLite game-state API for the OSRS MCP server. Runtime data is read safely on the RuneLite client thread.");
        response.addProperty("baseUrl", "http://localhost:8080/api");

        JsonArray endpoints = new JsonArray();
        endpoints.add(endpoint("/api/state", "Current login status, player name, hitpoints, run energy, and world location."));
        endpoints.add(endpoint("/api/inventory", "Inventory item IDs, names, quantities, and slots."));
        endpoints.add(endpoint("/api/npcs", "Nearby NPC IDs, names, world coordinates, canvas coordinates, and absolute screen coordinates."));
        endpoints.add(endpoint("/api/dialogue", "Open NPC/player dialogue text, dialogue options, canvas coordinates, and absolute screen coordinates when available."));
        endpoints.add(endpoint("/api/objects", "Scene game object IDs, names, world coordinates, canvas coordinates, and absolute screen coordinates."));
        endpoints.add(endpoint("/api/grounditems", "Visible ground item IDs, names, quantities, world coordinates, canvas coordinates, and absolute screen coordinates."));
        endpoints.add(endpoint("/api/bank", "Bank item IDs, names, quantities, and slots when the bank container is available."));
        endpoints.add(endpoint("/api/equipment", "Equipped item IDs, names, quantities, and slots."));
        endpoints.add(endpoint("/api/skills", "Real level, boosted level, and XP for each skill."));
        endpoints.add(endpoint("/api/debug/coordinates", "Canvas origin, canvas size, DPI transform, mouse position, and player coordinate debug data."));
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
            if (isCanvasOnAnyScreen(canvasOrigin)) {
                response.addProperty("screenX", toNutScreenX(awtScreenX));
                response.addProperty("screenY", toNutScreenY(awtScreenY));
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
            if (isCanvasOnAnyScreen(canvasOrigin)) {
                response.addProperty(prefix + "ScreenX", toNutScreenX(awtScreenX));
                response.addProperty(prefix + "ScreenY", toNutScreenY(awtScreenY));
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

    private void addRawLocalPoint(JsonObject response, LocalPoint lp) {
        if (lp == null) {
            return;
        }

        Point rawPoint = Perspective.localToCanvas(client, lp, client.getPlane());
        if (rawPoint != null) {
            response.addProperty("rawCanvasX", rawPoint.getX());
            response.addProperty("rawCanvasY", rawPoint.getY());
            if (!hasCanvasCoordinates(response)) {
                response.addProperty("coordinateSource", "localPoint");
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
            addRawLocalPoint(playerJson, player.getLocalLocation());
            Shape hull = player.getConvexHull();
            if (hull != null) {
                addBounds(playerJson, "clickboxBounds", hull.getBounds());
            }
            response.add("player", playerJson);
        }

        return response;
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

    class StateHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonObject response = new JsonObject();
            if (client.getGameState() != net.runelite.api.GameState.LOGGED_IN) {
                response.addProperty("status", "NOT_LOGGED_IN");
                return gson.toJson(response);
            }

            Player player = client.getLocalPlayer();
            if (player != null) {
                response.addProperty("status", "LOGGED_IN");
                response.addProperty("name", player.getName());
                response.addProperty("health", client.getBoostedSkillLevel(net.runelite.api.Skill.HITPOINTS));
                response.addProperty("runEnergy", client.getEnergy());
                
                WorldPoint wp = player.getWorldLocation();
                JsonObject location = new JsonObject();
                location.addProperty("x", wp.getX());
                location.addProperty("y", wp.getY());
                location.addProperty("plane", wp.getPlane());
                response.add("location", location);
            }

            return gson.toJson(response);
            });
        }
    }

    class InventoryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonArray response = new JsonArray();
            ItemContainer inventory = client.getItemContainer(InventoryID.INVENTORY);
            if (inventory != null) {
                Item[] items = inventory.getItems();
                for (int i = 0; i < items.length; i++) {
                    Item item = items[i];
                    if (item.getId() != -1 && item.getId() != 0) {
                        JsonObject itemObj = new JsonObject();
                        itemObj.addProperty("id", item.getId());
                        itemObj.addProperty("name", getItemName(item.getId()));
                        itemObj.addProperty("quantity", item.getQuantity());
                        itemObj.addProperty("slot", i);
                        response.add(itemObj);
                    }
                }
            }
            return gson.toJson(response);
            });
        }
    }

    class NpcHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonArray response = new JsonArray();
            if (client.getGameState() != GameState.LOGGED_IN) {
                return gson.toJson(response);
            }

            List<NPC> npcs = client.getNpcs();
            for (NPC npc : npcs) {
                JsonObject npcObj = new JsonObject();
                npcObj.addProperty("id", npc.getId());
                npcObj.addProperty("name", getNpcName(npc));
                
                WorldPoint wp = npc.getWorldLocation();
                npcObj.addProperty("worldX", wp.getX());
                npcObj.addProperty("worldY", wp.getY());

                LocalPoint lp = npc.getLocalLocation();
                addRawLocalPoint(npcObj, lp);
                addCanvasCoordinateFromShape(npcObj, npc.getConvexHull(), "convexHull");
                response.add(npcObj);
            }
            return gson.toJson(response);
            });
        }
    }

    class DialogueHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonObject response = new JsonObject();
            
            // Check NPC Dialogue
            Widget npcDialogueText = client.getWidget(WidgetInfo.DIALOG_NPC_TEXT);
            Widget npcDialogueName = client.getWidget(WidgetInfo.DIALOG_NPC_NAME);

            if (npcDialogueText != null && !npcDialogueText.isHidden()) {
                response.addProperty("type", "NPC_DIALOGUE");
                response.addProperty("npcName", npcDialogueName != null ? npcDialogueName.getText() : "");
                response.addProperty("text", npcDialogueText.getText());
                addWidgetCenter(response, npcDialogueText, "continue");
                return gson.toJson(response);
            }

            // Check Player Dialogue
            Widget playerDialogueText = client.getWidget(WidgetInfo.DIALOG_PLAYER_TEXT);

            if (playerDialogueText != null && !playerDialogueText.isHidden()) {
                response.addProperty("type", "PLAYER_DIALOGUE");
                response.addProperty("text", playerDialogueText.getText());
                addWidgetCenter(response, playerDialogueText, "continue");
                return gson.toJson(response);
            }

            // Check Dialogue Options
            Widget dialogueOptions = client.getWidget(WidgetInfo.DIALOG_OPTION_OPTIONS);
            if (dialogueOptions != null && !dialogueOptions.isHidden()) {
                response.addProperty("type", "DIALOGUE_OPTIONS");
                JsonArray options = new JsonArray();
                Widget[] children = dialogueOptions.getDynamicChildren();
                if (children != null) {
                    for (int i = 0; i < children.length; i++) {
                        Widget child = children[i];
                        if (child.getText() != null && !child.getText().isEmpty() && !child.getText().equals("Please wait...")) {
                            JsonObject opt = new JsonObject();
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
            });
        }
    }

    class ObjectHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonArray response = new JsonArray();
            if (client.getGameState() != GameState.LOGGED_IN) {
                return gson.toJson(response);
            }

            Tile[][] tiles = client.getScene().getTiles()[client.getPlane()];
            for (int x = 0; x < tiles.length; x++) {
                for (int y = 0; y < tiles[x].length; y++) {
                    Tile tile = tiles[x][y];
                    if (tile != null) {
                        GameObject[] gameObjects = tile.getGameObjects();
                        if (gameObjects != null) {
                            for (GameObject obj : gameObjects) {
                                if (obj != null && obj.getId() != -1) {
                                    JsonObject jsonObj = new JsonObject();
                                    jsonObj.addProperty("id", obj.getId());
                                    jsonObj.addProperty("name", getObjectName(obj.getId()));
                                    
                                    WorldPoint wp = obj.getWorldLocation();
                                    jsonObj.addProperty("worldX", wp.getX());
                                    jsonObj.addProperty("worldY", wp.getY());

                                    LocalPoint lp = obj.getLocalLocation();
                                    addRawLocalPoint(jsonObj, lp);
                                    addCanvasCoordinateFromShape(jsonObj, obj.getClickbox(), "clickbox");
                                    response.add(jsonObj);
                                }
                            }
                        }
                    }
                }
            }
            return gson.toJson(response);
            });
        }
    }

    class GroundItemHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonArray response = new JsonArray();
            if (client.getGameState() != GameState.LOGGED_IN) {
                return gson.toJson(response);
            }

            Tile[][] tiles = client.getScene().getTiles()[client.getPlane()];
            for (int x = 0; x < tiles.length; x++) {
                for (int y = 0; y < tiles[x].length; y++) {
                    Tile tile = tiles[x][y];
                    if (tile != null && tile.getGroundItems() != null) {
                        for (TileItem item : tile.getGroundItems()) {
                            JsonObject jsonObj = new JsonObject();
                            jsonObj.addProperty("id", item.getId());
                            jsonObj.addProperty("name", getItemName(item.getId()));
                            jsonObj.addProperty("quantity", item.getQuantity());

                            WorldPoint wp = tile.getWorldLocation();
                            jsonObj.addProperty("worldX", wp.getX());
                            jsonObj.addProperty("worldY", wp.getY());

                            LocalPoint lp = tile.getLocalLocation();
                            addRawLocalPoint(jsonObj, lp);
                            response.add(jsonObj);
                        }
                    }
                }
            }
            return gson.toJson(response);
            });
        }
    }

    class BankHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonArray response = new JsonArray();
            ItemContainer bank = client.getItemContainer(InventoryID.BANK);
            if (bank != null) {
                Item[] items = bank.getItems();
                for (int i = 0; i < items.length; i++) {
                    Item item = items[i];
                    if (item.getId() != -1 && item.getId() != 0) {
                        JsonObject itemObj = new JsonObject();
                        itemObj.addProperty("id", item.getId());
                        itemObj.addProperty("name", getItemName(item.getId()));
                        itemObj.addProperty("quantity", item.getQuantity());
                        itemObj.addProperty("slot", i);
                        response.add(itemObj);
                    }
                }
            }
            return gson.toJson(response);
            });
        }
    }

    class EquipmentHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonArray response = new JsonArray();
            ItemContainer equipment = client.getItemContainer(InventoryID.EQUIPMENT);
            if (equipment != null) {
                Item[] items = equipment.getItems();
                for (int i = 0; i < items.length; i++) {
                    Item item = items[i];
                    if (item.getId() != -1 && item.getId() != 0) {
                        JsonObject itemObj = new JsonObject();
                        itemObj.addProperty("id", item.getId());
                        itemObj.addProperty("name", getItemName(item.getId()));
                        itemObj.addProperty("quantity", item.getQuantity());
                        itemObj.addProperty("slot", i);
                        response.add(itemObj);
                    }
                }
            }
            return gson.toJson(response);
            });
        }
    }

    class SkillsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> {
            JsonObject response = new JsonObject();
            for (Skill skill : Skill.values()) {
                if (skill != Skill.OVERALL) {
                    JsonObject skillObj = new JsonObject();
                    skillObj.addProperty("level", client.getRealSkillLevel(skill));
                    skillObj.addProperty("boostedLevel", client.getBoostedSkillLevel(skill));
                    skillObj.addProperty("xp", client.getSkillExperience(skill));
                    response.add(skill.getName(), skillObj);
                }
            }
            return gson.toJson(response);
            });
        }
    }

    class CoordinateDebugHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            handleOnClientThread(t, () -> gson.toJson(getCoordinateDebug()));
        }
    }
}
