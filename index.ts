import "dotenv/config";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import nodemailer from "nodemailer";
import QRCode from "qrcode";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

/** Reads a positive-number env var, falling back to `fallback` when unset/invalid. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parses a comma-separated list of positive integer Telegram user IDs. */
function parseIds(raw: string): Set<number> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

/** Parses a comma-separated list of non-empty strings. */
function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Currency IDs /topup will offer, in the configured order. DV.net identifies a
 * coin by "<CODE>.<Blockchain>", e.g. USDT.Tron, USDT.Ethereum, BTC.Bitcoin.
 *
 * "all" (or "*") clears the allowlist, meaning every currency the store has
 * enabled. A blank value cannot mean that: optional() treats blank as absent
 * and hands back the default, so the sentinel has to be explicit.
 */
function parseCurrencyAllowlist(raw: string): string[] {
  const ids = parseList(raw);
  return ids.length === 1 && (ids[0].toLowerCase() === "all" || ids[0] === "*") ? [] : ids;
}

/**
 * How /topup answers a repeat request:
 *   "reuse"  - the one wallet DV.net keeps per user (the default; the API is
 *              get-or-create on store_external_id, so this costs nothing)
 *   "unique" - a brand-new wallet, with brand-new addresses, every time
 */
function addressModeFrom(raw: string): "reuse" | "unique" {
  if (raw !== "reuse" && raw !== "unique") {
    throw new Error(`ADDRESS_MODE must be "reuse" or "unique", got "${raw}"`);
  }
  return raw;
}

/**
 * Which transaction directions trigger a notification:
 *   "in" = deposit, "out" = withdrawal. Defaults to both.
 */
function parseDirections(raw: string): Set<"in" | "out"> {
  const set = new Set<"in" | "out">();
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (part === "in" || part === "out") set.add(part);
  }
  if (set.size === 0) {
    set.add("in");
    set.add("out");
  }
  return set;
}

/**
 * Email/SMTP settings for transaction notifications. Returns null (email
 * disabled) unless at least SMTP_HOST and MAIL_TO are provided.
 */
function mailConfigFrom() {
  const host = optional("SMTP_HOST", "");
  const to = optional("MAIL_TO", "");
  if (!host || !to) return null;
  const user = optional("SMTP_USER", "");
  return {
    host,
    port: envNumber("SMTP_PORT", 587),
    secure: optional("SMTP_SECURE", "false") === "true",
    user,
    pass: optional("SMTP_PASS", ""),
    from: optional("MAIL_FROM", user),
    to,
  };
}

const config = {
  botToken: required("BOT_TOKEN"),
  logLevel: optional("LOG_LEVEL", "info"),
  adminIds: parseIds(optional("ADMIN_IDS", "")),
  api: {
    // Host only. The /api/v1/external prefix is added by apiRequest(). On the
    // DV.net cloud this is https://cloud.dv.net (the API key identifies the
    // store); for a self-hosted install it is the domain dv-merchant is served
    // from. Unrouted *.dv.net names land on a Traefik catch-all that answers
    // every path with a self-signed cert and "404 page not found".
    host: required("DVNET_HOST").replace(/\/+$/, ""),
    // "API key" from the project's advanced settings, sent as x-api-key.
    apiKey: required("DVNET_API_KEY"),
  },
  deposit: {
    // Currency IDs this bot will hand out addresses for, in menu order. One
    // entry (the default: USDT on TRON only) means there is nothing to choose,
    // so /topup skips the currency menu entirely. Several entries bring the
    // menu back, and "all" offers everything the store has enabled.
    currencies: parseCurrencyAllowlist(optional("DEPOSIT_CURRENCIES", "USDT.Tron")),
    // How many currency buttons /topup may show at once.
    menuLimit: envNumber("DEPOSIT_MENU_LIMIT", 10),
    // "reuse" = the same wallet on every /topup; "unique" = a new one each time.
    addressMode: addressModeFrom(optional("ADDRESS_MODE", "reuse")),
  },
  pay: {
    // /pay <amount> - a hosted DV.net checkout page for a fixed USD amount.
    enabled: optional("PAY_ENABLED", "true") === "true",
    minAmount: envNumber("PAY_MIN_AMOUNT", 1),
    // Optional currency ID to preselect on the checkout page (blank = payer picks).
    currency: optional("PAY_CURRENCY", ""),
  },
  rateLimit: {
    max: envNumber("RATE_LIMIT_MAX", 20),
    windowMs: envNumber("RATE_LIMIT_WINDOW_SECONDS", 60) * 1000,
  },
  webhook: {
    port: envNumber("WEBHOOK_PORT", 8090),
    // DV.net POSTs payment events here. Put a hard-to-guess secret in the path
    // too (e.g. /dvnet/webhook/9f3a...) - the signature is the real auth, the
    // path just keeps scanners from finding the endpoint.
    path: optional("WEBHOOK_PATH", "/dvnet/webhook").replace(/\/+$/, "") || "/",
    // "Secret" from the project's advanced settings. DV.net signs every webhook
    // with it (X-Sign = sha256(body + secret)); without it the receiver cannot
    // tell a real payment event from a forged one, so it stays switched off.
    secret: optional("DVNET_WEBHOOK_SECRET", ""),
  },
  notify: {
    directions: parseDirections(optional("NOTIFY_DIRECTIONS", "in,out")),
    // Tell the depositor as soon as the payment is seen in the mempool, not
    // only once it has confirmed.
    unconfirmed: optional("NOTIFY_UNCONFIRMED", "true") === "true",
    // Send every event to the ADMIN_IDS on Telegram as well as by email.
    admins: optional("NOTIFY_ADMINS", "true") === "true",
  },
  mail: mailConfigFrom(),
} as const;

/**
 * The one currency ID to issue, when DEPOSIT_CURRENCIES names exactly one. This
 * is what turns /topup from "pick a currency" into "here is your address":
 * with a single currency there is no choice to offer, and no reason to call
 * /store/currencies before answering.
 */
const pinnedCurrency: string | undefined =
  config.deposit.currencies.length === 1 ? config.deposit.currencies[0] : undefined;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type Level = "debug" | "info" | "warn" | "error";
const levelOrder: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levelOrder[config.logLevel as Level] ?? levelOrder.info;

