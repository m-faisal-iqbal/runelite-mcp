import { tavily } from "@tavily/core";
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

  const client = tavily({ apiKey: config.tavilyApiKey });
  const response = await client.search(`site:oldschool.runescape.wiki ${request.query}`, {
    maxResults: request.maxResults ?? 5,
    searchDepth: "basic",
  });

  return (response.results ?? []).map((result) => ({
    title: result.title,
    url: result.url,
    content: result.content,
    score: result.score,
  }));
}
