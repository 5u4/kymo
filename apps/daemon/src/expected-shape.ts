import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

const codes = Option.liftThrowable(
  (schema: Schema.Constraint) =>
    SchemaRepresentation.toCodeDocument(
      SchemaRepresentation.toMultiDocument(Schema.toRepresentation(Schema.toCodecJson(schema))),
    ).codes,
);

export const expectedShape = (schema: Schema.Constraint): Option.Option<string> =>
  Option.flatMap(codes(schema), (codes) =>
    Option.map(Option.fromUndefinedOr(codes[0]), (code) => code.Type),
  );
