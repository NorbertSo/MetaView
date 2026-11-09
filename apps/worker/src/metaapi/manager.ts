import MetaApiModule from "metaapi.cloud-sdk/esm-node";
import type { Ctx } from "../context.js";
import { getSecret, MissingSecretError } from "../secrets.js";

// The SDK exports a default class; typings are loose, so we keep a narrow local surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const MetaApi: Any = (MetaApiModule as Any).default ?? MetaApiModule;

export interface Position {
  id: string; type: "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL"; symbol: string; magic: number; time: Date;
  openPrice: number; currentPrice: number; stopLoss?: number; takeProfit?: number; volume: number;
  swap: number; profit: number; unrealizedProfit: number; realizedProfit: number; commission: number; clientId?: string;
}
export interface Deal {
  id: string; type: string; entryType: string; symbol?: string; magic?: number; time: Date; volume?: number; price?: number;
  commission?: number; swap?: number; profit: number; positionId?: string; orderId?: string; clientId?: string; reason?: string;
}
export interface SymbolPrice { symbol: string; bid: number; ask: number; profitTickValue: number; lossTickValue: number; time: Date }
export interface AccountInfo {
  platform: string; broker: string; currency: string; server: string; balance: number; equity: number; margin: number;
  freeMargin: number; leverage: number; marginLevel: number; tradeAllowed: boolean; marginMode: string; login: number; type: string;
}
export interface SymbolSpecification {
  symbol: string; tickSize: number; minVolume: number; maxVolume: number; volumeStep: number; fillingModes: string[];
  contractSize: number; tradeMode?: string; baseCurrency: string; profitCurrency?: string; marginCurrency: string;
  swapLong?: number; swapShort?: number; digits: number; point: number; description: string; stopsLevel: number;
  path?: string; tradeSessions?: unknown;
}
export interface TradeResponse { numericCode: number; stringCode: string; message: string; orderId: string; positionId: string }
export interface Candle { time: Date; open: number; high: number; low: number; close: number; tickVolume: number }

export interface TradeOptions { clientId: string; magic: number; comment?: string; slippage?: number }

/** Codes MetaApi returns for a successful trade request. */
const OK_CODES = new Set(["TRADE_RETCODE_DONE", "TRADE_RETCODE_DONE_PARTIAL", "TRADE_RETCODE_PLACED", "TRADE_RETCODE_NO_CHANGES"]);

export class TradeRejected extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

/**
 * One MetaApi client per process; one RPC connection per account, created lazily
 * and re-created on failure. All broker access goes through this class.
 */
export class MetaApiManager {
  private api: Any | null = null;
  private apiToken: string | null = null;
  private conns = new Map<string, { account: Any; conn: Any }>();

  constructor(private ctx: Ctx) {}

  async configured(): Promise<boolean> {
    try { await this.client(); return true; } catch (e) { if (e instanceof MissingSecretError) return false; throw e; }
  }

  private async client(): Promise<Any> {
    const token = await getSecret(this.ctx, "metaapi_token");
    if (!this.api || token !== this.apiToken) {
      this.closeAll();
      this.api = new MetaApi(token, { requestTimeout: this.ctx.config.METAAPI_REQUEST_TIMEOUT_S });
      this.apiToken = token;
    }
    return this.api;
  }

  async getAccount(metaapiAccountId: string): Promise<Any> {
    return (await this.client()).metatraderAccountApi.getAccount(metaapiAccountId);
  }

  async createAccount(input: { name: string; login: string; password: string; server: string; platform: "mt4" | "mt5" }): Promise<{ id: string }> {
    const api = await this.client();
    const account = await api.metatraderAccountApi.createAccount({
      name: input.name,
      type: "cloud-g2",
      login: input.login,
      password: input.password,
      server: input.server,
      platform: input.platform,
      magic: 0,
      application: "MetaApi",
      manualTrades: false,
      reliability: "regular",
      quoteStreamingIntervalInSeconds: 2.5,
      tags: ["trading-v5v"],
    });
    return { id: account.id as string };
  }

  /** Returns a synchronized RPC connection for an account. */
  async rpc(metaapiAccountId: string): Promise<Any> {
    const cached = this.conns.get(metaapiAccountId);
    if (cached) return cached.conn;
    const account = await this.getAccount(metaapiAccountId);
    if (account.state !== "DEPLOYED") throw new Error(`MetaApi account ${metaapiAccountId} is ${account.state}, not DEPLOYED`);
    const conn = account.getRPCConnection();
    await conn.connect();
    await conn.waitSynchronized(120);
    this.conns.set(metaapiAccountId, { account, conn });
    return conn;
  }

