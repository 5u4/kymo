import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

export interface KymoRoot {
  readonly root: string;
  readonly config: string;
  readonly db: string;
  readonly daemon: string;
  readonly log: string;
  readonly owner: string;
}

export const make = (root: string): KymoRoot => ({
  root,
  config: `${root}/kymo.json`,
  db: `${root}/kymo.db`,
  daemon: `${root}/daemon.json`,
  log: `${root}/daemon.log`,
  owner: `${root}/owner`,
});

export const defaultRoot = Config.NonEmptyString("HOME").pipe(
  Config.map((home) => `${home}/.kymo`),
);

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

export const RootConfig = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })),
  workflows: Schema.Array(Schema.NonEmptyString),
});
export type RootConfig = typeof RootConfig.Type;

export const defaultConfig: RootConfig = { port: 4419, workflows: [] };

export const DaemonFile = Schema.Struct({
  pid: Schema.Int,
  port: Port,
});
export type DaemonFile = typeof DaemonFile.Type;
