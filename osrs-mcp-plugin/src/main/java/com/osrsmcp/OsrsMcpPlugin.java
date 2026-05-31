package com.osrsmcp;

import javax.inject.Inject;
import net.runelite.api.Actor;
import net.runelite.api.Client;
import net.runelite.client.callback.ClientThread;
import net.runelite.api.events.AnimationChanged;
import net.runelite.api.events.ChatMessage;
import net.runelite.api.events.ClientTick;
import net.runelite.api.events.GameTick;
import net.runelite.api.events.ItemContainerChanged;
import net.runelite.api.events.WidgetLoaded;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.game.ItemManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@PluginDescriptor(
	name = "OSRS MCP",
	description = "Exposes local HTTP API for AI Agents (MCP)",
	tags = {"mcp", "ai", "bot", "http"}
)
public class OsrsMcpPlugin extends Plugin
{
	private static final Logger log = LoggerFactory.getLogger(OsrsMcpPlugin.class);

	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	@Inject
	private ItemManager itemManager;

	private ApiServer apiServer;

	@Override
	protected void startUp() throws Exception
	{
		log.info("OSRS MCP started!");
		apiServer = new ApiServer(client, clientThread, itemManager);
		apiServer.start();
	}

	@Override
	protected void shutDown() throws Exception
	{
		log.info("OSRS MCP stopped!");
		if (apiServer != null)
		{
			apiServer.stop();
		}
	}

	@Subscribe
	public void onGameTick(GameTick event)
	{
		if (apiServer != null)
		{
			apiServer.onGameTick();
		}
	}

	@Subscribe
	public void onClientTick(ClientTick event)
	{
		if (apiServer != null)
		{
			apiServer.updateSnapshotFromClientTick();
		}
	}

	@Subscribe
	public void onChatMessage(ChatMessage event)
	{
		if (apiServer != null)
		{
			apiServer.addChatMessage(
				event.getType() != null ? event.getType().name() : "",
				event.getName(),
				event.getSender(),
				event.getMessage(),
				event.getTimestamp()
			);
		}
	}

	@Subscribe
	public void onAnimationChanged(AnimationChanged event)
	{
		if (apiServer != null && event.getActor() != null)
		{
			Actor actor = event.getActor();
			apiServer.addAnimationChanged(
				actor.getName(),
				actor.getAnimation(),
				actor == client.getLocalPlayer()
			);
		}
	}

	@Subscribe
	public void onItemContainerChanged(ItemContainerChanged event)
	{
		if (apiServer != null && event.getItemContainer() != null)
		{
			apiServer.addItemContainerChanged(
				event.getContainerId(),
				event.getItemContainer().getItems().length
			);
		}
	}

	@Subscribe
	public void onWidgetLoaded(WidgetLoaded event)
	{
		if (apiServer != null)
		{
			apiServer.addWidgetLoaded(event.getGroupId());
		}
	}
}
