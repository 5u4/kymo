export const shellArg = (arg: string) =>
  /^[\w./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

export const kymoCommand = (root: string | undefined, command: string) =>
  [root === undefined ? "kymo" : `kymo --root ${shellArg(root)}`, command]
    .filter((part) => part.length > 0)
    .join(" ");

export const completeCommand = (id: string, deferred: string) =>
  `complete ${deferred.startsWith("-") ? "-- " : ""}${id} ${shellArg(deferred)} <json>`;
