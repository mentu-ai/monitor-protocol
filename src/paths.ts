import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading "~" to the home directory.
 *
 * A shell does this before the program sees the argument. An MCP client's JSON configuration does
 * not, so `--state ~/.monitor-protocol/state.json` written there reached the server literally and
 * created a folder named "~" in whatever directory the client started it from.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
