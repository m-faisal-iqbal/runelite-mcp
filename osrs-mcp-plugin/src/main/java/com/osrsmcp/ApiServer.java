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

import java.io.IOException;
import java.io.OutputStream;
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
    private final Gson gson = new Gson();

    public ApiServer(Client client, ClientThread clientThread) {
        this.client = client;
        this.clientThread = clientThread;
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
        endpoints.add(endpoint("/api/inventory", "Inventory item IDs, quantities, and slots."));
        endpoints.add(endpoint("/api/npcs", "Nearby NPC IDs, names, world coordinates, and projected screen coordinates."));
        endpoints.add(endpoint("/api/dialogue", "Open NPC/player dialogue text, dialogue options, and clickable screen coordinates when available."));
        endpoints.add(endpoint("/api/objects", "Scene game object IDs, world coordinates, and projected screen coordinates."));
        endpoints.add(endpoint("/api/grounditems", "Visible ground item IDs, quantities, world coordinates, and projected screen coordinates."));
        endpoints.add(endpoint("/api/bank", "Bank item IDs, quantities, and slots when the bank container is available."));
        endpoints.add(endpoint("/api/equipment", "Equipped item IDs, quantities, and slots."));
        endpoints.add(endpoint("/api/skills", "Real level, boosted level, and XP for each skill."));
        response.add("endpoints", endpoints);

        return gson.toJson(response);
    }

    private void addWidgetCenter(JsonObject response, Widget widget, String xProperty, String yProperty) {
        if (widget == null || widget.isHidden()) {
            return;
        }

        java.awt.Rectangle bounds = widget.getBounds();
        if (bounds != null) {
            response.addProperty(xProperty, bounds.getCenterX());
            response.addProperty(yProperty, bounds.getCenterY());
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
                npcObj.addProperty("name", npc.getName());
                
                WorldPoint wp = npc.getWorldLocation();
                npcObj.addProperty("worldX", wp.getX());
                npcObj.addProperty("worldY", wp.getY());

                // Calculate screen coordinates
                LocalPoint lp = npc.getLocalLocation();
                if (lp != null) {
                    Point screenPoint = Perspective.localToCanvas(client, lp, client.getPlane());
                    if (screenPoint != null) {
                        npcObj.addProperty("screenX", screenPoint.getX());
                        npcObj.addProperty("screenY", screenPoint.getY());
                    }
                }
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
                addWidgetCenter(response, npcDialogueText, "continueScreenX", "continueScreenY");
                return gson.toJson(response);
            }

            // Check Player Dialogue
            Widget playerDialogueText = client.getWidget(WidgetInfo.DIALOG_PLAYER_TEXT);

            if (playerDialogueText != null && !playerDialogueText.isHidden()) {
                response.addProperty("type", "PLAYER_DIALOGUE");
                response.addProperty("text", playerDialogueText.getText());
                addWidgetCenter(response, playerDialogueText, "continueScreenX", "continueScreenY");
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
                            java.awt.Rectangle bounds = child.getBounds();
                            if (bounds != null) {
                                opt.addProperty("screenX", bounds.getCenterX());
                                opt.addProperty("screenY", bounds.getCenterY());
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
                                    
                                    WorldPoint wp = obj.getWorldLocation();
                                    jsonObj.addProperty("worldX", wp.getX());
                                    jsonObj.addProperty("worldY", wp.getY());

                                    LocalPoint lp = obj.getLocalLocation();
                                    if (lp != null) {
                                        Point screenPoint = Perspective.localToCanvas(client, lp, client.getPlane());
                                        if (screenPoint != null) {
                                            jsonObj.addProperty("screenX", screenPoint.getX());
                                            jsonObj.addProperty("screenY", screenPoint.getY());
                                        }
                                    }
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
                            jsonObj.addProperty("quantity", item.getQuantity());

                            WorldPoint wp = tile.getWorldLocation();
                            jsonObj.addProperty("worldX", wp.getX());
                            jsonObj.addProperty("worldY", wp.getY());

                            LocalPoint lp = tile.getLocalLocation();
                            if (lp != null) {
                                Point screenPoint = Perspective.localToCanvas(client, lp, client.getPlane());
                                if (screenPoint != null) {
                                    jsonObj.addProperty("screenX", screenPoint.getX());
                                    jsonObj.addProperty("screenY", screenPoint.getY());
                                }
                            }
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
}
