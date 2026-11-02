import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

export interface KymoRoot {
  readonly root: string;
  readonly config: string;
  readonly db: string;
  readonly daemon: string;
}

export const make = (root: string): KymoRoot => ({
  root,
  config: `${root}/kymo.json`,
  db: `${root}/kymo.db`,
  daemon: `${root}/daemon.json`,
});

export const defaultRoot = Config.NonEmptyString("HOME").pipe(
  Config.map((home) => `${home}/.kymo`),
);

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

export const RootConfig = Schema.Struct({
  port: Port,
  plugins: Schema.Array(Schema.NonEmptyString),
});
export type RootConfig = typeof RootConfig.Type;

export const DaemonFile = Schema.Struct({
  pid: Schema.Int,
  port: Port,
});
export type DaemonFile = typeof DaemonFile.Type;