function log(level: Level, message: string, ...args: unknown[]): void {
  if (levelOrder[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

const logger = {
  debug: (m: string, ...a: unknown[]) => log("debug", m, ...a),
  info: (m: string, ...a: unknown[]) => log("info", m, ...a),
  warn: (m: string, ...a: unknown[]) => log("warn", m, ...a),
  error: (m: string, ...a: unknown[]) => log("error", m, ...a),
};

// ---------------------------------------------------------------------------
// DV.net external API client (x-api-key)
//
// Paths, header and envelope match the official @dv.net/js-client SDK; this is
// hand-rolled on fetch so the bot has no runtime dependency beyond grammY.
// ---------------------------------------------------------------------------

const API_PREFIX = "/api/v1/external";
const API_TIMEOUT_MS = 30_000;

/** One address inside a wallet. The wallet holds one per enabled currency. */
interface WalletAddress {
  id: string;
  wallet_id: string;
  user_id: string;
  currency_id: string;
  blockchain: string;
  address: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  dirty?: boolean;
}

/** POST /wallet response: the user's wallet plus every deposit address in it. */
interface Wallet {
  id: string;
  created_at: string;
  updated_at: string;
  pay_url: string;
  store_id: string;
  store_external_id: string;
  amount_usd: string;
  address: WalletAddress[];
  rates: Record<string, string>;
}

/** GET /store/currencies entry. */
interface Currency {
  id: string;
  code: string;
  name: string;
  blockchain: string;
  contract_address?: string;
  status?: boolean;
  is_fiat?: boolean;
  min_confirmation?: number;
  precision?: number;
  explorer_link?: string;
}

/** GET /wallet/balance/hot entry: one line per currency across all wallets. */
interface HotWalletAccount {
  balance: string;
  balance_usd: string;
  count: number;
  count_with_balance: number;
  currency: { id: string; code: string; name: string; blockchain: string };
}

/** GET /exchange-balances response. */
interface ExchangeBalances {
  total_usd: string;
  balances: { amount: string; amount_usd: string; currency: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Errors arrive as {"errors":[{"message":"...","field":"..."}],"code":422}.
 * Other shapes are still accepted as a fallback rather than losing the reason
 * for a failure entirely.
 */
export function extractApiError(parsed: unknown, raw: string, status: number): { message: string; field?: string } {
  if (isRecord(parsed)) {
    if (Array.isArray(parsed["errors"])) {
      const entries = parsed["errors"].filter(isRecord);
      const messages = entries.map((e) => e["message"]).filter((m): m is string => typeof m === "string");
      const field = entries.map((e) => e["field"]).find((f): f is string => typeof f === "string");
      if (messages.length > 0) return { message: messages.join("; "), field };
    }
    if (typeof parsed["message"] === "string" && parsed["message"]) return { message: parsed["message"] };
  }
  return { message: raw.slice(0, 300) || `HTTP ${status}` };
}

/**
 * One API call. Every endpoint shares the same header auth and the same
 * {"code":200,"data":...,"message":""} envelope, so transport and error
 * handling live here and callers get `data` back.
 */
async function apiRequest<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
  const url = `${config.api.host}${API_PREFIX}${endpoint}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-api-key": config.api.apiKey,
  };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (err) {
    logger.error(`API ${method} ${endpoint} failed (network error):`, err);
    throw new Error("Failed to reach the payment provider");
  }

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }

  if (!res.ok) {
    const { message, field } = extractApiError(parsed, raw, res.status);
    logger.error(`API ${method} ${endpoint} -> ${res.status}${field ? ` [${field}]` : ""}: ${message}`);
    if (res.status === 401 || res.status === 403) {
      logger.error("DV.net rejected the API key. Check DVNET_API_KEY and that DVNET_HOST is your own store's host.");
    }
    throw new ApiError(message, res.status, field);
  }

  if (!isRecord(parsed) || !("data" in parsed)) {
    logger.error(`API ${method} ${endpoint} returned an unexpected body: ${raw.slice(0, 300)}`);
    throw new Error("Unexpected response from the payment provider");
  }
  return parsed["data"] as T;
}

/** GET /store/currencies - every currency the store knows, enabled or not. */
const getStoreCurrencies = (): Promise<Currency[]> => apiRequest<Currency[]>("GET", "/store/currencies");

/** GET /wallet/balance/hot - funds sitting on issued deposit addresses. */
const getHotWalletBalances = (): Promise<HotWalletAccount[]> =>
  apiRequest<HotWalletAccount[]>("GET", "/wallet/balance/hot");

/** GET /exchange-balances - funds on the connected exchange, if any. */
const getExchangeBalances = (): Promise<ExchangeBalances> =>
  apiRequest<ExchangeBalances>("GET", "/exchange-balances");

interface CreateWalletParams {
  storeExternalId: string;
  /** USD. Pre-fills the checkout page; the store minimum is used when omitted. */
  amount?: number;
  /** Currency ID to preselect on the checkout page. */
  currency?: string;
  /** Language for the checkout page, e.g. "en". */
  locale?: string;
}

/**
 * POST /wallet. `store_external_id` is the whole trick: DV.net is get-or-create
 * on it, so one ID per user keeps returning that user's same wallet, and every
 * webhook carries it back so an incoming deposit can be traced to a Telegram
 * user. The response holds one address per currency the store has enabled,
 * plus a hosted checkout page (pay_url) showing them all with QR codes.
 */
async function createWallet(params: CreateWalletParams): Promise<Wallet> {
  const data = await apiRequest<Wallet>("POST", "/wallet", {
    store_external_id: params.storeExternalId,
    ...(params.amount !== undefined ? { amount: params.amount } : {}),
    ...(params.currency ? { currency: params.currency } : {}),
    ...(params.locale ? { locale: params.locale } : {}),
  });
  if (!data?.id || !Array.isArray(data.address)) {
    logger.error("POST /wallet returned no wallet:", data);
    throw new Error("Provider returned no wallet");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Currency catalogue (GET /store/currencies, cached)
// ---------------------------------------------------------------------------

const CURRENCY_CACHE_MS = 5 * 60 * 1000;
let currencyCache: { at: number; currencies: Currency[] } | null = null;

/**
 * The currencies this bot will actually offer: what the store has enabled,
 * narrowed to DEPOSIT_CURRENCIES and kept in that configured order so the menu
 * order is deliberate rather than whatever the provider happens to return.
 */
async function offeredCurrencies(): Promise<Currency[]> {
  if (currencyCache && Date.now() - currencyCache.at < CURRENCY_CACHE_MS) return currencyCache.currencies;
  const all = await getStoreCurrencies();
  const usable = all.filter((c) => c.status !== false && c.is_fiat !== true);

  const allow = config.deposit.currencies;
  let currencies = usable;
  if (allow.length > 0) {
    currencies = allow
      .map((id) => usable.find((c) => c.id.toLowerCase() === id.toLowerCase()))
      .filter((c): c is Currency => c !== undefined);
    const missing = allow.filter((id) => !usable.some((c) => c.id.toLowerCase() === id.toLowerCase()));
    if (missing.length > 0) {
      logger.warn(
        `DEPOSIT_CURRENCIES entries not enabled on this store: ${missing.join(", ")}. ` +
          `Enabled: ${usable.map((c) => c.id).join(", ") || "none"}. Check the IDs (e.g. USDT.Tron) and the store settings.`,
      );
    }
  }

  currencyCache = { at: Date.now(), currencies };
  return currencies;
}

/** Resolves a currency ID against the offered list. IDs outside it are unknown. */
async function findCurrency(id: string): Promise<Currency | undefined> {
  const wanted = id.trim().toLowerCase();
  return (await offeredCurrencies()).find((c) => c.id.toLowerCase() === wanted);
}

/**
 * Currency details only prettify the message (name, confirmations), so a
 * failed lookup must never stand between a user and their address when the
 * ID to issue is already known.
 */
async function findCurrencyQuietly(id: string): Promise<Currency | undefined> {
  try {
    return await findCurrency(id);
  } catch (err) {
    logger.warn(`Could not load details for currency ${id}, issuing the address anyway:`, err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Friendly names for the blockchains DV.net supports, keyed by the lowercase
 * blockchain slug that appears in currency IDs and webhooks. `chain` names the
 * network for its native coin, `token` the standard for tokens on it.
 */
const NETWORKS: Record<string, { chain: string; token: string; native: string }> = {
  tron: { chain: "TRON", token: "TRC-20", native: "TRX" },
  ethereum: { chain: "Ethereum", token: "ERC-20", native: "ETH" },
  // Currency IDs say "BNBSmartChain" but the API's blockchain slug is "bsc".
  bnbsmartchain: { chain: "BNB Smart Chain", token: "BEP-20", native: "BNB" },
  bsc: { chain: "BNB Smart Chain", token: "BEP-20", native: "BNB" },
  polygon: { chain: "Polygon", token: "Polygon", native: "POL" },
  arbitrum: { chain: "Arbitrum", token: "Arbitrum", native: "ETH" },
  optimism: { chain: "Optimism", token: "Optimism", native: "ETH" },
  linea: { chain: "Linea", token: "Linea", native: "ETH" },
  bitcoin: { chain: "Bitcoin", token: "Bitcoin", native: "BTC" },
  bitcoincash: { chain: "Bitcoin Cash", token: "Bitcoin Cash", native: "BCH" },
  litecoin: { chain: "Litecoin", token: "Litecoin", native: "LTC" },
  dogecoin: { chain: "Dogecoin", token: "Dogecoin", native: "DOGE" },
  solana: { chain: "Solana", token: "Solana (SPL)", native: "SOL" },
  monero: { chain: "Monero", token: "Monero", native: "XMR" },
  ton: { chain: "TON", token: "TON (Jetton)", native: "TON" },
};

/** The bits of a currency the labels need. Parsed from the ID when the API is unavailable. */
interface CurrencyLike {
  id: string;
  code: string;
  blockchain: string;
}

/** "USDT.Tron" -> { code: "USDT", blockchain: "Tron" }. */
export function currencyFromId(id: string): CurrencyLike {
  const [code = id, blockchain = ""] = id.split(".");
  return { id, code: code.toUpperCase(), blockchain };
}

/** "TRC-20" for USDT.Tron, "TRON" for TRX.Tron, "Bitcoin" for BTC.Bitcoin. */
export function networkLabel(c: CurrencyLike): string {
  const net = NETWORKS[c.blockchain.toLowerCase()];
  if (!net) return c.blockchain || "unknown network";
  return c.code.toUpperCase() === net.native ? net.chain : net.token;
}

/** "USDT (TRC-20)", "BTC (Bitcoin)". */
export function currencyLabel(c: CurrencyLike): string {
  return `${c.code.toUpperCase()} (${networkLabel(c)})`;
}

/** Strips trailing zeros from the decimal strings DV.net sends ("25.500000" -> "25.5"). */
export function fmtAmount(value: string | number | undefined): string {
  if (value === undefined || value === null) return "?";
  const s = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Short, human-quotable form of a DV.net UUID, used as the invoice number. */
const shortId = (uuid: string): string => uuid.replace(/-/g, "").slice(0, 8).toUpperCase();

/**
 * The welcome text follows DEPOSIT_CURRENCIES: with one currency there is no
 * menu to explain, so it promises an address rather than a choice.
 */
export function renderWelcome(firstName?: string): string {
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  const single = pinnedCurrency !== undefined;
  const reusing = config.deposit.addressMode === "reuse";

  const usage = single
    ? [`<code>/topup</code> - get ${reusing ? "your" : "a new"} deposit address`]
    : [
        `<code>/topup</code> - pick a currency and get ${reusing ? "your" : "a new"} deposit address`,
        "<code>/topup USDT.Tron</code> - skip the menu, go straight to a currency",
        "<code>/methods</code> - list every currency I can accept",
      ];
  if (config.pay.enabled) {
    usage.push(`<code>/pay &lt;amount&gt;</code> - get a checkout link for a fixed USD amount, e.g. <code>/pay 25</code>`);
  }

  return [
    `<b>Welcome${name}</b>`,
    "",
    single
      ? `I generate crypto deposit addresses - no login required. Accepted method: <b>${escapeHtml(currencyLabel(currencyFromId(pinnedCurrency)))}</b>.`
      : "I generate crypto deposit addresses - no login required.",
    "",
    "<b>How to use</b>",
    ...usage,
    "",
    reusing
      ? `Your address is permanent${single ? "" : " per currency"}, so you can reuse it. You get a message here as soon as a deposit is detected and again when it is confirmed.`
      : "A fresh address is generated every time you run /topup, and older ones keep working. You get a message here as soon as a deposit is detected and again when it is confirmed.",
    "",
    "Type /help any time to see this again.",
  ].join("\n");
}

export function buildAddressMessage(currency: CurrencyLike & Partial<Currency>, entry: WalletAddress, wallet: Wallet): string {
  const code = currency.code.toUpperCase();
  const network = networkLabel(currency);
  const lines = [
    "<b>Your deposit address</b>",
    "",
    `<b>Asset:</b> ${escapeHtml(code)}`,
    `<b>Network:</b> ${escapeHtml(network)}`,
    `<b>Address:</b> <code>${escapeHtml(entry.address)}</code>`,
  ];

  const confirmations = currency.min_confirmation;
  if (confirmations) lines.push("", `<b>Confirmations:</b> ${confirmations}`);

  lines.push(
    "",
    `Send only <b>${escapeHtml(code)}</b> over <b>${escapeHtml(network)}</b> to this address. Anything else can be lost.`,
    config.deposit.addressMode === "reuse"
      ? "This address is yours to keep - reuse it for future deposits."
      : "A new address is generated each time you run /topup. Earlier addresses stay valid.",
    "",
    `Prefer a checkout page with a QR code? <a href="${escapeHtml(wallet.pay_url)}">Open the payment page</a>`,
  );
  return lines.join("\n");
}

export function buildInvoiceMessage(wallet: Wallet, amount: number): string {
  return [
    "<b>New invoice!</b>",
    "",
    `<b>Invoice ID:</b> ${escapeHtml(shortId(wallet.id))}`,
    `<b>Amount:</b> ${fmtAmount(amount)} USD`,
    `<b>Payment Link:</b> <a href="${escapeHtml(wallet.pay_url)}">${escapeHtml(wallet.pay_url)}</a>`,
    "",
    "Open the link, choose a currency and send the exact amount shown. You get a message here as soon as the payment is detected.",
  ].join("\n");
}

export function buildMethodsMessage(currencies: Currency[]): string {
  if (currencies.length === 0) return "No deposit currencies are currently enabled for this store.";
  const rows = currencies.map((c) => {
    const conf = c.min_confirmation ? `, ${c.min_confirmation} conf.` : "";
    return `<code>${escapeHtml(c.id)}</code> - ${escapeHtml(currencyLabel(c))}${escapeHtml(conf)}`;
  });
  return [
    "<b>Available deposit currencies</b>",
    "",
    ...rows,
    "",
    pinnedCurrency ? "Send <code>/topup</code> to get your address." : "Use <code>/topup ID</code> to get an address.",
  ].join("\n");
}

function buildBalanceMessage(hot: HotWalletAccount[], exchange: ExchangeBalances | null): string {
  const lines = ["<b>Deposit address balances</b>", ""];
  const funded = hot.filter((a) => Number(a.balance) > 0);
  if (funded.length === 0) {
    lines.push("All deposit addresses are empty.");
  } else {
    for (const a of funded) {
      lines.push(
        `<b>${escapeHtml(currencyLabel(a.currency))}:</b> ${fmtAmount(a.balance)} ` +
          `(≈ ${fmtAmount(a.balance_usd)} USD) on ${a.count_with_balance} of ${a.count} addresses`,
      );
    }
  }
  if (exchange) {
    lines.push("", "<b>Exchange balances</b>", "");
    const held = exchange.balances.filter((b) => Number(b.amount) > 0);
    if (held.length === 0) lines.push("Nothing on the exchange.");
    for (const b of held) {
      lines.push(`<b>${escapeHtml(b.currency)}:</b> ${fmtAmount(b.amount)} (≈ ${fmtAmount(b.amount_usd)} USD)`);
    }
    lines.push("", `<b>Exchange total:</b> ${fmtAmount(exchange.total_usd)} USD`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

// The bot is always on once started. An admin can pause it with /stop and
// resume it with /start. Pausing only gates request handling, it does NOT
// stop the process.
let isPaused = false;
const isAdmin = (userId?: number): boolean => !!userId && config.adminIds.has(userId);
const PAUSED_MESSAGE = "The bot is currently paused. Please try again later.";

// ── Rate Limiting ───────────────────────────────────────────
interface RateEntry {
  count: number;
  windowStart: number;
}
const rateLimitMap = new Map<number, RateEntry>();

function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now - entry.windowStart > config.rateLimit.windowMs) {
    // First request or window has expired -> reset
    rateLimitMap.set(userId, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= config.rateLimit.max) return true;

  entry.count++;
  return false;
}

// Clean up old entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rateLimitMap) {
    if (now - entry.windowStart > config.rateLimit.windowMs) rateLimitMap.delete(id);
  }
}, 5 * 60_000).unref();
// ── End Rate Limiting ───────────────────────────────────────

/**
 * store_external_id formats. Every one starts with "tg-<userId>" so a webhook
 * can be traced back to the Telegram user whatever else follows:
 *   tg-<userId>                  the user's permanent wallet ("reuse" mode)
 *   tg-<userId>-<ts>-<seq>       a fresh wallet per /topup ("unique" mode)
 *   tg-<userId>-pay-<hex>        a fresh wallet per /pay invoice
 */
const walletExternalId = (userId: number): string => `tg-${userId}`;

// The counter matters as much as the clock: two /topup calls in the same
// millisecond would otherwise collide and land on the same wallet.
let walletSeq = 0;
const uniqueWalletExternalId = (userId: number): string =>
  `tg-${userId}-${Date.now().toString(36)}-${(++walletSeq).toString(36)}`;

const invoiceExternalId = (userId: number): string => `tg-${userId}-pay-${randomBytes(4).toString("hex")}`;

export function parseExternalId(externalId?: string | null): { userId: number; kind: "deposit" | "invoice" } | null {
  const m = /^tg-(\d+)(?:-(pay)(?:-|$))?/.exec(externalId ?? "");
  if (!m) return null;
  const userId = Number(m[1]);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return { userId, kind: m[2] === "pay" ? "invoice" : "deposit" };
}

// One wallet request per external ID at a time, so double-tapping /topup in
// "reuse" mode cannot race two get-or-create calls at the provider.
const inFlight = new Map<string, Promise<Wallet>>();

function walletFor(externalId: string, params: Omit<CreateWalletParams, "storeExternalId"> = {}): Promise<Wallet> {
  const pending = inFlight.get(externalId);
  if (pending) return pending;
  const work = createWallet({ storeExternalId: externalId, ...params }).finally(() => inFlight.delete(externalId));
  inFlight.set(externalId, work);
  return work;
}

/** The wallet /topup should show: the user's permanent one, or a fresh one, per ADDRESS_MODE. */
function depositWalletFor(userId: number, locale?: string): Promise<Wallet> {
  const externalId =
    config.deposit.addressMode === "reuse" ? walletExternalId(userId) : uniqueWalletExternalId(userId);
  return walletFor(externalId, { locale });
}

// DV.net retries a webhook until it is acknowledged and may deliver the same
// event more than once, so every notification is keyed and shown once.
const seenEvents = new Set<string>();
const SEEN_EVENT_LIMIT = 5000;

function alreadyHandled(key: string): boolean {
  if (seenEvents.has(key)) return true;
  seenEvents.add(key);
  if (seenEvents.size > SEEN_EVENT_LIMIT) {
    // Oldest-first eviction; insertion order is enough to keep this bounded.
    const oldest = seenEvents.values().next();
    if (!oldest.done) seenEvents.delete(oldest.value);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commands & handlers
// ---------------------------------------------------------------------------

// /methods is still handled when a single currency is configured, it just has
// nothing to choose between, so it stays out of Telegram's command menu.
export const commandList = [
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show available commands" },
  {
    command: "topup",
    description: pinnedCurrency
      ? `Get your ${currencyLabel(currencyFromId(pinnedCurrency))} deposit address`
      : "Get a crypto deposit address",
  },
  ...(config.pay.enabled ? [{ command: "pay", description: "Get a checkout link for a USD amount" }] : []),
  ...(pinnedCurrency ? [] : [{ command: "methods", description: "List available deposit currencies" }]),
];

async function startCommand(ctx: Context): Promise<void> {
  if (isPaused) {
    if (isAdmin(ctx.from?.id)) {
      isPaused = false;
      logger.info(`Bot resumed by admin ${ctx.from?.id}`);
      await ctx.reply("Bot resumed. It is accepting requests again.");
      return;
    }
    await ctx.reply(PAUSED_MESSAGE);
    return;
  }
  await ctx.reply(renderWelcome(ctx.from?.first_name), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function stopCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is restricted to bot admins.");
    return;
  }
  if (isPaused) {
    await ctx.reply("The bot is already paused. Send /start to resume.");
    return;
  }
  isPaused = true;
  logger.info(`Bot paused by admin ${ctx.from?.id}`);
  await ctx.reply("Bot paused. Send /start to resume.");
}

async function helpCommand(ctx: Context): Promise<void> {
  await ctx.reply(renderWelcome(ctx.from?.first_name), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** Shared gate for the commands that hit the provider: paused? rate limited? who? */
async function admitRequest(ctx: Context): Promise<number | null> {
  if (isPaused) {
    await ctx.reply(PAUSED_MESSAGE);
    return null;
  }
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify your Telegram account.");
    return null;
  }
  if (isRateLimited(userId)) {
    await ctx.reply("You are sending too many requests.\nPlease wait a moment before trying again.");
    return null;
  }
  return userId;
}

/** Renders the address as a QR code, best-effort - the text address is the real payload. */
async function trySendQr(ctx: Context, address: string, caption: string): Promise<void> {
  try {
    const png = await QRCode.toBuffer(address, {
      type: "png",
      width: 512,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    await ctx.replyWithPhoto(new InputFile(png, "deposit-address.png"), { caption });
  } catch (err) {
    logger.warn("Failed to send QR image:", err);
  }
}

/** Inline keyboard of offered currencies, one per row so long names stay readable. */
function currencyKeyboard(currencies: Currency[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const c of currencies.slice(0, config.deposit.menuLimit)) {
    keyboard.text(currencyLabel(c), `dep:${c.id}`).row();
  }
  return keyboard;
}

/**
 * Issues (or re-issues) the deposit address for one currency and replies with
 * it. Shared by /topup and the currency buttons.
 */
export async function sendDepositAddress(
  ctx: Context,
  userId: number,
  currency: Currency | undefined,
  fallbackId?: string,
): Promise<void> {
  const currencyId = currency?.id ?? fallbackId ?? "";
  const meta: CurrencyLike & Partial<Currency> = currency ?? currencyFromId(currencyId);

  await ctx.replyWithChatAction("typing");
  const wallet = await depositWalletFor(userId, ctx.from?.language_code);

  // The wallet carries one address per enabled currency; pick the one asked for.
  const entry = wallet.address.find((a) => a.currency_id.toLowerCase() === currencyId.toLowerCase());
  if (!entry) {
    logger.error(
      `Wallet ${wallet.id} has no ${currencyId} address. The store offers: ` +
        `${wallet.address.map((a) => a.currency_id).join(", ") || "nothing"}. Enable it in the DV.net store settings.`,
    );
    await ctx.reply(
      `<b>${escapeHtml(currencyLabel(meta))}</b> is not enabled on this store right now. ` +
        (pinnedCurrency ? "Please try again later." : "Send /methods to see what is available."),
      { parse_mode: "HTML" },
    );
    return;
  }

  logger.info(`Issued ${entry.currency_id} address ${entry.address} to user ${userId} (${wallet.store_external_id}).`);
  await ctx.reply(buildAddressMessage(meta, entry, wallet), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  await trySendQr(ctx, entry.address, `${currencyLabel(meta)}: ${entry.address}`);
}

/**
 * /topup - with a currency ID, issues that address directly; without one,
 * offers the enabled currencies as buttons (or skips the menu when the bot
 * only has the single configured currency).
 */
async function topupCommand(ctx: Context): Promise<void> {
  const userId = await admitRequest(ctx);
  if (!userId) return;

  const requested = (ctx.match ?? "").toString().trim();
  try {
    if (requested) {
      const currency = await findCurrency(requested);
      if (!currency) {
        await ctx.reply(
          `Unknown or disabled currency <code>${escapeHtml(requested)}</code>. Send /methods to see what is available.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      await sendDepositAddress(ctx, userId, currency);
      return;
    }

    // One configured currency means there is nothing to ask. Go straight to
    // the address, and don't let the catalogue lookup gate it - the ID to
    // issue is already known from DEPOSIT_CURRENCIES.
    if (pinnedCurrency) {
      await sendDepositAddress(ctx, userId, await findCurrencyQuietly(pinnedCurrency), pinnedCurrency);
      return;
    }

    const currencies = await offeredCurrencies();
    if (currencies.length === 0) {
      await ctx.reply("No deposit currencies are enabled for this store right now.");
      return;
    }
    if (currencies.length === 1) {
      await sendDepositAddress(ctx, userId, currencies[0]);
      return;
    }

    await ctx.reply("Choose the currency you want to deposit:", {
      reply_markup: currencyKeyboard(currencies),
    });
  } catch (err) {
    logger.error("/topup failed:", err);
    await ctx.reply("Could not generate a deposit address. Please try again later.");
  }
}

/** Handles the currency buttons produced by /topup. */
async function depositCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const id = data.startsWith("dep:") ? data.slice(4) : "";
  if (isPaused) {
    await ctx.answerCallbackQuery({ text: PAUSED_MESSAGE, show_alert: true });
    return;
  }
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (isRateLimited(userId)) {
    await ctx.answerCallbackQuery({ text: "Too many requests. Please wait a moment.", show_alert: true });
    return;
  }

  try {
    await ctx.answerCallbackQuery();
    const currency = await findCurrency(id);
    if (!currency) {
      await ctx.reply("That currency is no longer available. Send /methods for the current list.");
      return;
    }
    await sendDepositAddress(ctx, userId, currency);
  } catch (err) {
    logger.error(`Deposit button (${id}) failed:`, err);
    await ctx.reply("Could not generate a deposit address. Please try again later.");
  }
}

/**
 * /pay <amount> - a hosted DV.net checkout page for a fixed USD amount. Each
 * invoice is its own wallet, so the amount shown on the page is this one's.
 */
async function payCommand(ctx: Context): Promise<void> {
  if (!config.pay.enabled) {
    await ctx.reply("Invoices are disabled. Send /topup to get a deposit address.");
    return;
  }
  const userId = await admitRequest(ctx);
  if (!userId) return;

  const raw = (ctx.match ?? "").toString().trim();
  const example = `Example: /pay ${fmtAmount(config.pay.minAmount)}`;
  if (!raw) {
    await ctx.reply(`Usage: /pay <amount in USD>\n${example}`);
    return;
  }

  const amountStr = raw.split(/\s+/)[0];
  const amount = Math.round(Number(amountStr.replace(",", ".")) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply(`"${amountStr}" is not a valid amount. ${example}`);
    return;
  }
  if (amount < config.pay.minAmount) {
    await ctx.reply(`The minimum amount is ${fmtAmount(config.pay.minAmount)} USD. ${example}`);
    return;
  }

  await ctx.replyWithChatAction("typing");
  try {
    const wallet = await walletFor(invoiceExternalId(userId), {
      amount,
      currency: config.pay.currency || undefined,
      locale: ctx.from?.language_code,
    });
    logger.info(`Issued invoice ${shortId(wallet.id)} for ${amount} USD to user ${userId} (${wallet.store_external_id}).`);
    await ctx.reply(buildInvoiceMessage(wallet, amount), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      await ctx.reply(`The payment provider rejected the invoice:\n${err.message}`);
      return;
    }
    logger.error("/pay failed:", err);
    await ctx.reply("Could not create the invoice. Please try again later.");
  }
}

async function methodsCommand(ctx: Context): Promise<void> {
  if (isPaused) {
    await ctx.reply(PAUSED_MESSAGE);
    return;
  }
  try {
    await ctx.reply(buildMethodsMessage(await offeredCurrencies()), { parse_mode: "HTML" });
  } catch (err) {
    logger.error("/methods failed:", err);
    await ctx.reply("Could not load the deposit currencies. Please try again later.");
  }
}

/** /balance - admin-only, since it exposes the whole store. */
async function balanceCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is restricted to bot admins.");
    return;
  }
  try {
    const hot = await getHotWalletBalances();
    // Stores without a connected exchange answer this with an error; that is
    // not worth failing the whole command over.
    const exchange = await getExchangeBalances().catch((err) => {
      logger.debug("Exchange balances unavailable:", err);
      return null;
    });
    await ctx.reply(buildBalanceMessage(hot, exchange), { parse_mode: "HTML" });
  } catch (err) {
    logger.error("/balance failed:", err);
    await ctx.reply("Could not read the balances. Please try again later.");
  }
}

