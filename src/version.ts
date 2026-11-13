import pkg from "../package.json" with { type: "json" };

/** Server version, embedded at build time from package.json. */
export const VERSION: string = pkg.version;

export const SERVER_NAME = "imsg-mcp";
