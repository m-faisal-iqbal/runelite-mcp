/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  com.jagex.oldscape.pub.OAuthApi
 *  javax.annotation.Nonnull
 *  javax.annotation.Nullable
 *  net.runelite.api.Actor
 *  net.runelite.api.AmbientSoundEffect
 *  net.runelite.api.Animation
 *  net.runelite.api.BufferProvider
 *  net.runelite.api.CameraFocusableEntity
 *  net.runelite.api.ChatLineBuffer
 *  net.runelite.api.ChatMessageType
 *  net.runelite.api.CollisionData
 *  net.runelite.api.Deque
 *  net.runelite.api.EnumComposition
 *  net.runelite.api.FriendContainer
 *  net.runelite.api.FriendsChatManager
 *  net.runelite.api.GameEngine
 *  net.runelite.api.GameState
 *  net.runelite.api.GrandExchangeOffer
 *  net.runelite.api.GraphicsObject
 *  net.runelite.api.HashTable
 *  net.runelite.api.Ignore
 *  net.runelite.api.IndexDataBase
 *  net.runelite.api.IndexedSprite
 *  net.runelite.api.InventoryID
 *  net.runelite.api.ItemComposition
 *  net.runelite.api.ItemContainer
 *  net.runelite.api.IterableHashTable
 *  net.runelite.api.Menu
 *  net.runelite.api.MenuAction
 *  net.runelite.api.MenuEntry
 *  net.runelite.api.MessageNode
 *  net.runelite.api.MidiRequest
 *  net.runelite.api.Model
 *  net.runelite.api.ModelData
 *  net.runelite.api.NPC
 *  net.runelite.api.NPCComposition
 *  net.runelite.api.NameableContainer
 *  net.runelite.api.NodeCache
 *  net.runelite.api.ObjectComposition
 *  net.runelite.api.Player
 *  net.runelite.api.Point
 *  net.runelite.api.Prayer
 *  net.runelite.api.Preferences
 *  net.runelite.api.Projectile
 *  net.runelite.api.Projection
 *  net.runelite.api.Rasterizer
 *  net.runelite.api.RenderOverview
 *  net.runelite.api.RuneLiteObject
 *  net.runelite.api.RuneLiteObjectController
 *  net.runelite.api.Scene
 *  net.runelite.api.SceneTilePaint
 *  net.runelite.api.ScriptEventBuilder
 *  net.runelite.api.Skill
 *  net.runelite.api.SpritePixels
 *  net.runelite.api.StructComposition
 *  net.runelite.api.TextureProvider
 *  net.runelite.api.Tile
 *  net.runelite.api.TileFunction
 *  net.runelite.api.VarbitComposition
 *  net.runelite.api.WidgetNode
 *  net.runelite.api.World
 *  net.runelite.api.WorldType
 *  net.runelite.api.WorldView
 *  net.runelite.api.clan.ClanChannel
 *  net.runelite.api.clan.ClanSettings
 *  net.runelite.api.coords.LocalPoint
 *  net.runelite.api.coords.WorldPoint
 *  net.runelite.api.dbtable.DBRowConfig
 *  net.runelite.api.hooks.Callbacks
 *  net.runelite.api.hooks.DrawCallbacks
 *  net.runelite.api.vars.AccountType
 *  net.runelite.api.widgets.Widget
 *  net.runelite.api.widgets.WidgetConfigNode
 *  net.runelite.api.widgets.WidgetInfo
 *  net.runelite.api.worldmap.MapElementConfig
 *  net.runelite.api.worldmap.WorldMap
 */
package net.runelite.api;

