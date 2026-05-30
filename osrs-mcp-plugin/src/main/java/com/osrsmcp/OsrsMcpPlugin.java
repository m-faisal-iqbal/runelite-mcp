package com.osrsmcp;

import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.client.callback.ClientThread;
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
}
