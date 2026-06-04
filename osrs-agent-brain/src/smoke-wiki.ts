import { getBrainConfig } from "./config.js";
import { draftStrategistPolicy } from "./strategist.js";

const config = {
  ...getBrainConfig(),
  tavilyApiKey: undefined,
};

const draft = await draftStrategistPolicy({
  goal: `complete draynor saylor quest wiki smoke ${Date.now()}`,
  live: false,
  useQwen: false,
  wikiSearch: "force",
}, config);

const wikiSearch = draft.context.wikiSearch as { status?: string; reason?: string };
if (wikiSearch.status !== "WIKI_SEARCH_UNCONFIGURED") {
  console.error(JSON.stringify({
    status: "FAIL",
    reason: "EXPECTED_UNCONFIGURED_WIKI_STATUS",
    wikiSearch,
  }, null, 2));
  process.exit(1);
}

if (typeof draft.policy === "string") {
  console.error(JSON.stringify({ status: "FAIL", reason: "EXPECTED_STRUCTURED_LOCAL_POLICY" }, null, 2));
  process.exit(1);
}

if (!draft.policy.assumptions.some((assumption) => assumption.includes("Wiki search status"))) {
  console.error(JSON.stringify({
    status: "FAIL",
    reason: "POLICY_DID_NOT_RECORD_WIKI_STATUS",
    assumptions: draft.policy.assumptions,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASS",
  wikiSearchStatus: wikiSearch.status,
  source: draft.source,
  policyTask: draft.policy.system1Policy.task,
}, null, 2));