import com.jagex.oldscape.pub.OAuthApi;
import java.awt.Canvas;
import java.awt.Dimension;
import java.io.FileDescriptor;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.function.IntPredicate;
import java.util.stream.Collectors;
import javax.annotation.Nonnull;
import javax.annotation.Nullable;
import net.runelite.api.Actor;
import net.runelite.api.AmbientSoundEffect;
import net.runelite.api.Animation;
import net.runelite.api.BufferProvider;
import net.runelite.api.CameraFocusableEntity;
import net.runelite.api.ChatLineBuffer;
import net.runelite.api.ChatMessageType;
import net.runelite.api.CollisionData;
import net.runelite.api.Deque;
import net.runelite.api.EnumComposition;
import net.runelite.api.FriendContainer;
import net.runelite.api.FriendsChatManager;
import net.runelite.api.GameEngine;
import net.runelite.api.GameState;
import net.runelite.api.GrandExchangeOffer;
import net.runelite.api.GraphicsObject;
import net.runelite.api.HashTable;
import net.runelite.api.Ignore;
import net.runelite.api.IndexDataBase;
import net.runelite.api.IndexedSprite;
import net.runelite.api.InventoryID;
import net.runelite.api.ItemComposition;
import net.runelite.api.ItemContainer;
import net.runelite.api.IterableHashTable;
import net.runelite.api.Menu;
import net.runelite.api.MenuAction;
import net.runelite.api.MenuEntry;
import net.runelite.api.MessageNode;
import net.runelite.api.MidiRequest;
import net.runelite.api.Model;
import net.runelite.api.ModelData;
import net.runelite.api.NPC;
import net.runelite.api.NPCComposition;
import net.runelite.api.NameableContainer;
import net.runelite.api.NodeCache;
import net.runelite.api.ObjectComposition;
import net.runelite.api.Player;
import net.runelite.api.Point;
import net.runelite.api.Prayer;
import net.runelite.api.Preferences;
import net.runelite.api.Projectile;
import net.runelite.api.Projection;
import net.runelite.api.Rasterizer;
import net.runelite.api.RenderOverview;
import net.runelite.api.RuneLiteObject;
import net.runelite.api.RuneLiteObjectController;
import net.runelite.api.Scene;
import net.runelite.api.SceneTilePaint;
import net.runelite.api.ScriptEventBuilder;
import net.runelite.api.Skill;
import net.runelite.api.SpritePixels;
import net.runelite.api.StructComposition;
import net.runelite.api.TextureProvider;
import net.runelite.api.Tile;
import net.runelite.api.TileFunction;
import net.runelite.api.VarbitComposition;
import net.runelite.api.WidgetNode;
import net.runelite.api.World;
import net.runelite.api.WorldType;
import net.runelite.api.WorldView;
import net.runelite.api.clan.ClanChannel;
import net.runelite.api.clan.ClanSettings;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.dbtable.DBRowConfig;
import net.runelite.api.hooks.Callbacks;
import net.runelite.api.hooks.DrawCallbacks;
import net.runelite.api.vars.AccountType;
import net.runelite.api.widgets.Widget;
import net.runelite.api.widgets.WidgetConfigNode;
import net.runelite.api.widgets.WidgetInfo;
import net.runelite.api.worldmap.MapElementConfig;
import net.runelite.api.worldmap.WorldMap;

