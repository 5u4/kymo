import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { executeHint, labelToSend, parsePayload } from "./execute.ts";

describe("labelToSend", () => {
  it("omits a blank or whitespace-only label", () => {
    assert.strictEqual(labelToSend(""), undefined);
    assert.strictEqual(labelToSend("  \t\n"), undefined);
  });

  it("sends any other label exactly as typed", () => {
    assert.strictEqual(labelToSend("  nightly run "), "  nightly run ");
  });
});

describe("parsePayload", () => {
  it("parses JSON", () => {
    assert.deepStrictEqual(parsePayload(' { "a": [1, true] } '), Result.succeed({ a: [1, true] }));
  });

  it("fails on text that is not JSON", () => {
    assert.isTrue(Result.isFailure(parsePayload("{a: 1}")));
  });
});

describe("executeHint", () => {
  it("quotes the payload compactly and omits a blank label", () => {
    assert.strictEqual(
      executeHint(undefined, "Deploy", '{ "msg": "it\'s two words" }', " "),
      `kymo execute Deploy '{"msg":"it'\\''s two words"}'`,
    );
  });

  it("puts a label with an apostrophe before the positionals", () => {
    assert.strictEqual(
      executeHint(undefined, "Deploy", "{}", "Bob's run"),
      `kymo execute --label 'Bob'\\''s run' Deploy '{}'`,
    );
  });

  it("passes a label that starts with a dash inline so the parser takes it as the value", () => {
    assert.strictEqual(
      executeHint(undefined, "Deploy", "{}", "-x"),
      "kymo execute --label=-x Deploy '{}'",
    );
  });

  it("shows a placeholder while the payload is not JSON", () => {
    assert.strictEqual(executeHint(undefined, "Deploy", "{", ""), "kymo execute Deploy <payload>");
  });

  it("ends the options before a workflow or payload that starts with a dash", () => {
    assert.strictEqual(executeHint(undefined, "-odd", "{}", ""), "kymo execute -- -odd '{}'");
    assert.strictEqual(executeHint(undefined, "Count", " -1 ", ""), "kymo execute -- Count -1");
  });

  it("adds the daemon's root", () => {
    assert.strictEqual(
      executeHint("/tmp/my root", "Deploy", "1", "a"),
      "kymo --root '/tmp/my root' execute --label a Deploy 1",
    );
  });
});
