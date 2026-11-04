export const shellArg = (arg: string) =>
  /^[\w./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

export const completeCommand = (id: string, deferred: string) =>
  `complete ${deferred.startsWith("-") ? "-- " : ""}${id} ${shellArg(deferred)} <json>`;