  /** Drops a cached connection so the next call reconnects. */
  invalidate(metaapiAccountId: string): void {
    const c = this.conns.get(metaapiAccountId);
    if (c) { c.conn.close().catch(() => undefined); this.conns.delete(metaapiAccountId); }
  }

  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.invalidate(id);
  }

  private async withConn<T>(id: string, fn: (conn: Any) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.rpc(id));
    } catch (err) {
      if (err instanceof TradeRejected) throw err;
      this.invalidate(id);
      throw err;
    }
  }

  accountInformation(id: string): Promise<AccountInfo> { return this.withConn(id, (c) => c.getAccountInformation()); }
  async positions(id: string): Promise<Position[]> {
    const list: Position[] = await this.withConn(id, (c) => c.getPositions());
    return list.map((p) => ({ ...p, id: String(p.id) }));
  }
  async dealsByTimeRange(id: string, from: Date, to: Date): Promise<Deal[]> {
    const out: Deal[] = [];
    for (let offset = 0; ; offset += 1000) {
      const res: { deals: Deal[] } = await this.withConn(id, (c) => c.getDealsByTimeRange(from, to, offset, 1000));
      out.push(...res.deals.map((d) => ({ ...d, id: String(d.id), positionId: d.positionId !== undefined ? String(d.positionId) : undefined })));
      if (res.deals.length < 1000) break;
    }
    return out;
  }
  symbolPrice(id: string, symbol: string): Promise<SymbolPrice> { return this.withConn(id, (c) => c.getSymbolPrice(symbol, false)); }
  symbolSpecification(id: string, symbol: string): Promise<SymbolSpecification> { return this.withConn(id, (c) => c.getSymbolSpecification(symbol)); }
  symbols(id: string): Promise<string[]> { return this.withConn(id, (c) => c.getSymbols()); }
  serverTime(id: string): Promise<{ time: Date }> { return this.withConn(id, (c) => c.getServerTime()); }

  async candles(metaapiAccountId: string, symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    const account = await this.getAccount(metaapiAccountId);
    const list: Candle[] = await account.getHistoricalCandles(symbol, timeframe, undefined, limit);
    return list;
  }
  async candlesFrom(metaapiAccountId: string, symbol: string, timeframe: string, startTime: Date, limit: number): Promise<Candle[]> {
    const account = await this.getAccount(metaapiAccountId);
    return account.getHistoricalCandles(symbol, timeframe, startTime, limit);
  }

  private check(res: TradeResponse): TradeResponse {
    if (!OK_CODES.has(res.stringCode)) throw new TradeRejected(res.stringCode, res.message);
    return res;
  }

  async marketOrder(id: string, side: "buy" | "sell", symbol: string, volume: number, sl: number, tp: number | null, o: TradeOptions): Promise<TradeResponse> {
    return this.withConn(id, async (c) => {
      try {
        const res: TradeResponse = side === "buy"
          ? await c.createMarketBuyOrder(symbol, volume, sl, tp ?? undefined, { clientId: o.clientId, magic: o.magic })
          : await c.createMarketSellOrder(symbol, volume, sl, tp ?? undefined, { clientId: o.clientId, magic: o.magic });
        return this.check(res);
      } catch (e) { throw normalizeTradeError(e); }
    });
  }

  async modifyPosition(id: string, positionId: string, sl: number | undefined, tp: number | undefined): Promise<TradeResponse> {
    return this.withConn(id, async (c) => {
      try { return this.check(await c.modifyPosition(positionId, sl, tp)); } catch (e) { throw normalizeTradeError(e); }
    });
  }

  async closePosition(id: string, positionId: string, o: TradeOptions): Promise<TradeResponse> {
    return this.withConn(id, async (c) => {
      try { return this.check(await c.closePosition(positionId, { clientId: o.clientId, magic: o.magic })); } catch (e) { throw normalizeTradeError(e); }
    });
  }

  async closePositionPartially(id: string, positionId: string, volume: number, o: TradeOptions): Promise<TradeResponse> {
    return this.withConn(id, async (c) => {
      try { return this.check(await c.closePositionPartially(positionId, volume, { clientId: o.clientId, magic: o.magic })); } catch (e) { throw normalizeTradeError(e); }
    });
  }
}

/** MetaApi throws TradeError objects with stringCode for broker rejections. */
function normalizeTradeError(e: unknown): Error {
  const err = e as { stringCode?: string; message?: string; name?: string };
  if (err && typeof err === "object" && err.stringCode) return new TradeRejected(err.stringCode, err.message ?? "rejected");
  return e instanceof Error ? e : new Error(String(e));
}