/** /status - admin-only reachability check against the provider. */
async function statusCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is restricted to bot admins.");
    return;
  }
  let provider: string;
  try {
    const offered = await offeredCurrencies();
    provider = `reachable, offering ${offered.length} currenc${offered.length === 1 ? "y" : "ies"}`;
  } catch (err) {
    provider = `unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
  const lines = [
    "<b>Bot status</b>",
    "",
    `State: ${isPaused ? "paused" : "running"}`,
    `Provider: ${escapeHtml(config.api.host)} - ${escapeHtml(provider)}`,
    `Deposits: ${escapeHtml(config.deposit.currencies.join(", ") || "every enabled currency")}${pinnedCurrency ? " (no currency menu)" : ""}`,
    `Address mode: ${config.deposit.addressMode === "reuse" ? "reuse (one wallet per user)" : "unique (new wallet on every /topup)"}`,
    `Invoices (/pay): ${config.pay.enabled ? `enabled, min ${fmtAmount(config.pay.minAmount)} USD` : "disabled"}`,
    `Webhooks: ${config.webhook.secret ? `listening on :${config.webhook.port}${escapeHtml(config.webhook.path)} (signed)` : "disabled (DVNET_WEBHOOK_SECRET not set)"}`,
    `Notify: ${[...config.notify.directions].join("+")}${config.notify.unconfirmed ? ", incl. unconfirmed" : ""}${config.notify.admins ? ", admins on Telegram" : ""}`,
    `Email alerts: ${config.mail ? escapeHtml(config.mail.to) : "disabled"}`,
    `Events seen: ${seenEvents.size}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function messageHandler(ctx: Context): Promise<void> {
  if (isPaused) {
    await ctx.reply(PAUSED_MESSAGE);
    return;
  }
  await ctx.reply("Send /topup to get a deposit address, or /help for options.");
}

// ---------------------------------------------------------------------------
// Payment webhooks: DV.net -> this server -> Telegram + email
// ---------------------------------------------------------------------------

/**
 * The events DV.net sends and which way the money moved. Anything else is
 * acknowledged (so it is not retried) and ignored.
 */
const EVENT_DIRECTIONS: Record<string, "in" | "out"> = {
  PaymentReceived: "in",
  PaymentNotConfirmed: "in",
  PaymentAMLBlocked: "in",
  WithdrawalFromProcessingReceived: "out",
};

interface WebhookTx {
  tx_id?: string;
  tx_hash?: string;
  bc_uniq_key?: string;
  created_at?: string;
  currency?: string;
  currency_id?: string;
  blockchain?: string;
  amount?: string;
  amount_usd?: string;
}

/** One webhook, after normalizeEvent() has stripped the "unconfirmed_" prefixes. */
interface WebhookEvent {
  type?: string;
  status?: string;
  created_at?: string;
  paid_at?: string;
  /** USD. */
  amount?: string;
  withdrawal_id?: string;
  transactions?: WebhookTx;
  wallet?: { id?: string; store_external_id?: string };
}

/**
 * PaymentNotConfirmed carries the exact same fields as PaymentReceived, only
 * every key (nested ones included) is prefixed "unconfirmed_". Stripping the
 * prefix lets one WebhookEvent shape serve every event type.
 */
export function normalizeEvent(value: unknown): WebhookEvent {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (isRecord(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k.replace(/^unconfirmed_/, ""), strip(inner)]));
    }
    return v;
  };
  return (isRecord(value) ? strip(value) : {}) as WebhookEvent;
}

