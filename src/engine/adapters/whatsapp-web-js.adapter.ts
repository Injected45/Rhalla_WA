import { EventEmitter } from 'events';
import { Client, LocalAuth, MessageMedia, Message } from 'whatsapp-web.js';
import { fetchAndDecryptWhatsAppMedia, RawMediaInfo } from './wa-media-decrypt';
import { reflectChatsFromWAWeb, ReflectedChat } from './wa-chats-reflect';
import { sendMediaViaWAWeb } from './wa-media-send';
import { installMemoizePatch } from './wa-memoize-patch';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import {
  GroupChat,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private readyTimeoutHandle: NodeJS.Timeout | null = null;
  private frameHealthHandle: NodeJS.Timeout | null = null;
  // Set to true after we've reported a detached frame so we don't fire the
  // disconnect callback repeatedly while destroy()/reconnect is unwinding.
  private frameDetached = false;
  // Counts consecutive frame-health pings that timed out (browser tab is
  // alive but unresponsive). A single timeout can be transient GC/Chromium
  // hiccup, but N in a row means the tab is silently hung — we saw this on
  // 2026-09-22 where every send timed out for ~2 hours before recovery.
  private frameTimeoutStreak = 0;

  // How often to ping the wwjs pupPage to detect a silently-detached Chromium
  // frame — WhatsApp Web occasionally kills its own tab and wwjs's
  // `disconnected` event does NOT fire, so the session sits READY forever
  // while every API call hits "Attempted to use detached Frame". This watchdog
  // trips the disconnected callback so the reconnect scheduler recovers it
  // automatically instead of needing a manual /stop → /start.
  private static readonly FRAME_HEALTH_INTERVAL_MS = parseInt(
    process.env.ENGINE_FRAME_HEALTH_MS || '60000',
    10,
  );
  // After this many consecutive frame-health timeouts, treat the tab as
  // hung and trip the disconnect so the reconnect scheduler recovers it.
  // 3 × 60s = 3 minutes of unresponsive tab before we tear it down.
  private static readonly FRAME_TIMEOUT_STREAK_LIMIT = parseInt(
    process.env.ENGINE_FRAME_TIMEOUT_STREAK || '3',
    10,
  );

  // If wwjs fires `authenticated` (auth succeeded) but never fires `ready`
  // (WhatsApp Web's chat loader is stuck) this many ms after auth, treat the
  // session as wedged and mark it FAILED so ops sees it clearly and the
  // controlling service can recover (retry, or trigger a QR rescan).
  // 90s proved far too tight for accounts with a large chat history: on
  // 2026-09-18 alserafa34 authenticated and then failed to finish loading
  // chats inside the window 17 times in a row, so the session could not come
  // back at all. Raised to 240s and made configurable — this is a "wedged"
  // detector, so it only needs to be longer than a legitimately slow load.
  private static readonly READY_AFTER_AUTH_TIMEOUT_MS = parseInt(
    process.env.ENGINE_READY_TIMEOUT_MS || '240000',
    10,
  );

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  /**
   * Remove Chromium single-instance lock/singleton files left behind after
   * an unclean shutdown. Without this, the next browser launch either refuses
   * to start or silently degrades.
   */
  private cleanupStaleChromiumLocks(): void {
    const dir = path.resolve(this.config.sessionDataPath, `session-${this.config.sessionId}`);
    if (!fs.existsSync(dir)) return;
    const targets = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'RunningChromeVersion', 'lockfile'];
    const locations = [dir, path.join(dir, 'Default')];
    for (const loc of locations) {
      for (const name of targets) {
        const p = path.join(loc, name);
        try {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            this.logger.log(`Removed stale Chromium file: ${path.relative(dir, p)}`);
          }
        } catch (err) {
          // Non-fatal — Chromium may just recreate it and hopefully proceed.
          this.logger.warn(`Could not remove ${p}: ${String(err)}`);
        }
      }
    }
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    // Auto-heal after previous unclean shutdowns.
    this.cleanupStaleChromiumLocks();

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
          // 10 min instead of puppeteer's 3 min default: WhatsApp Web can take longer to
          // finish handshakes on slow links, and the default fires `Runtime.callFunctionOn
          // timed out` before the client is really dead.
          protocolTimeout: 600_000,
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      // wwjs's `authenticated` means auth SUCCEEDED (QR scanned or LocalAuth
      // restored) — we're now waiting for `ready` while WhatsApp Web loads the
      // chat UI. Keeping status as AUTHENTICATING is the closest label the DB
      // enum supports; the real fix for "stuck in authenticating forever" is
      // the ready-after-auth timeout armed here — if `ready` doesn't fire in
      // 90s, we bail out FAILED so ops sees the stuck state and can recover
      // instead of the session lying at "authenticating" indefinitely.
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
      this.armReadyTimeout();
    });

    // Some builds of WhatsApp Web emit progress percentages during chat load —
    // logging these gives visibility into where a wedged session is stuck.
    (this.client as unknown as { on(event: string, listener: (...args: unknown[]) => void): void }).on(
      'loading_screen',
      (percent: unknown, message: unknown) => {
        this.logger.log(`WhatsApp Web loading: ${String(percent)}% — ${String(message)}`);
      },
    );

    // Internal wwjs state transitions (CONNECTED, CONFLICT, TIMEOUT, ...).
    (this.client as unknown as { on(event: string, listener: (...args: unknown[]) => void): void }).on(
      'change_state',
      (state: unknown) => {
        this.logger.log(`wwjs change_state: ${String(state)}`);
      },
    );

    this.client.on('ready', () => {
      this.clearReadyTimeout();
      this.frameDetached = false;
      this.armFrameHealth();
      // WA Web ~2026-09-18 build made a memoize helper throw for undefined
      // inputs, which crashed every media send. Patch that helper in place
      // right after ready so wwjs's own send code can complete normally.
      void this.installMemoizePatchWithLogging();
      try {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.('', '');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        const incomingMessage = await this.toIncomingMessage(msg);
        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    // 'message_create' fires for EVERY message, including ones sent by this
    // account (via the API or the linked phone). We forward only outgoing
    // messages here; incoming ones are already handled by 'message' above.
    this.client.on('message_create', async msg => {
      if (!msg.fromMe) return;
      try {
        const sentMessage = await this.toIncomingMessage(msg);
        this.callbacks.onMessageSent?.(sentMessage);
      } catch (error) {
        this.logger.error('Error processing sent message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('disconnected', reason => {
      this.clearReadyTimeout();
      this.clearFrameHealth();
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', () => {
      this.clearReadyTimeout();
      this.clearFrameHealth();
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('Authentication failed');
    });
  }

  private armReadyTimeout(): void {
    this.clearReadyTimeout();
    this.readyTimeoutHandle = setTimeout(() => {
      this.logger.error(
        `Engine wedged: authenticated fired but 'ready' did not arrive within ` +
          `${WhatsAppWebJsAdapter.READY_AFTER_AUTH_TIMEOUT_MS}ms — WhatsApp Web is stuck loading chats. ` +
          `Marking session FAILED so it stops silently sitting in 'authenticating'.`,
      );
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('READY_TIMEOUT');
      // Best-effort teardown so the next start() gets a clean browser.
      void this.destroy().catch(err => this.logger.warn(`destroy after READY_TIMEOUT failed: ${String(err)}`));
    }, WhatsAppWebJsAdapter.READY_AFTER_AUTH_TIMEOUT_MS);
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeoutHandle) {
      clearTimeout(this.readyTimeoutHandle);
      this.readyTimeoutHandle = null;
    }
  }

  private static isDetachedFrameError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /detached\s+Frame|Target closed|Session closed|Protocol error \(Runtime\.callFunctionOn\): Target closed/i.test(
      msg,
    );
  }

  /**
   * A live wwjs session can silently lose its Chromium frame (WhatsApp Web
   * killing its own tab, Chromium OOM, etc). wwjs's `disconnected` event does
   * NOT fire in that state, so the session sits READY forever while every API
   * call hits "Attempted to use detached Frame". This watchdog pings the page
   * every FRAME_HEALTH_INTERVAL_MS and, when it detects a detached frame,
   * fires the disconnected callback so the reconnect scheduler recovers it.
   */
  private armFrameHealth(): void {
    this.clearFrameHealth();
    this.frameHealthHandle = setInterval(() => {
      void this.checkFrameHealth();
    }, WhatsAppWebJsAdapter.FRAME_HEALTH_INTERVAL_MS);
  }

  private clearFrameHealth(): void {
    if (this.frameHealthHandle) {
      clearInterval(this.frameHealthHandle);
      this.frameHealthHandle = null;
    }
  }

  private static isProtocolTimeoutError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /Runtime\.(evaluate|callFunctionOn) timed out|ProtocolError.*timed out/i.test(msg);
  }

  private async checkFrameHealth(): Promise<void> {
    if (this.status !== EngineStatus.READY || this.frameDetached) return;
    const pupPage = (this.client as unknown as { pupPage?: import('puppeteer').Page })?.pupPage;
    if (!pupPage) return;
    try {
      // A trivial evaluate is enough — if the frame is detached puppeteer
      // rejects with "Attempted to use detached Frame" almost immediately.
      await pupPage.evaluate('1');
      // Success → reset the streak counter.
      this.frameTimeoutStreak = 0;
    } catch (err) {
      if (WhatsAppWebJsAdapter.isDetachedFrameError(err)) {
        this.reportFrameDetached('watchdog', err);
        return;
      }
      if (WhatsAppWebJsAdapter.isProtocolTimeoutError(err)) {
        this.frameTimeoutStreak++;
        this.logger.warn(
          `frameHealth ping timed out (streak ${this.frameTimeoutStreak}/${WhatsAppWebJsAdapter.FRAME_TIMEOUT_STREAK_LIMIT}): ${String((err as Error)?.message ?? err).slice(0, 200)}`,
        );
        // On 2026-09-22 alserafa34 sat READY-but-hung for ~2h with every
        // send timing out. A single timeout can be a GC pause; N in a row
        // means the tab is silently unresponsive — tear it down so the
        // reconnect scheduler recovers it.
        if (this.frameTimeoutStreak >= WhatsAppWebJsAdapter.FRAME_TIMEOUT_STREAK_LIMIT) {
          this.reportFrameDetached('watchdog-timeout-streak', err);
        }
        return;
      }
      // Anything else — log but don't tear down; could be a one-off wwjs
      // hiccup that recovers by itself.
      this.logger.warn(`frameHealth ping failed non-fatally: ${String((err as Error)?.message ?? err)}`);
    }
  }

  /**
   * Fire the disconnected callback exactly once when we discover the browser
   * frame is dead. Called from the watchdog and from runSend() when a send
   * attempt catches the same error class.
   */
  private reportFrameDetached(source: string, err: unknown): void {
    if (this.frameDetached) return;
    this.frameDetached = true;
    this.clearFrameHealth();
    this.logger.error(
      `Chromium frame detached (source=${source}) — session is a zombie, tripping disconnect for auto-reconnect. err=${String(
        (err as Error)?.message ?? err,
      ).slice(0, 200)}`,
    );
    this.setStatus(EngineStatus.FAILED);
    this.callbacks.onDisconnected?.('FRAME_DETACHED');
    // Best-effort teardown so the next start() gets a clean browser.
    void this.destroy().catch(e =>
      this.logger.warn(`destroy after FRAME_DETACHED failed: ${String(e)}`),
    );
  }

  private async installMemoizePatchWithLogging(): Promise<void> {
    const pupPage = (this.client as unknown as { pupPage?: import('puppeteer').Page })?.pupPage;
    if (!pupPage) return;
    try {
      const result = await installMemoizePatch(pupPage);
      if (result.patched) {
        this.logger.log(
          `WA-Web memoize helper patched — ${result.functionsPatched} function(s) wrapped across ${result.scannedModules} modules. Media sends should now bypass the getSender crash.`,
        );
      } else {
        this.logger.warn(
          `WA-Web memoize helper NOT patched — scanned ${result.scannedModules} modules, found no matching function${result.error ? ` (error: ${result.error})` : ''}. Media sends may still fail.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `installMemoizePatch crashed: ${String((err as Error)?.message ?? err)}`,
      );
    }
  }

  /**
   * Build a normalized message object from a whatsapp-web.js Message.
   * Used for both incoming ('message') and outgoing ('message_create') events.
   */
  private async toIncomingMessage(msg: Message): Promise<IncomingMessage> {
    // For outgoing messages the relevant chat is the recipient (msg.to);
    // for incoming it's the sender (msg.from).
    const chatTarget = msg.fromMe ? msg.to : msg.from;

    const incomingMessage: IncomingMessage = {
      id: msg.id._serialized,
      from: msg.from,
      to: msg.to,
      chatId: chatTarget,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      isGroup: chatTarget.endsWith('@g.us'),
    };

    // Handle media
    if (msg.hasMedia) {
      // wwjs's downloadMedia() often fails on the first try when the media key
      // hasn't been cached yet (common for group images from @lid senders and
      // messages that arrive right as WA Web is still loading). A short retry
      // recovers most of those; when it still fails we surface an error field
      // instead of dropping the media silently, so webhook receivers can tell
      // "download failed" apart from "no media".
      const attempts = 3;
      const backoffMs = [0, 500, 1500];
      let lastError: unknown = null;
      let downloaded = false;
      for (let i = 0; i < attempts; i++) {
        if (backoffMs[i] > 0) await new Promise(r => setTimeout(r, backoffMs[i]));
        try {
          const media = await msg.downloadMedia();
          if (media) {
            incomingMessage.media = {
              mimetype: media.mimetype,
              filename: media.filename || undefined,
              data: media.data,
            };
            downloaded = true;
            break;
          }
          // downloadMedia returned null/undefined without throwing — treat as
          // a soft miss and retry.
          lastError = new Error('downloadMedia returned no data');
        } catch (error) {
          lastError = error;
        }
      }
      // Native fallback: when wwjs's downloadMedia() fails universally (as
      // happens after WA Web renames the modules wwjs reflects into), decrypt
      // the media ourselves from the raw crypto fields on msg._data. This
      // bypasses puppeteer entirely and only depends on the WA CDN URL, the
      // mediaKey, and Node's crypto — none of which drift with WA Web JS
      // updates.
      if (!downloaded) {
        const raw = (msg as any)._data as
          | {
              directPath?: string;
              deprecatedMms3Url?: string;
              url?: string;
              mediaKey?: unknown;
              mimetype?: string;
              filename?: string;
              type?: string;
            }
          | undefined;
        if (raw?.mediaKey && (raw.directPath || raw.url || raw.deprecatedMms3Url)) {
          try {
            const info: RawMediaInfo = {
              directPath: raw.directPath || '',
              mediaUrl: raw.url || raw.deprecatedMms3Url,
              mediaKey: raw.mediaKey as RawMediaInfo['mediaKey'],
              type: raw.type || msg.type,
              mimetype: raw.mimetype,
              filename: raw.filename,
            };
            const bytes = await fetchAndDecryptWhatsAppMedia(info);
            incomingMessage.media = {
              mimetype: raw.mimetype || 'application/octet-stream',
              filename: raw.filename || undefined,
              data: bytes.toString('base64'),
            };
            downloaded = true;
            this.logger.log(`Native decrypt fallback succeeded (${bytes.length} bytes, type=${msg.type})`);
          } catch (fbErr) {
            lastError = fbErr;
          }
        }
      }
      if (!downloaded) {
        // Log the real error (stack/message), not just its stringified form —
        // wwjs's minified internal errors stringify to useless things like "r: r".
        const err = lastError as { stack?: string; message?: string } | null;
        const detail = err?.stack || err?.message || String(lastError);
        this.logger.error(
          `Failed to download media: wwjs + native fallback both failed (messageId=${msg.id?._serialized}, type=${msg.type})`,
          detail,
        );
        incomingMessage.media = {
          error: err?.message ? `download_failed: ${err.message}` : 'download_failed',
        };
      }
    }

    // Handle quoted message
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        incomingMessage.quotedMessage = {
          id: quoted.id._serialized,
          body: quoted.body,
        };
      } catch (error) {
        this.logger.error('Error getting quoted message', String(error));
      }
    }

    // Resolve the real sender identity. `from`/`to` can be an opaque @lid
    // (WhatsApp privacy LinkedID); getContact() exposes the actual phone
    // number and nickname (pushname) when WhatsApp makes them available.
    try {
      const contact = await msg.getContact();
      const number = contact?.number || undefined;
      incomingMessage.senderNumber = number;
      incomingMessage.senderName = contact?.pushname || contact?.name || undefined;
      incomingMessage.senderCountry = number ? this.resolveCountry(number) : undefined;
    } catch (error) {
      this.logger.warn('Could not resolve sender contact', String(error));
    }

    return incomingMessage;
  }

  /** Resolve a country name from an E.164-ish phone number (no '+'). */
  private resolveCountry(number: string): string | undefined {
    try {
      const parsed = parsePhoneNumberFromString(`+${number.replace(/^\+/, '')}`);
      if (!parsed?.country) return undefined;
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(parsed.country);
      return name || parsed.country;
    } catch {
      return undefined;
    }
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // Use destroy instead of logout to preserve session data
        // This allows reconnecting without needing to scan QR again
        await this.client.destroy();
      } catch (error) {
        this.logger.warn('Destroy client failed:', String(error));
        // Already destroyed or not initialized - ignore
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        // Logout clears session data - user will need to scan QR again
        await this.client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
        // Fall back to destroy if logout fails
        try {
          await this.client.destroy();
        } catch (destroyError) {
          this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
        }
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async destroy(): Promise<void> {
    this.clearReadyTimeout();
    this.clearFrameHealth();
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // Whatsapp-web.js on current WhatsApp Web is flaky about the return of
  // client.sendMessage — it sometimes resolves to `undefined` or throws a minified
  // TypeError from inside the injected browser JS *after* the outbound send frame
  // has already reached WhatsApp. Result: message delivers, but our old
  // `msg.id._serialized` blew up with a 500 and MessageService marked the DB row
  // as FAILED. These helpers extract safely and identify the known post-send
  // failure signatures so we return a truthful "sent-but-unresolved" result
  // instead of a 500 the caller can't distinguish from a real failure.

  private resolveSendResult(msg: unknown, context: string): MessageResult {
    const m = msg as { id?: { _serialized?: unknown }; timestamp?: unknown } | null | undefined;
    const rawId = m?.id?._serialized;
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : '';
    const rawTs = m?.timestamp;
    const timestamp = typeof rawTs === 'number' && rawTs > 0 ? rawTs : Math.floor(Date.now() / 1000);
    if (!id) {
      this.logger.warn(
        `${context}: whatsapp-web.js returned no message id — the message likely delivered but cannot be correlated. Returning empty id.`,
      );
    }
    return { id, timestamp };
  }

  private isLikelyPostSendError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
    return (
      msg.includes("reading 'id'") ||
      msg.includes("reading '_serialized'") ||
      msg.includes("reading 'timestamp'") ||
      msg.includes('serialize') ||
      msg.includes('evaluate at binding') ||
      /^[a-z]:\s*[a-z]$/.test(msg.trim()) // minified obfuscation like "t: t"
    );
  }

  private async runSend(context: string, sendFn: () => Promise<unknown>): Promise<MessageResult> {
    try {
      const msg = await sendFn();
      return this.resolveSendResult(msg, context);
    } catch (err) {
      // Detached-frame is fatal — the message did NOT reach WhatsApp because
      // the browser was dead before the send. Trip the disconnect so the
      // reconnect scheduler recovers this session, and rethrow so the caller
      // sees a real failure (not a "delivered without id" lie).
      if (WhatsAppWebJsAdapter.isDetachedFrameError(err)) {
        this.reportFrameDetached(context, err);
        throw err;
      }
      // Protocol timeout = the tab is silently hung. Message did NOT reach
      // WhatsApp. Trip the disconnect so the reconnect scheduler recovers.
      if (WhatsAppWebJsAdapter.isProtocolTimeoutError(err)) {
        this.reportFrameDetached(context, err);
        throw err;
      }
      if (this.isLikelyPostSendError(err)) {
        // ensureReady() would already have thrown for a session-dead state, and the
        // outbound frame reaches WhatsApp before this class of error fires. Treat as
        // delivered-without-id, log the underlying error for the operator.
        this.logger.warn(
          `${context}: sendMessage threw after ensureReady; treating as delivered without id. err=${String((err as Error)?.message ?? err).slice(0, 200)}`,
        );
        return { id: '', timestamp: Math.floor(Date.now() / 1000) };
      }
      throw err;
    }
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    return this.runSend('sendTextMessage', () => this.client!.sendMessage(chatId, text));
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL. MessageMedia.fromUrl derives filename from the URL path and mimetype
        // from the response's Content-Type header — both of which are frequently wrong
        // (temp-file hosts often serve application/octet-stream and random path names).
        // Fetch as usual, then overwrite with the caller-provided values when present.
        messageMedia = await MessageMedia.fromUrl(media.data, { unsafeMime: true });
        // Guardrail: many file hosts return an HTML landing page (e.g. tmpfiles.org
        // without /dl/) instead of the file bytes. If the caller asked for a non-HTML
        // mimetype but we fetched HTML, refuse to send garbage.
        const fetchedIsHtml = /^text\/html/i.test(messageMedia.mimetype || '');
        const wantsNonHtml = media.mimetype && !/^text\/html/i.test(media.mimetype);
        if (fetchedIsHtml && wantsNonHtml) {
          throw new Error(
            `URL returned HTML (text/html) instead of ${media.mimetype}. ` +
              `The URL is likely a landing/preview page, not a direct download link. ` +
              `Fix the URL to point to raw file bytes, or send as base64.`,
          );
        }
        if (media.mimetype && media.mimetype !== 'application/octet-stream') {
          messageMedia.mimetype = media.mimetype;
        }
        if (media.filename) {
          messageMedia.filename = media.filename;
        }
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    // Try wwjs's own send first. If it throws with the "memoize getter"
    // pattern that the 2026-09 WA Web build introduced, fall through to our
    // own puppeteer-side send that mirrors wwjs but skips the failing step.
    try {
      return await this.runSend('sendMediaMessage', () =>
        this.client!.sendMessage(chatId, messageMedia, { caption: media.caption }),
      );
    } catch (err) {
      if (!WhatsAppWebJsAdapter.isMemoizeGetterError(err)) {
        throw err;
      }
      const primary = String((err as Error)?.message ?? err).slice(0, 200);
      this.logger.warn(
        `wwjs sendMessage hit the WA-Web memoize getter bug, falling back to native send: ${primary}`,
      );
      return this.nativeMediaSend(chatId, messageMedia, media.caption);
    }
  }

  /**
   * WA Web (from ~2026-09-18) throws this exact error inside wwjs's
   * pupPage.evaluate during media sends. Text sends aren't affected because
   * they don't go through the same media memoization step.
   */
  private static isMemoizeGetterError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
    return msg.includes("passed to getter must include an id property") ||
      msg.includes("must include an id property (it's how we memoize)");
  }

  private async nativeMediaSend(
    chatId: string,
    media: MessageMedia,
    caption?: string,
  ): Promise<MessageResult> {
    const pupPage = (this.client as unknown as { pupPage?: import('puppeteer').Page })?.pupPage;
    if (!pupPage) throw new Error('nativeMediaSend: pupPage unavailable');
    const result = await sendMediaViaWAWeb(pupPage, {
      chatId,
      base64: media.data,
      mimetype: media.mimetype,
      filename: media.filename ?? undefined,
      caption,
    });
    if (!result.ok) {
      this.logger.error(
        `nativeMediaSend failed at step=${result.step}: ${result.error?.slice(0, 400)}`,
      );
      throw new Error(`Native media send failed at step ${result.step}: ${result.error}`);
    }
    this.logger.log(`Native media send succeeded (id=${result.id})`);
    return {
      id: result.id || '',
      timestamp: result.timestamp || Math.floor(Date.now() / 1000),
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    let contacts;
    try {
      contacts = await this.client!.getContacts();
    } catch (err) {
      // Known whatsapp-web.js failure mode on current WhatsApp Web: the injected
      // contact resolver throws "getAlternateUserWid - Invalid get call using
      // deviceWid" (or a minified variant) when any single contact record on the
      // account has malformed state. It blows up the whole listing. Surface a
      // truthful 503 with the underlying reason instead of a bare 500.
      throw new Error(
        `Contact listing failed inside whatsapp-web.js (upstream WhatsApp Web bug): ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }

    return contacts
      .filter(c => c && c.id && c.id._serialized)
      .map(c => ({
        id: c.id._serialized,
        name: c.name || undefined,
        pushName: c.pushname || undefined,
        number: c.number,
        isMyContact: c.isMyContact,
        isBlocked: c.isBlocked,
      }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId !== null;
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();

    // First try wwjs's built-in path. When it works, it returns the fully-
    // hydrated Chat objects with methods we can call. When the WA-Web module
    // rename bug is active, this throws with the minified "r: r" error — we
    // then fall through to our reflection-based enumeration.
    try {
      const chats = await this.client!.getChats();
      const groups = chats.filter(chat => chat.isGroup);
      const myId = this.client?.info?.wid?._serialized;
      return Promise.all(
        groups.map(async g => {
          let groupChat = g as unknown as GroupChat;
          if (!groupChat.participants || groupChat.participants.length === 0) {
            try {
              groupChat = (await this.client!.getChatById(g.id._serialized)) as unknown as GroupChat;
            } catch {
              // keep the lightweight object if the fetch fails
            }
          }
          return {
            id: g.id._serialized,
            name: g.name,
            participantsCount: groupChat.participants?.length,
            isAdmin: groupChat.participants?.some(p => p.isAdmin && p.id._serialized === myId),
          };
        }),
      );
    } catch (wwjsErr) {
      const primary = (wwjsErr as Error)?.message ?? String(wwjsErr);
      this.logger.warn(`wwjs getChats() failed, trying native WA-Web reflection fallback: ${primary}`);
      const reflected = await this.reflectGroups();
      if (reflected) return reflected;
      throw new Error(`Group listing failed inside whatsapp-web.js (upstream WhatsApp Web bug): ${primary}`);
    }
  }

  /**
   * Reflect into WA Web ourselves to enumerate chats when wwjs's own path is
   * broken. See src/engine/adapters/wa-chats-reflect.ts for the browser-side
   * strategy (module-name candidates → webpack cache scan by shape).
   */
  private async reflectGroups(): Promise<Group[] | null> {
    const pupPage = (this.client as unknown as { pupPage?: import('puppeteer').Page })?.pupPage;
    if (!pupPage) return null;
    let result;
    try {
      result = await reflectChatsFromWAWeb(pupPage);
    } catch (err) {
      this.logger.error('reflectChatsFromWAWeb crashed', (err as Error)?.stack || String(err));
      return null;
    }
    if (!result.chats) {
      this.logger.error(
        'Native reflection could not find WA Web Chat collection',
        JSON.stringify(result.diag).slice(0, 800),
      );
      return null;
    }
    this.logger.log(
      `Native reflection found Chat collection via ${result.diag.source} (${result.chats.length} total chats)`,
    );
    const myId = this.client?.info?.wid?._serialized;
    return result.chats.filter(c => c.isGroup).map(c => this.reflectedToGroup(c, myId));
  }

  private reflectedToGroup(c: ReflectedChat, myId?: string): Group {
    return {
      id: c.id,
      name: c.name || '',
      participantsCount: c.participants?.length,
      isAdmin: c.participants?.some(p => p.isAdmin && p.id === myId),
    };
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    return this.runSend('sendLocationMessage', () => this.client!.sendMessage(chatId, loc));
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    return this.runSend('sendContactMessage', () => this.client!.sendMessage(chatId, vcard, { parseVCards: true }));
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    return this.runSend('sendStickerMessage', () =>
      this.client!.sendMessage(chatId, messageMedia, { sendMediaAsSticker: true }),
    );
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    return this.runSend('replyToMessage', () => quotedMsg.reply(text));
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      // Group participant objects only carry { id, isAdmin, isSuperAdmin } — no
      // name. Resolve each participant's display name via their contact.
      const participants: GroupParticipant[] = await Promise.all(
        (groupChat.participants || []).map(async p => {
          let name: string | undefined;
          try {
            const contact = await this.client!.getContactById(p.id._serialized);
            name = contact?.pushname || contact?.name || undefined;
          } catch {
            // contact not resolvable — leave name undefined
          }
          return {
            id: String(p.id._serialized),
            number: String(p.id.user),
            name,
            isAdmin: Boolean(p.isAdmin),
            isSuperAdmin: Boolean(p.isSuperAdmin),
          };
        }),
      );

      const meta = (groupChat as unknown as { groupMetadata?: { desc?: string } }).groupMetadata;

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description || meta?.desc || undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.logger.warn(`wwjs getChatById failed for ${groupId}, trying native reflection fallback: ${String(error)}`);
      const fb = await this.reflectGroupInfo(groupId);
      if (fb) return fb;
      return null;
    }
  }

  /**
   * Fallback for getGroupInfo when wwjs's getChatById is broken by the same
   * WA-Web module rename. Reflection returns ALL chats — we pick the one we
   * want. Extra cost is acceptable because this is the recovery path.
   */
  private async reflectGroupInfo(groupId: string): Promise<GroupInfo | null> {
    const pupPage = (this.client as unknown as { pupPage?: import('puppeteer').Page })?.pupPage;
    if (!pupPage) return null;
    let result;
    try {
      result = await reflectChatsFromWAWeb(pupPage);
    } catch (err) {
      this.logger.error('reflectChatsFromWAWeb crashed in getGroupInfo', (err as Error)?.stack || String(err));
      return null;
    }
    if (!result.chats) {
      this.logger.error(
        'Native reflection could not find WA Web Chat collection in getGroupInfo',
        JSON.stringify(result.diag).slice(0, 800),
      );
      return null;
    }
    const c = result.chats.find(x => x.id === groupId && x.isGroup);
    if (!c) return null;
    // Resolve participant display names — this MAY also fail if getContactById
    // reflection is broken; on failure we return the raw ids without names.
    const participants: GroupParticipant[] = await Promise.all(
      c.participants.map(async p => {
        let name: string | undefined;
        try {
          const contact = await this.client!.getContactById(p.id);
          name = contact?.pushname || contact?.name || undefined;
        } catch {
          // ignore
        }
        return {
          id: p.id,
          number: p.id.split('@')[0],
          name,
          isAdmin: p.isAdmin,
          isSuperAdmin: p.isSuperAdmin,
        };
      }),
    );
    return {
      id: c.id,
      name: c.name || '',
      description: c.description,
      owner: c.ownerId,
      createdAt: c.createdAt,
      participants,
      isReadOnly: false,
      isAnnounce: false,
    };
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await (message as MessageWithReactions).react(emoji);
    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const labels = await (this.client as unknown as BusinessClient).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);
    if (!label) {
      return null;
    }
    return {
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    };
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const labels = await (chat as unknown as GroupChat).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).addLabel(labelId);
    this.logger.log(`Added label ${labelId} to chat ${chatId}`);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).removeLabel(labelId);
    this.logger.log(`Removed label ${labelId} from chat ${chatId}`);
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
        verified: ch.verified ? Boolean(ch.verified) : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        throw new Error(`Channel ${channelId} not found`);
      }
      const messages = await ch.fetchMessages({ limit });
      if (!messages) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }

  // ========== Gap Quick Wins Implementation ==========

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ensureReady();
    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ensureReady();
    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native Catalog API support
    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ensureReady();
    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');
  }

  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
  }
}