public interface Client
extends OAuthApi,
GameEngine {
    public static final int DRAW_2D_ALL = -1;
    public static final int DRAW_2D_NONE = 0;
    public static final int DRAW_2D_OVERHEAD_TEXT = 1;
    public static final int DRAW_2D_OTHERS = 0x40000000;

    public Callbacks getCallbacks();

    public DrawCallbacks getDrawCallbacks();

    public void setDrawCallbacks(DrawCallbacks var1);

    public String getBuildID();

    public int getEnvironment();

    public int getBoostedSkillLevel(Skill var1);

    public int getRealSkillLevel(Skill var1);

    public int getTotalLevel();

    public MessageNode addChatMessage(ChatMessageType var1, @Nonnull String var2, String var3, String var4);

    public MessageNode addChatMessage(ChatMessageType var1, @Nonnull String var2, String var3, String var4, boolean var5);

    public GameState getGameState();

    public void setGameState(GameState var1);

    public void stopNow();

    @Nullable
    public String getLauncherDisplayName();

    @Deprecated
    public String getUsername();

    public void setUsername(String var1);

    public void setPassword(String var1);

    public void setOtp(String var1);

    public int getCurrentLoginField();

    public int getLoginIndex();

    @Deprecated
    public AccountType getAccountType();

    public Canvas getCanvas();

    public int getFPS();

    public int getCameraX();

    public double getCameraFpX();

    public int getCameraY();

    public double getCameraFpY();

    public int getCameraZ();

    public double getCameraFpZ();

    public int getCameraPitch();

    public double getCameraFpPitch();

    public int getCameraYaw();

    public double getCameraFpYaw();

    public int getWorld();

    public int getCanvasHeight();

    public int getCanvasWidth();

    public int getViewportHeight();

    public int getViewportWidth();

    public int getViewportXOffset();

    public int getViewportYOffset();

    public int getScale();

    public Point getMouseCanvasPosition();

    public Player getLocalPlayer();

    @Nullable
    public NPC getFollower();

    @Nonnull
    public ItemComposition getItemDefinition(int var1);

    @Nullable
    public SpritePixels createItemSprite(int var1, int var2, int var3, int var4, int var5, boolean var6, int var7);

    public NodeCache getItemModelCache();

    public NodeCache getItemSpriteCache();

    @Nullable
    public SpritePixels[] getSprites(IndexDataBase var1, int var2, int var3);

    public IndexDataBase getIndexSprites();

    public IndexDataBase getIndexScripts();

    public IndexDataBase getIndexConfig();

    public IndexDataBase getIndex(int var1);

    public int getMouseCurrentButton();

    public boolean isDraggingWidget();

    @Nullable
    public Widget getDraggedWidget();

    @Nullable
    public Widget getDraggedOnWidget();

    public void setDraggedOnWidget(Widget var1);

    public int getDragTime();

    public int getTopLevelInterfaceId();

    public Widget[] getWidgetRoots();

    @Nullable
    @Deprecated
    public Widget getWidget(WidgetInfo var1);

    @Nullable
    public Widget getWidget(int var1, int var2);

    @Nullable
    public Widget getWidget(int var1);

    public int getEnergy();

    public int getWeight();

    public String[] getPlayerOptions();

    public boolean[] getPlayerOptionsPriorities();

    public int[] getPlayerMenuTypes();

    public World[] getWorldList();

    @Nonnull
    public Menu getMenu();

    @Deprecated
    public MenuEntry createMenuEntry(int var1);

    @Deprecated
    public MenuEntry[] getMenuEntries();

    @Deprecated
    public void setMenuEntries(MenuEntry[] var1);

    public boolean isMenuOpen();

    public boolean isMenuScrollable();

    public int getMenuScroll();

    public void setMenuScroll(int var1);

    @Deprecated
    public int getMenuX();

    @Deprecated
    public int getMenuY();

    @Deprecated
    public int getMenuHeight();

    @Deprecated
    public int getMenuWidth();

    @Deprecated
    public int getMapAngle();

    public boolean isResized();

    public int getRevision();

    public int[] getVarps();

    public int[] getServerVarps();

    public Map<Integer, Object> getVarcMap();

    @Deprecated
    public int getVar(int var1);

    public int getVarbitValue(int var1);

    public int getServerVarbitValue(int var1);

    public int getVarpValue(int var1);

    public int getServerVarpValue(int var1);

    public int getVarcIntValue(int var1);

    public String getVarcStrValue(int var1);

    public void setVarcStrValue(int var1, String var2);

    public void setVarcIntValue(int var1, int var2);

    public void setVarbit(int var1, int var2);

    @Nullable
    public VarbitComposition getVarbit(int var1);

    public int getVarbitValue(int[] var1, int var2);

    public void setVarbitValue(int[] var1, int var2, int var3);

    public void queueChangedVarp(int var1);

    public WidgetNode openInterface(int var1, int var2, int var3);

    public void closeInterface(WidgetNode var1, boolean var2);

    public HashTable<WidgetConfigNode> getWidgetFlags();

    @Nullable
    public WidgetConfigNode getWidgetConfig(Widget var1);

    public HashTable<WidgetNode> getComponentTable();

    public GrandExchangeOffer[] getGrandExchangeOffers();

    @Deprecated
    public boolean isPrayerActive(Prayer var1);

    public int getSkillExperience(Skill var1);

    public long getOverallExperience();

    public void refreshChat();

    public Map<Integer, ChatLineBuffer> getChatLineMap();

    public IterableHashTable<MessageNode> getMessages();

    public ObjectComposition getObjectDefinition(int var1);

    public NPCComposition getNpcDefinition(int var1);

    public StructComposition getStructComposition(int var1);

    public NodeCache getStructCompositionCache();

    public Object[] getDBTableField(int var1, int var2, int var3);

    public DBRowConfig getDBRowConfig(int var1);

    public List<Integer> getDBRowsByValue(int var1, int var2, int var3, Object var4);

    public List<Integer> getDBTableRows(int var1);

    public MapElementConfig getMapElementConfig(int var1);

    public IndexedSprite[] getMapScene();

    public SpritePixels[] getMapDots();

    public int getGameCycle();

    public SpritePixels[] getMapIcons();

    public IndexedSprite[] getModIcons();

    public void setModIcons(IndexedSprite[] var1);

    public IndexedSprite createIndexedSprite();

    public SpritePixels createSpritePixels(int[] var1, int var2, int var3);

    @Nullable
    public LocalPoint getLocalDestinationLocation();

    public RuneLiteObject createRuneLiteObject();

    public void registerRuneLiteObject(RuneLiteObjectController var1);

    public void removeRuneLiteObject(RuneLiteObjectController var1);

    public boolean isRuneLiteObjectRegistered(RuneLiteObjectController var1);

    @Nullable
    public ModelData loadModelData(int var1);

    public ModelData mergeModels(ModelData[] var1, int var2);

    public ModelData mergeModels(ModelData ... var1);

    public Model mergeModels(Model[] var1, int var2);

    public Model mergeModels(Model ... var1);

    @Nullable
    public Model loadModel(int var1);

    @Nullable
    public Model loadModel(int var1, short[] var2, short[] var3);

    public Animation loadAnimation(int var1);

    public int getMusicVolume();

    public void setMusicVolume(int var1);

    public void playSoundEffect(int var1);

    public void playSoundEffect(int var1, int var2, int var3, int var4);

    public void playSoundEffect(int var1, int var2, int var3, int var4, int var5);

    public void playSoundEffect(int var1, int var2);

    public List<MidiRequest> getActiveMidiRequests();

    public BufferProvider getBufferProvider();

    public int getMouseIdleTicks();

    public long getMouseLastPressedMillis();

    public int getKeyboardIdleTicks();

    public void changeMemoryMode(boolean var1);

    @Nullable
    public ItemContainer getItemContainer(InventoryID var1);

    @Nullable
    public ItemContainer getItemContainer(int var1);

    public HashTable<ItemContainer> getItemContainers();

    public int getIntStackSize();

    public void setIntStackSize(int var1);

    public int[] getIntStack();

    public int getObjectStackSize();

    public void setObjectStackSize(int var1);

    public Object[] getObjectStack();

    public int getArraySizes(int var1);

    public int[] getArray(int var1);

    public Widget getScriptActiveWidget();

    public Widget getScriptDotWidget();

    public boolean isFriended(String var1, boolean var2);

    @Nullable
    public FriendsChatManager getFriendsChatManager();

    public FriendContainer getFriendContainer();

    public NameableContainer<Ignore> getIgnoreContainer();

    public Preferences getPreferences();

    public int getCameraYawTarget();

    public int getCameraPitchTarget();

    public void setCameraYawTarget(int var1);

    public void setCameraPitchTarget(int var1);

    public void setCameraSpeed(float var1);

    public void setCameraMouseButtonMask(int var1);

    public void setCameraPitchRelaxerEnabled(boolean var1);

    public void setInvertYaw(boolean var1);

    public void setInvertPitch(boolean var1);

    @Deprecated
    public RenderOverview getRenderOverview();

    public WorldMap getWorldMap();

    public boolean isStretchedEnabled();

    public void setStretchedEnabled(boolean var1);

    public boolean isStretchedFast();

    public void setStretchedFast(boolean var1);

    public void setStretchedIntegerScaling(boolean var1);

    public void setStretchedKeepAspectRatio(boolean var1);

    public void setScalingFactor(int var1);

    public void invalidateStretching(boolean var1);

    public Dimension getStretchedDimensions();

    public Dimension getRealDimensions();

    public void changeWorld(World var1);

    public World createWorld();

    public SpritePixels drawInstanceMap(int var1);

    public void runScript(Object ... var1);

    public ScriptEventBuilder createScriptEventBuilder(Object ... var1);

    public boolean hasHintArrow();

    public int getHintArrowType();

    public void clearHintArrow();

    public void setHintArrow(WorldPoint var1);

    public void setHintArrow(LocalPoint var1);

    public void setHintArrow(Player var1);

    public void setHintArrow(NPC var1);

    public WorldPoint getHintArrowPoint();

    public Player getHintArrowPlayer();

    public NPC getHintArrowNpc();

    public IntPredicate getAnimationInterpolationFilter();

    public void setAnimationInterpolationFilter(IntPredicate var1);

    public int[] getBoostedSkillLevels();

    public int[] getRealSkillLevels();

    public int[] getSkillExperiences();

    public void queueChangedSkill(Skill var1);

    public Map<Integer, SpritePixels> getSpriteOverrides();

    public Map<Integer, SpritePixels> getWidgetSpriteOverrides();

    public void setCompass(SpritePixels var1);

    public NodeCache getWidgetSpriteCache();

    public int getTickCount();

    public void setTickCount(int var1);

    @Deprecated
    public void setInventoryDragDelay(int var1);

    public String getWorldHost();

    public EnumSet<WorldType> getWorldType();

    public int getCameraMode();

    public void setCameraMode(int var1);

    public double getCameraFocalPointX();

    public void setCameraFocalPointX(double var1);

    public double getCameraFocalPointY();

    public void setCameraFocalPointY(double var1);

    public double getCameraFocalPointZ();

    public void setCameraFocalPointZ(double var1);

    public void setFreeCameraSpeed(int var1);

    @Deprecated
    public int getOculusOrbState();

    @Deprecated
    public void setOculusOrbState(int var1);

    @Deprecated
    public void setOculusOrbNormalSpeed(int var1);

    @Deprecated
    public int getOculusOrbFocalPointX();

    @Deprecated
    public int getOculusOrbFocalPointY();

    public void openWorldHopper();

    public void hopToWorld(World var1);

    public void setSkyboxColor(int var1);

    public int getSkyboxColor();

    public boolean isGpu();

    public void setGpuFlags(int var1);

    public void setExpandedMapLoading(int var1);

    public int getExpandedMapLoading();

    public int get3dZoom();

    public int getCenterX();

    public int getCenterY();

    public TextureProvider getTextureProvider();

    public int getRasterizer3D_clipMidX2();

    public int getRasterizer3D_clipNegativeMidX();

    public int getRasterizer3D_clipNegativeMidY();

    public int getRasterizer3D_clipMidY2();

    public void checkClickbox(Projection var1, Model var2, int var3, int var4, int var5, int var6, long var7);

    public boolean isWidgetSelected();

    public void setWidgetSelected(boolean var1);

    @Nullable
    public Widget getSelectedWidget();

    @Nullable
    public Widget getFocusedInputFieldWidget();

    public NodeCache getItemCompositionCache();

    public NodeCache getObjectCompositionCache();

    public NodeCache getAnimationCache();

    public SpritePixels[] getCrossSprites();

    public EnumComposition getEnum(int var1);

    public void draw2010Menu(int var1);

    public void drawOriginalMenu(int var1);

    public void resetHealthBarCaches();

    public int getItemCount();

    public void setAllWidgetsAreOpTargetable(boolean var1);

    public void setGeSearchResultCount(int var1);

    public void setGeSearchResultIds(short[] var1);

    public void setGeSearchResultIndex(int var1);

    public void setLoginScreen(SpritePixels var1);

    public void setShouldRenderLoginScreenFire(boolean var1);

    public boolean isKeyPressed(int var1);

    public long[] getCrossWorldMessageIds();

    public int getCrossWorldMessageIdsIndex();

    @Nullable
    public ClanChannel getClanChannel();

    @Nullable
    public ClanChannel getGuestClanChannel();

    @Nullable
    public ClanSettings getClanSettings();

    @Nullable
    public ClanSettings getGuestClanSettings();

    @Nullable
    public ClanChannel getClanChannel(int var1);

    @Nullable
    public ClanSettings getClanSettings(int var1);

    public void setUnlockedFps(boolean var1);

    public void setUnlockedFpsTarget(int var1);

    @Deprecated
    public Deque<AmbientSoundEffect> getAmbientSoundEffects();

    public void setIdleTimeout(int var1);

    public int getIdleTimeout();

    public boolean isMinimapZoom();

    public void setMinimapZoom(boolean var1);

    public double getMinimapZoom();

    public void setMinimapZoom(double var1);

    public void setMinimapTileDrawer(TileFunction var1);

    public Rasterizer getRasterizer();

    public void menuAction(int var1, int var2, MenuAction var3, int var4, int var5, String var6, String var7);

    public WorldView getWorldView(int var1);

    public WorldView getTopLevelWorldView();

    public boolean isCameraShakeDisabled();

    public void setCameraShakeDisabled(boolean var1);

    public int getDraw2DMask();

    public void setDraw2DMask(int var1);

    @Deprecated
    public int[][][] getInstanceTemplateChunks();

    @Deprecated
    public boolean isInInstancedRegion();

    @Deprecated
    public int[] getMapRegions();

    @Deprecated
    default public Scene getScene() {
        WorldView wv = this.getTopLevelWorldView();
        return wv == null ? null : wv.getScene();
    }

    @Deprecated
    default public List<Player> getPlayers() {
        WorldView wv = this.getTopLevelWorldView();
        return wv == null ? Collections.emptyList() : (List)wv.players().stream().collect(Collectors.toCollection(ArrayList::new));
    }

    @Deprecated
    default public List<NPC> getNpcs() {
        WorldView wv = this.getTopLevelWorldView();
        return wv == null ? Collections.emptyList() : (List)wv.npcs().stream().collect(Collectors.toCollection(ArrayList::new));
    }

    @Nullable
    @Deprecated
    default public CollisionData[] getCollisionMaps() {
        return this.getTopLevelWorldView().getCollisionMaps();
    }

    @Deprecated
    default public int getPlane() {
        return this.getTopLevelWorldView().getPlane();
    }

    @Deprecated
    default public int[][][] getTileHeights() {
        return this.getTopLevelWorldView().getTileHeights();
    }

    @Deprecated
    default public byte[][][] getTileSettings() {
        return this.getTopLevelWorldView().getTileSettings();
    }

    @Deprecated
    default public int getBaseX() {
        WorldView wv = this.getTopLevelWorldView();
        return wv == null ? 0 : wv.getBaseX();
    }

    @Deprecated
    default public int getBaseY() {
        WorldView wv = this.getTopLevelWorldView();
        return wv == null ? 0 : wv.getBaseY();
    }

    @Deprecated
    public Projectile createProjectile(int var1, int var2, int var3, int var4, int var5, int var6, int var7, int var8, int var9, int var10, @Nullable Actor var11, int var12, int var13);

    public Projectile createProjectile(int var1, WorldPoint var2, int var3, @Nullable Actor var4, WorldPoint var5, int var6, @Nullable Actor var7, int var8, int var9, int var10, int var11);

    public Deque<Projectile> getProjectiles();

    @Deprecated
    default public Deque<GraphicsObject> getGraphicsObjects() {
        return this.getTopLevelWorldView().getGraphicsObjects();
    }

    @Deprecated
    @Nullable
    default public Tile getSelectedSceneTile() {
        return this.getTopLevelWorldView().getSelectedSceneTile();
    }

    public Model applyTransformations(Model var1, @Nullable Animation var2, int var3, @Nullable Animation var4, int var5);

    public SceneTilePaint createSceneTilePaint(int var1, int var2, int var3, int var4, int var5, int var6, boolean var7);

    @Nullable
    public CameraFocusableEntity getCameraFocusEntity();

    @Nonnull
    public WorldView findWorldViewFromWorldPoint(WorldPoint var1);

    @Nullable
    public FileDescriptor getSocketFD();
}