/**
 * X-Sign = hex(sha256(rawBody + secret)), exactly as documented under
 * "Webhook signature verification". The comparison is constant-time.
 */
export function verifySignature(rawBody: string, header: string | string[] | undefined, secret: string): boolean {
  const provided = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase() ?? "";
  if (!provided || !secret) return false;
  const expected = createHash("sha256").update(rawBody).update(secret).digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function eventTitle(type: string | undefined): string {
  switch (type) {
    case "PaymentReceived":
      return "Deposit confirmed";
    case "PaymentNotConfirmed":
      return "Deposit detected";
    case "PaymentAMLBlocked":
      return "Deposit held";
    case "WithdrawalFromProcessingReceived":
      return "Withdrawal sent";
    default:
      return type ?? "Event";
  }
}

/** Human-readable one-liner for what the event means. */
export function statusLine(type: string | undefined): string {
  switch (type) {
    case "PaymentReceived":
      return "Confirmed on the blockchain and credited";
    case "PaymentNotConfirmed":
      return "Seen on the blockchain, waiting for confirmations";
    case "PaymentAMLBlocked":
      return "Flagged by AML screening and held for review";
    case "WithdrawalFromProcessingReceived":
      return "Delivered to the recipient";
    default:
      return "unknown";
  }
}

/** "25.5 USDT (≈ 25.5 USD)" */
function eventAmount(ev: WebhookEvent): string {
  const tx = ev.transactions ?? {};
  const crypto = `${fmtAmount(tx.amount)} ${tx.currency ?? ""}`.trim();
  const usd = fmtAmount(tx.amount_usd ?? ev.amount);
  return usd !== "?" ? `${crypto} (≈ ${usd} USD)` : crypto;
}

function eventNetwork(ev: WebhookEvent): string {
  const tx = ev.transactions ?? {};
  if (tx.currency_id) return networkLabel(currencyFromId(tx.currency_id));
  return tx.blockchain ?? "?";
}

let mailer: ReturnType<typeof nodemailer.createTransport> | null = null;

function getMailer() {
  const mail = config.mail;
  if (!mail) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
    });
  }
  return mailer;
}

