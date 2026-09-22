import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../paths.js";

test("a state path that starts with ~ lands in the home directory, not in a folder named ~", () => {
  assert.equal(expandHome("~/.monitor-protocol/state.json"), join(homedir(), ".monitor-protocol/state.json"));
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("/tmp/state.json"), "/tmp/state.json");
  assert.equal(expandHome("state.json"), "state.json");
  assert.equal(expandHome("a/~/b"), "a/~/b", "only a leading ~ means home");
  assert.equal(expandHome("~other/state.json"), "~other/state.json", "~user forms are left alone");
});
