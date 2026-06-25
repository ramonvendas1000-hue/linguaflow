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

// Shared event log accessible for debug
export const eventLog: { ts: number; event: string; detail: string }[] = [];
function logEvent(event: string, detail: string) {
  eventLog.push({ ts: Date.now(), event, detail });
  if (eventLog.length > 200) eventLog.shift();
  console.log(`[Baileys] ${event}: ${detail}`);
}

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
        logEvent('qr', 'QR gerado');
        const dataUrl = await qrcode.toDataURL(qr);
        this.emit('qr', dataUrl);
      }

      if (connection === 'open') {
        logEvent('connection', 'OPEN — WhatsApp conectado!');
        this.currentStatus = 'open';
        this.emit('status', 'open');
      }

      if (connection === 'connecting') {
        this.currentStatus = 'connecting';
        this.emit('status', 'connecting');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        logEvent('connection', `CLOSE code=${statusCode}`);
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

    // ── Shared JID resolver (handles @s.whatsapp.net AND @lid) ──────────────
    // lidToPhone is built from contacts that have both @lid and @s.whatsapp.net
    const lidToPhone = new Map<string, string>(); // "@lid jid" → phone number

    // Returns a stable identifier for the contact — prefer real phone (@s.whatsapp.net),
    // fall back to the resolved lid→phone mapping, or store the @lid JID as-is.
    function resolveJid(jid: string): string | null {
      if (!jid) return null;
      if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '');
      if (jid.endsWith('@lid')) {
        // If we have a phone mapping, use the real phone number
        const phone = lidToPhone.get(jid);
        if (phone) return phone;
        // Otherwise store full @lid JID so we can still send messages
        return jid;
      }
      return null; // group, broadcast, etc.
    }

    // ── Sync existing chats (contacts) ────────────────────────────────────
    this.sock.ev.on('chats.upsert', (chats) => {
      logEvent('chats.upsert', `total=${chats.length}, sample=${JSON.stringify(chats.slice(0,3).map(c => c.id))}`);
      let discovered = 0;
      for (const chat of chats) {
        const phone = resolveJid(chat.id ?? '');
        if (!phone) continue;
        this.emit('contact', { phone, name: chat.name ?? undefined });
        discovered++;
      }
      logEvent('chats.upsert', `discovered ${discovered} contacts`);
    });

    // ── Sync existing contacts from WA address book ───────────────────────
    this.sock.ev.on('contacts.upsert', (contacts) => {
      logEvent('contacts.upsert', `total=${contacts.length}`);
      // First pass: build lid → phone map
      for (const c of contacts) {
        const jid = c.id ?? '';
        if (jid.endsWith('@s.whatsapp.net') && c.lid) {
          const lidStr = String(c.lid);
          lidToPhone.set(lidStr.includes('@') ? lidStr : `${lidStr}@lid`, jid.replace('@s.whatsapp.net', ''));
        }
      }
      // Second pass: emit contacts
      for (const c of contacts) {
        const phone = resolveJid(c.id ?? '');
        if (!phone) continue;
        const name = c.name ?? c.notify ?? undefined;
        this.emit('contact', { phone, name });
      }
    });

    // ── Sync message history (last 30 days) ───────────────────────────────
    this.sock.ev.on('messaging-history.set', ({ messages: histMsgs, chats: histChats, contacts: histContacts, isLatest }) => {
      const cutoff = Date.now() - HISTORY_WINDOW_MS;
      let synced = 0;

      logEvent('messaging-history.set', `msgs=${histMsgs?.length}, chats=${histChats?.length ?? 0}, contacts=${histContacts?.length ?? 0}, isLatest=${isLatest}, contactSample=${JSON.stringify(histContacts?.slice(0,3).map(c => ({id:c.id,lid:c.lid,name:c.name,notify:c.notify})))}`);

      // First pass: build lid → phone map from contacts
      for (const c of histContacts ?? []) {
        const jid = c.id ?? '';
        if (jid.endsWith('@s.whatsapp.net') && c.lid) {
          const lidStr = String(c.lid);
          lidToPhone.set(lidStr.includes('@') ? lidStr : `${lidStr}@lid`, jid.replace('@s.whatsapp.net', ''));
        }
      }

      logEvent('messaging-history.set', `lid map size: ${lidToPhone.size}`);

      // Emit contacts from address book
      for (const c of histContacts ?? []) {
        const phone = resolveJid(c.id ?? '');
        if (!phone) continue;
        const name = c.name ?? c.notify ?? undefined;
        this.emit('contact', { phone, name });
      }

      // Emit contacts from chats
      for (const chat of histChats ?? []) {
        const phone = resolveJid(chat.id ?? '');
        if (!phone) continue;
        this.emit('contact', { phone, name: chat.name ?? undefined });
      }

      // Build pushName map from inbound messages (only way to get contact names from @lid)
      const lidToName = new Map<string, string>();
      for (const msg of histMsgs) {
        if (!msg.key.fromMe && msg.pushName) {
          const jid = msg.key.remoteJid ?? '';
          if (!lidToName.has(jid)) lidToName.set(jid, msg.pushName);
        }
      }
      logEvent('messaging-history.set', `pushName map: ${lidToName.size} entries`);

      // Re-emit contacts now that we have names from pushName
      for (const chat of histChats ?? []) {
        const jid = chat.id ?? '';
        const phone = resolveJid(jid);
        if (!phone) continue;
        const name = chat.name ?? lidToName.get(jid) ?? undefined;
        this.emit('contact', { phone, name });
      }

      // Sync messages
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
        const fromPhone = resolveJid(remoteJid);
        if (!fromPhone) continue;

        // Use pushName for inbound; for outbound fromMe msgs no pushName exists
        const fromName = msg.key.fromMe ? undefined : (msg.pushName ?? lidToName.get(remoteJid));

        this.emit('message', {
          waMessageId: msg.key.id ?? `hist_${ts}_${synced}`,
          fromPhone,
          fromName: fromName ?? undefined,
          text,
          timestamp: ts,
          fromMe: msg.key.fromMe ?? false,
        });
        synced++;
      }

      logEvent('messaging-history.set', `emitted ${synced} messages`);
    });

    // ── Live messages ────────────────────────────────────────────────────
    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          null;
        if (!text) continue;

        const fromPhone = resolveJid(msg.key.remoteJid ?? '');
        if (!fromPhone) continue;

        const fromName    = msg.pushName ?? undefined;
        const waMessageId = msg.key.id ?? `${Date.now()}`;
        const timestamp   = Number(msg.messageTimestamp) * 1000;
        const fromMe      = msg.key.fromMe ?? false;

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
    if (!this.sock) throw new Error('WhatsApp não conectado');

    // Normalize phone to JID
    // Accepts: @lid JIDs, @s.whatsapp.net JIDs, or plain digits
    let jid: string;
    if (phone.includes('@')) {
      jid = phone; // already a JID (@lid or @s.whatsapp.net)
    } else {
      // Plain number — strip non-digits and build @s.whatsapp.net
      const digits = phone.replace(/\D/g, '');
      jid = `${digits}@s.whatsapp.net`;
    }

    logEvent('sendMessage', `to=${jid} text="${text.slice(0, 40)}"`);

    try {
      const result = await this.sock.sendMessage(jid, { text });
      logEvent('sendMessage', `OK msgId=${result?.key?.id ?? 'unknown'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('sendMessage', `ERROR: ${msg}`);
      throw new Error(`Falha ao enviar: ${msg}`);
    }
  }
}