/** Plain-text summary shared by the email and the admin Telegram message. */
function eventReport(ev: WebhookEvent): string[] {
  const tx = ev.transactions ?? {};
  const traced = parseExternalId(ev.wallet?.store_external_id);
  return [
    `Amount:         ${eventAmount(ev)}`,
    `Network:        ${eventNetwork(ev)}`,
    `Status:         ${statusLine(ev.type)}`,
    tx.tx_hash ? `Tx hash:        ${tx.tx_hash}` : "",
    ev.wallet?.id ? `Wallet:         ${ev.wallet.id}` : "",
    ev.wallet?.store_external_id ? `External ID:    ${ev.wallet.store_external_id}` : "",
    traced ? `Telegram user:  ${traced.userId}${traced.kind === "invoice" ? ` (invoice ${shortId(ev.wallet?.id ?? "")})` : ""}` : "",
    ev.withdrawal_id ? `Withdrawal:     ${ev.withdrawal_id}` : "",
    ev.paid_at ? `On-chain at:    ${ev.paid_at}` : "",
    ev.created_at ? `Recorded at:    ${ev.created_at}` : "",
  ].filter(Boolean);
}

/** Emails an event alert to MAIL_TO. */
async function sendEventEmail(ev: WebhookEvent, direction: "in" | "out"): Promise<void> {
  const mail = config.mail;
  const transport = getMailer();
  if (!mail || !transport) return;

  const title = eventTitle(ev.type);
  const lead =
    direction === "in" ? "A deposit event was received on a generated address." : "A withdrawal was sent from the store.";
  await transport.sendMail({
    from: mail.from || mail.user,
    to: mail.to,
    subject: `${title}: ${eventAmount(ev)}`,
    text: [lead, "", ...eventReport(ev)].join("\n"),
  });
  logger.info(`${title} email sent to ${mail.to} (${eventAmount(ev)})`);
}

