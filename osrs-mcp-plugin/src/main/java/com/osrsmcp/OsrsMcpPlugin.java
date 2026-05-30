package com.osrsmcp;

import com.google.inject.Provides;
import javax.inject.Inject;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Client;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;

@Slf4j
@PluginDescriptor(
	name = "OSRS MCP",
	description = "Exposes local HTTP API for AI Agents (MCP)",
	tags = {"mcp", "ai", "bot", "http"}
)
public class OsrsMcpPlugin extends Plugin
{
	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	private ApiServer apiServer;

	@Override
	protected void startUp() throws Exception
	{
		log.info("OSRS MCP started!");
		apiServer = new ApiServer(client, clientThread);
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
