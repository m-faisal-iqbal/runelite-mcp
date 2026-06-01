/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  javax.annotation.Nullable
 *  net.runelite.api.Actor
 *  net.runelite.api.CollisionData
 *  net.runelite.api.Deque
 *  net.runelite.api.GraphicsObject
 *  net.runelite.api.IndexedObjectSet
 *  net.runelite.api.NPC
 *  net.runelite.api.Player
 *  net.runelite.api.Projectile
 *  net.runelite.api.Projection
 *  net.runelite.api.Scene
 *  net.runelite.api.Tile
 *  net.runelite.api.WorldEntity
 *  net.runelite.api.coords.LocalPoint
 *  net.runelite.api.coords.WorldPoint
 */
package net.runelite.api;

import javax.annotation.Nullable;
import net.runelite.api.Actor;
import net.runelite.api.CollisionData;
import net.runelite.api.Deque;
import net.runelite.api.GraphicsObject;
import net.runelite.api.IndexedObjectSet;
import net.runelite.api.NPC;
import net.runelite.api.Player;
import net.runelite.api.Projectile;
import net.runelite.api.Projection;
import net.runelite.api.Scene;
import net.runelite.api.Tile;
import net.runelite.api.WorldEntity;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.coords.WorldPoint;

public interface WorldView {
    public static final int TOPLEVEL = 0;

    public int getId();

    public boolean isTopLevel();

    public Scene getScene();

    public IndexedObjectSet<? extends Player> players();

    public IndexedObjectSet<? extends NPC> npcs();

    public IndexedObjectSet<? extends WorldEntity> worldEntities();

    public IndexedObjectSet<? extends WorldView> worldViews();

    @Nullable
    public CollisionData[] getCollisionMaps();

    public int getPlane();

    public int[][][] getTileHeights();

    public byte[][][] getTileSettings();

    public int getSizeX();

    public int getSizeY();

    public int getBaseX();

    public int getBaseY();

    @Deprecated
    public Projectile createProjectile(int var1, int var2, int var3, int var4, int var5, int var6, int var7, int var8, int var9, int var10, @Nullable Actor var11, int var12, int var13);

    public Deque<GraphicsObject> getGraphicsObjects();

    @Nullable
    public Tile getSelectedSceneTile();

    public boolean isInstance();

    public int[][][] getInstanceTemplateChunks();

    public int[] getMapRegions();

    public boolean contains(WorldPoint var1);

    public boolean contains(LocalPoint var1);

    @Nullable
    public Projection getMainWorldProjection();

    @Nullable
    public Projection getCanvasProjection();

    public int getYellowClickAction();

    public int getTileHeight(int var1, int var2, int var3);
}
