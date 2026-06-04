import type { BrainConfig } from "./config.js";
import { getBrainConfig } from "./config.js";

export type WikiSearchRequest = {
  query: string;
  maxResults?: number;
};

export type WikiSearchResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

export async function searchOsrsWiki(request: WikiSearchRequest, config: BrainConfig = getBrainConfig()): Promise<WikiSearchResult[]> {
  if (!config.tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is required before the Brain can search the live OSRS Wiki.");
  }

  const tavily = await import("tavily");
  const createClient = (tavily as Record<string, unknown>).tavily ?? (tavily as Record<string, unknown>).default;

  if (typeof createClient !== "function") {
    throw new Error("The installed tavily package did not expose the expected client factory.");
  }

  const client = createClient({ apiKey: config.tavilyApiKey }) as {
    search: (query: string, options?: Record<string, unknown>) => Promise<{ results?: WikiSearchResult[] }>;
  };

  const response = await client.search(`site:oldschool.runescape.wiki ${request.query}`, {
    maxResults: request.maxResults ?? 5,
    searchDepth: "basic"
  });

  return response.results ?? [];
}