/** Tells the depositing user directly, when the event can be traced to one. */
async function notifyDepositor(bot: Bot, ev: WebhookEvent): Promise<void> {
  const traced = parseExternalId(ev.wallet?.store_external_id);
  if (!traced) {
    logger.debug(`Event ${ev.transactions?.tx_hash} has no traceable store_external_id (${ev.wallet?.store_external_id}).`);
    return;
  }

  const tx = ev.transactions ?? {};
  const lines = [
    `<b>${escapeHtml(eventTitle(ev.type))}</b>`,
    "",
    `<b>Amount:</b> ${escapeHtml(eventAmount(ev))}`,
    `<b>Network:</b> ${escapeHtml(eventNetwork(ev))}`,
    `<b>Status:</b> ${escapeHtml(statusLine(ev.type))}`,
  ];
  if (traced.kind === "invoice" && ev.wallet?.id) lines.push(`<b>Invoice:</b> ${escapeHtml(shortId(ev.wallet.id))}`);
  if (ev.type === "PaymentAMLBlocked") lines.push("", "Please contact support about this deposit.");
  if (tx.tx_hash) lines.push("", `<b>Tx:</b> <code>${escapeHtml(tx.tx_hash)}</code>`);

  try {
    await bot.api.sendMessage(traced.userId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    // A user who blocked the bot must not break event processing.
    logger.warn(`Could not notify user ${traced.userId} about ${tx.tx_hash}:`, err);
  }
}

/** Mirrors the email to every admin on Telegram, so alerts work without SMTP. */
async function notifyAdmins(bot: Bot, ev: WebhookEvent): Promise<void> {
  if (!config.notify.admins || config.adminIds.size === 0) return;
  const text = [`<b>${escapeHtml(eventTitle(ev.type))}</b>`, "", `<pre>${escapeHtml(eventReport(ev).join("\n"))}</pre>`].join(
    "\n",
  );
  for (const adminId of config.adminIds) {
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (err) {
      logger.warn(`Could not notify admin ${adminId}:`, err);
    }
  }
}

/** Everything that happens after the webhook has been acknowledged. */
async function processEvent(bot: Bot, ev: WebhookEvent): Promise<void> {
  const tx = ev.transactions ?? {};
  const direction = ev.type ? EVENT_DIRECTIONS[ev.type] : undefined;
  if (!direction) {
    logger.warn(`Webhook with unknown type "${ev.type}" ignored.`);
    return;
  }
  if (!config.notify.directions.has(direction)) {
    logger.debug(`Webhook ${ev.type} ignored (direction ${direction} not in NOTIFY_DIRECTIONS).`);
    return;
  }
  if (ev.type === "PaymentNotConfirmed" && !config.notify.unconfirmed) {
    logger.debug(`Webhook ${ev.type} for ${tx.tx_hash} ignored (NOTIFY_UNCONFIRMED=false).`);
    return;
  }

  // The docs' own idempotency key is tx_hash + bc_uniq_key. The type goes in
  // too because the same transaction legitimately fires twice: once detected,
  // once confirmed.
  const key = `${ev.type}:${tx.tx_hash ?? tx.tx_id ?? ""}:${tx.bc_uniq_key ?? ""}`;
  if (alreadyHandled(key)) {
    logger.debug(`Webhook ${key} already handled, skipping.`);
    return;
  }

  logger.info(
    `Webhook [${direction}] ${ev.type}: ${eventAmount(ev)} over ${eventNetwork(ev)} ` +
      `(tx ${tx.tx_hash ?? "?"}, ${ev.wallet?.store_external_id ?? "no store_external_id"})`,
  );

  if (direction === "in") await notifyDepositor(bot, ev);
  await notifyAdmins(bot, ev);
  try {
    await sendEventEmail(ev, direction);
  } catch (err) {
    logger.error(`Sending the ${ev.type} email failed:`, err);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Webhook body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The signature is checked against the raw bytes before anything is parsed,
 * and only a verified body is ever acted on. DV.net treats any answer other
 * than {"success":true} as a failure and retries (up to 30 times), so a
 * rejected forgery is cheap and a real event is acknowledged before the slow
 * work (Telegram, SMTP) starts.
 */
async function handleWebhook(bot: Bot, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    respond(res, 413, { success: false });
    return;
  }

  if (!verifySignature(raw, req.headers["x-sign"], config.webhook.secret)) {
    logger.warn(`Webhook from ${req.socket.remoteAddress ?? "?"} rejected: bad or missing X-Sign.`);
    respond(res, 401, { success: false });
    return;
  }

  let event: WebhookEvent;
  try {
    event = normalizeEvent(JSON.parse(raw));
  } catch {
    respond(res, 400, { success: false });
    return;
  }

  respond(res, 200, { success: true });
  processEvent(bot, event).catch((err) => logger.error(`Processing webhook ${event.type} failed:`, err));
}

export function startWebhookServer(bot: Bot): Server {
  const server = createServer((req, res) => {
    const pathOnly = ((req.url ?? "").split("?")[0] ?? "").replace(/\/+$/, "") || "/";

    // Uptime probe for the VPS, no auth needed - it reveals nothing.
    if (req.method === "GET" && pathOnly === "/health") {
      respond(res, 200, { ok: true, paused: isPaused });
      return;
    }
    if (req.method !== "POST" || pathOnly !== config.webhook.path) {
      respond(res, 404, { error: "not_found" });
      return;
    }

    handleWebhook(bot, req, res).catch((err) => {
      logger.error("Webhook handler error:", err);
      if (!res.headersSent) respond(res, 500, { success: false });
    });
  });

  server.listen(config.webhook.port, () => {
    logger.info(
      `Webhook receiver listening on :${config.webhook.port}${config.webhook.path} - ` +
        `set this URL (behind HTTPS) as the webhook in your DV.net project settings.`,
    );
  });

  return server;
}

// ---------------------------------------------------------------------------
// Bot setup & startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const bot = new Bot(config.botToken);

  // Request logging.
  bot.use(async (ctx, next) => {
    const from = ctx.from?.username ?? ctx.from?.id ?? "unknown";
    logger.debug(`Update ${ctx.update.update_id} from ${from}`);
    await next();
  });

  // Commands.
  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("topup", topupCommand);
  bot.command("pay", payCommand);
  bot.command("methods", methodsCommand);
  bot.command("balance", balanceCommand); // admin-only (handled inside)
  bot.command("status", statusCommand); // admin-only (handled inside)
  bot.command("stop", stopCommand); // admin-only pause (handled inside)

  // Currency buttons from /topup.
  bot.callbackQuery(/^dep:/, depositCallbackQuery);

  // Fallback text handler (after commands so commands take priority).
  bot.on("message:text", messageHandler);

  // Catch errors so a single bad update never crashes the process.
  bot.catch((err) => {
    logger.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
  });

  // Start the webhook receiver before touching Telegram: webhooks carry money
  // events, and a slow or failing setMyCommands must not drop them on the floor.
  if (config.webhook.secret) {
    startWebhookServer(bot);
  } else {
    logger.warn(
      "DVNET_WEBHOOK_SECRET is not set, so the webhook receiver is off and deposits will not be announced. " +
        "Copy the secret from the project's advanced settings in DV.net to enable it.",
    );
  }

  // The command menu is cosmetic. grammY retries getMe/getUpdates on its own
  // when Telegram is unreachable at boot, so this must not be the one call
  // that takes the process down instead.
  try {
    await bot.api.setMyCommands(commandList);
  } catch (err) {
    logger.warn("Could not register the command menu with Telegram (the bot still works):", err);
  }

  // Only shut down on a real OS termination signal; /stop just pauses.
  process.once("SIGINT", () => {
    logger.info("SIGINT received, shutting down...");
    void bot.stop();
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down...");
    void bot.stop();
  });

  const mail = config.mail;
  if (mail) {
    getMailer()
      ?.verify()
      .then(() => logger.info(`Email notifications enabled -> ${mail.to}`))
      .catch((err) => logger.error("SMTP verify failed (emails may not send):", err));
  } else {
    logger.warn("Email notifications disabled (set SMTP_HOST and MAIL_TO to enable).");
  }

  // Fail loudly at startup rather than on a user's first /topup.
  logger.info(
    pinnedCurrency
      ? `Deposits: ${pinnedCurrency} only, /topup will not ask. Address mode: ${config.deposit.addressMode}.`
      : `Deposits: ${config.deposit.currencies.join(", ") || "every enabled currency"}. Address mode: ${config.deposit.addressMode}.`,
  );
  try {
    const offered = await offeredCurrencies();
    logger.info(
      `Provider reachable at ${config.api.host}: offering ${offered.map((c) => c.id).join(", ") || "no currencies (check DEPOSIT_CURRENCIES)"}.`,
    );
  } catch (err) {
    logger.error("Could not load the store currencies at startup (check DVNET_HOST / DVNET_API_KEY):", err);
  }

  logger.info("Starting bot (long polling)...");
  await bot.start({
    onStart: (info) => logger.info(`Bot @${info.username} is up and running`),
  });
}

// Keep the process alive even if a stray error escapes a handler - the bot
// should stay on once started.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
});

/**
 * Start the bot unless a test asked for the helpers only.
 *
 * This deliberately does NOT compare process.argv[1] to this module's path.
 * PM2's fork mode sets argv[1] to its own ProcessContainerFork.js, so that
 * comparison quietly fails and the bot starts up as a no-op: no output, no
 * error, empty logs, nothing running. Opting out explicitly is the only form
 * that survives being launched by something other than `node index.js`.
 */
if (process.env["DVNET_BOT_NO_AUTOSTART"] !== "1") {
  main().catch((err) => {
    logger.error("Fatal error during startup:", err);
    process.exit(1);
  });
}
