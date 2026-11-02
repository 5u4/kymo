import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import type * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Scope from "effect/Scope";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export type Await =
  | {
      readonly _tag: "Deferred";
      readonly executionId: string;
      readonly workflowName: string;
      readonly name: string;
      readonly since: DateTime.Utc;
      readonly deferred: DurableDeferred.DurableDeferred<Schema.Constraint, Schema.Constraint>;
    }
  | {
      readonly _tag: "Clock";
      readonly executionId: string;
      readonly workflowName: string;
      readonly name: string;
      readonly since: DateTime.Utc;
    };

type ByExecution = HashMap.HashMap<string, HashMap.HashMap<string, Await>>;

const clockPrefix = "DurableClock/";

export class Awaits extends Context.Service<
  Awaits,
  { readonly list: Effect.Effect<ReadonlyArray<Await>> }
>()("@kymo/daemon/Awaits") {
  static readonly layer: Layer.Layer<
    Awaits | WorkflowEngine.WorkflowEngine,
    never,
    WorkflowEngine.WorkflowEngine
  > = Layer.effectContext(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const ref = yield* Ref.make<ByExecution>(HashMap.empty());

      const record = (
        instance: WorkflowEngine.WorkflowInstance["Service"],
        deferred: DurableDeferred.DurableDeferred<Schema.Constraint, Schema.Constraint>,
      ) =>
        Effect.flatMap(DateTime.now, (since) =>
          Ref.update(ref, (byExecution) => {
            const waits = Option.getOrElse(HashMap.get(byExecution, instance.executionId), () =>
              HashMap.empty<string, Await>(),
            );
            if (HashMap.has(waits, deferred.name)) return byExecution;
            const base = {
              executionId: instance.executionId,
              workflowName: instance.workflow._tag,
              since,
            };
            const entry: Await = deferred.name.startsWith(clockPrefix)
              ? { _tag: "Clock", ...base, name: deferred.name.slice(clockPrefix.length) }
              : { _tag: "Deferred", ...base, name: deferred.name, deferred };
            return HashMap.set(
              byExecution,
              instance.executionId,
              HashMap.set(waits, deferred.name, entry),
            );
          }),
        );

      const deferredResult = <Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>,
      ) =>
        Effect.tap(engine.deferredResult(deferred), (result) =>
          Effect.flatMap(WorkflowEngine.WorkflowInstance, (instance) =>
            Option.isSome(result)
              ? Ref.update(ref, (byExecution) =>
                  Option.match(HashMap.get(byExecution, instance.executionId), {
                    onNone: () => byExecution,
                    onSome: (waits) => {
                      const rest = HashMap.remove(waits, deferred.name);
                      return HashMap.isEmpty(rest)
                        ? HashMap.remove(byExecution, instance.executionId)
                        : HashMap.set(byExecution, instance.executionId, rest);
                    },
                  }),
                )
              : instance.awaitedDeferreds.has(deferred.name)
                ? record(instance, deferred)
                : Effect.void,
          ),
        );

      const decorated = WorkflowEngine.WorkflowEngine.of({
        ...engine,
        register: (workflow, execute) =>
          engine.register(workflow, (payload, executionId) =>
            Effect.flatMap(WorkflowEngine.WorkflowInstance, (instance) => {
              const forgetUnlessAbandoned = Effect.suspend(() =>
                instance.abandoned ? Effect.void : Ref.update(ref, HashMap.remove(executionId)),
              );
              return Effect.andThen(
                Scope.addFinalizer(instance.scope, forgetUnlessAbandoned),
                execute(payload, executionId),
              );
            }),
          ),
        deferredResult,
      });

      const list = Effect.map(Ref.get(ref), (byExecution) =>
        Array.from(HashMap.values(byExecution)).flatMap((waits) =>
          Array.from(HashMap.values(waits)),
        ),
      );

      return Context.make(Awaits, Awaits.of({ list })).pipe(
        Context.add(WorkflowEngine.WorkflowEngine, decorated),
      );
    }),
  );
}
