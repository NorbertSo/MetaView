import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, never>>;

export interface DbOptions {
  url: string;
  max?: number;
  applicationName: string;
}

/**
 * Creates a Postgres client bound to the `trading` schema.
 * Numeric columns are returned as strings by default; we parse them to numbers
 * because every monetary value we store fits safely in a double (18,2 / 20,10).
 */
export function createDb(opts: DbOptions): Sql {
  return postgres(opts.url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false, // compatible with Supabase pooler (transaction mode) as well as session mode
    connection: {
      application_name: opts.applicationName,
      search_path: "trading,public",
      TimeZone: "UTC",
    },
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number | string) => String(x),
        parse: (x: string) => Number(x),
      },
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint | string) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${x}`);
          return n;
        },
      },
    },
    onnotice: () => undefined,
  }) as unknown as Sql;
}
