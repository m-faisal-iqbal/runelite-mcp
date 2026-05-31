package com.osrsmcp;

final class GameStateSnapshot {
    final long capturedAt;
    final String state;
    final String npcs;
    final String dialogue;
    final String objects;
    final String groundItems;
    final String players;
    final String inventory;
    final String bank;
    final String equipment;
    final String skills;
    final String prayers;
    final String combat;
    final String chat;
    final String interfaceSummary;
    final String snapshot;

    GameStateSnapshot(
        long capturedAt,
        String state,
        String npcs,
        String dialogue,
        String objects,
        String groundItems,
        String players,
        String inventory,
        String bank,
        String equipment,
        String skills,
        String prayers,
        String combat,
        String chat,
        String interfaceSummary,
        String snapshot
    ) {
        this.capturedAt = capturedAt;
        this.state = state;
        this.npcs = npcs;
        this.dialogue = dialogue;
        this.objects = objects;
        this.groundItems = groundItems;
        this.players = players;
        this.inventory = inventory;
        this.bank = bank;
        this.equipment = equipment;
        this.skills = skills;
        this.prayers = prayers;
        this.combat = combat;
        this.chat = chat;
        this.interfaceSummary = interfaceSummary;
        this.snapshot = snapshot;
    }
}
