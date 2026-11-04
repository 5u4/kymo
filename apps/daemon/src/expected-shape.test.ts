import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expectedShape } from "./expected-shape.ts";

describe("expectedShape", () => {
  it("renders the JSON the operator types, not the decoded type", () => {
    assert.deepStrictEqual(
      expectedShape(
        Schema.Struct({
          at: Schema.DateTimeUtc,
          n: Schema.NumberFromString,
          o: Schema.optional(Schema.String),
        }),
      ),
      Option.some('{ readonly "at": string, readonly "n": string, readonly "o"?: string | null }'),
    );
  });

  it("has no shape for a schema it cannot render", () => {
    assert.deepStrictEqual(
      expectedShape(Schema.Struct({ url: Schema.declare((u): u is URL => u instanceof URL) })),
      Option.none(),
    );
  });
});
