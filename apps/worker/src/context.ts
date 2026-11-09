import type { KeyObject } from "node:crypto";
import type { Logger } from "pino";
import type { Sql } from "@tv/db";
import type { Config } from "./config.js";

/** Shared runtime dependencies passed to every module. */
export interface Ctx {
  sql: Sql;
  log: Logger;
  config: Config;
  privateKey: KeyObject;
  /** Set when shutdown starts; long loops must check it. */
  stopping: { value: boolean };
}
