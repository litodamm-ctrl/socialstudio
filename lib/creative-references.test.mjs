import { test } from "node:test";
import assert from "node:assert/strict";
import { rotateReferences, validPublicationDate } from "./creative-references.ts";

test("daily material selection is deterministic for retries and rotates beyond the newest five", () => {
  const material = Array.from({ length: 100 }, (_, index) => index);
  const selection = rotateReferences(material, "brand:2026-10-02:Historia");
  assert.deepEqual(selection, rotateReferences(material, "brand:2026-10-02:Historia"));
  assert.equal(new Set(selection).size, 5);
  const used = new Set(Array.from({ length: 15 }, (_, day) => rotateReferences(material, `brand:2026-10-${day + 10}:Historia`)).flat());
  assert.ok(used.size > 5);
  assert.equal(material[0], 0);
  assert.deepEqual(rotateReferences([], "empty"), []);
  assert.equal(rotateReferences([1, 2], "small").length, 2);
});

test("publication dates reject impossible dates and non-date input", () => {
  assert.equal(validPublicationDate("2026-02-30"), false);
  assert.equal(validPublicationDate("2026-10-02"), true);
  assert.equal(validPublicationDate("2026-10-02T00:00:00Z"), false);
  assert.equal(validPublicationDate(null), false);
});
