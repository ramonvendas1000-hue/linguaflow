import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import path from 'path';
import pino from 'pino';
import type { WhatsAppAdapter, RawInboundMessage, RawContact, WaStatusValue } from './WhatsAppAdapter.js';

type EventCallback<T> = (data: T) => void;

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class BaileysAdapter implements WhatsAppAdapter {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private currentStatus: WaStatusValue = 'close';
  private sessionDir: string;
  private manuallyDisconnected = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private messageListeners: EventCallback<RawInboundMessage>[] = [];
  private contactListeners: EventCallback<RawContact>[] = [];
  private qrListeners: EventCallback<string>[] = [];
  private statusListeners: EventCallback<WaStatusValue>[] = [];

  constructor(sessionDir = '.wa-sessions') {
    this.sessionDir = path.resolve(sessionDir);
  }

  status(): WaStatusValue { return this.currentStatus; }

  on(event: 'message',  cb: EventCallback<RawInboundMessage>): void;
  on(event: 'contact',  cb: EventCallback<RawContact>): void;
  on(event: 'qr',       cb: EventCallback<string>): void;
  on(event: 'status',   cb: EventCallback<WaStatusValue>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (data: any) => void): void {
    if (event === 'message') this.messageListeners.push(cb);
    if (event === 'contact') this.contactListeners.push(cb);
    if (event === 'qr')      this.qrListeners.push(cb);
    if (event === 'status')  this.statusListeners.push(cb);
  }

  private emit(event: 'message',  data: RawInboundMessage): void;
  private emit(event: 'contact',  data: RawContact): void;
  private emit(event: 'qr',       data: string): void;
  private emit(event: 'status',   data: WaStatusValue): void;
  private emit(event: string, data: unknown): void {
    if (event === 'message') this.messageListeners.forEach(cb => cb(data as RawInboundMessage));
    if (event === 'contact') this.contactListeners.forEach(cb => cb(data as RawContact));
    if (event === 'qr')      this.qrListeners.forEach(cb => cb(data as string));
    if (event === 'status')  this.statusListeners.forEach(cb => cb(data as WaStatusValue));
  }

  async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.manuallyDisconnected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try { this.sock.end(undefined); } catch {}
      this.sock = null;
    }

    console.log('[Baileys] Inicializando sessão em', this.sessionDir);
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      version = result.version;
    } catch {
      console.log('[Baileys] Usando versão fallback:', version);
    }

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['LinguaFlow', 'Chrome', '120.0.0'],
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 500,
      connectTimeoutMs: 30_000,
      syncFullHistory: true,
      getMessage: async () => undefined,
    });

    this.connecting = false;

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[Baileys] QR gerado');
        const dataUrl = await qrcode.toDataURL(qr);
        this.emit('qr', dataUrl);
      }

      if (connection === 'open') {
        console.log('[Baileys] ✅ WhatsApp conectado!');
        this.currentStatus = 'open';
        this.emit('status', 'open');
      }

      if (connection === 'connecting') {
        this.currentStatus = 'connecting';
        this.emit('status', 'connecting');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        console.log('[Baileys] Conexão fechada. Código:', statusCode);
        this.currentStatus = 'close';
        this.emit('status', 'close');

        if (this.manuallyDisconnected) return;

        const noReconnect = [
          DisconnectReason.loggedOut,
          DisconnectReason.connectionReplaced,
          DisconnectReason.badSession,
        ] as number[];

        if (noReconnect.includes(statusCode as number)) return;

        const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 4000;
        console.log(`[Baileys] Reconectando em ${delay}ms...`);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });

    // ── Sync existing chats (contacts) ────────────────────────────────────
    this.sock.ev.on('chats.upsert', (chats) => {
      let discovered = 0;
      for (const chat of chats) {
        const jid = chat.id ?? '';
        if (!jid.endsWith('@s.whatsapp.net')) continue; // only real phone JIDs
        const phone = jid.replace('@s.whatsapp.net', '');
        if (!phone) continue;
        this.emit('contact', { phone, name: chat.name ?? undefined });
        discovered++;
      }
      if (discovered > 0) console.log(`[Baileys] ${discovered} contatos via chats.upsert`);
    });

    // ── Sync existing contacts from WA address book ───────────────────────
    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        const jid = c.id ?? '';
        if (!jid.endsWith('@s.whatsapp.net')) continue;
        const phone = jid.replace('@s.whatsapp.net', '');
        if (!phone) continue;
        const name = c.name ?? c.notify ?? undefined;
        this.emit('contact', { phone, name });
      }
    });

    // ── Sync message history (last 30 days) ───────────────────────────────
    this.sock.ev.on('messaging-history.set', ({ messages: histMsgs, isLatest }) => {
      const cutoff = Date.now() - HISTORY_WINDOW_MS;
      let synced = 0;

      console.log(`[Baileys] messaging-history.set: ${histMsgs.length} msgs, isLatest=${isLatest}`);

      for (const msg of histMsgs) {
        if (!msg.message) continue;

        const ts = Number(msg.messageTimestamp) * 1000;
        if (ts < cutoff) continue;

        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          null;
        if (!text) continue;

        const remoteJid = msg.key.remoteJid ?? '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue; // only real phone JIDs

        const fromPhone = remoteJid.replace('@s.whatsapp.net', '');
        if (!fromPhone) continue;

        this.emit('message', {
          waMessageId: msg.key.id ?? `hist_${ts}_${synced}`,
          fromPhone,
          fromName: undefined,
          text,
          timestamp: ts,
          fromMe: msg.key.fromMe ?? false,
        });
        synced++;
      }

      if (synced > 0) {
        console.log(`[Baileys] Sincronizadas ${synced} mensagens do histórico`);
      }
    });

    // ── Live messages ────────────────────────────────────────────────────
    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          null;
        if (!text) continue;

        const remoteJid = msg.key.remoteJid ?? '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue;

        const fromPhone  = remoteJid.replace('@s.whatsapp.net', '');
        const fromName   = msg.pushName ?? undefined;
        const waMessageId = msg.key.id ?? `${Date.now()}`;
        const timestamp  = Number(msg.messageTimestamp) * 1000;
        const fromMe     = msg.key.fromMe ?? false;

        this.emit('message', { waMessageId, fromPhone, fromName, text, timestamp, fromMe });
      }
    });
  }

  async disconnect(): Promise<void> {
    this.manuallyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.sock?.logout();
    } catch {
      this.sock?.end(undefined);
    }
    this.sock = null;
    this.currentStatus = 'close';
    this.emit('status', 'close');
  }

  async sendMessage(phone: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await this.sock.sendMessage(jid, { text });
  }
}
