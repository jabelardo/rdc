import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { qualifyPhase8aInputs } from "./qualify-phase8a.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("current MVP packaging inputs are safe and internally consistent", () => {
  const report = qualifyPhase8aInputs(root);

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.humanDecisions, ["final bundle identifier", "final application icon"]);
  assert.equal(report.productName, "RDC");
  assert.equal(report.version, "0.1.0");
  assert.equal(report.identifier, "org.rdc");
  assert.equal(report.finalPackagesProduced, false);
});
