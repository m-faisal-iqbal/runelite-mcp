import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..");
const requestPath = path.join(repoRoot, "work", "os-control-request.json");

try {
  await rm(requestPath, { force: true });
  console.log(`Approved OS control by deleting ${requestPath}`);
} catch (error) {
  console.error(`Failed to approve OS control: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
