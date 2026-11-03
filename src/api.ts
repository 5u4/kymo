import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

export const hostname = "127.0.0.1";

export const url = (port: number) => `http://${hostname}:${port}`;

export const Health = Schema.Struct({
  pid: Schema.Int,
  root: Schema.String,
});
export type Health = typeof Health.Type;

export class Api extends HttpApi.make("kymo").add(
  HttpApiGroup.make("daemon", { topLevel: true }).add(
    HttpApiEndpoint.get("health", "/api/health", { success: Health }),
  ),
) {}
