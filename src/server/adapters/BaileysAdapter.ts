import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import path from 'path';
import pino from 'pino';
import type { WhatsAppAdapter, RawInboundMessage, WaStatusValue } from './WhatsAppAdapter.js';

type EventCallback<T> = (data: T) => void;

export class BaileysAdapter implements WhatsAppAdapter {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private currentStatus: WaStatusValue = 'close';
  private sessionDir: string;

  private messageListeners: EventCallback<RawInboundMessage>[] = [];
  private qrListeners: EventCallback<string>[] = [];
  private statusListeners: EventCallback<WaStatusValue>[] = [];

  constructor(sessionDir = '.wa-sessions') {
    this.sessionDir = path.resolve(sessionDir);
  }

  status(): WaStatusValue {
    return this.currentStatus;
  }

  on(event: 'message', cb: EventCallback<RawInboundMessage>): void;
  on(event: 'qr', cb: EventCallback<string>): void;
  on(event: 'status', cb: EventCallback<WaStatusValue>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (data: any) => void): void {
    if (event === 'message') this.messageListeners.push(cb as EventCallback<RawInboundMessage>);
    if (event === 'qr') this.qrListeners.push(cb as EventCallback<string>);
    if (event === 'status') this.statusListeners.push(cb as EventCallback<WaStatusValue>);
  }

  private emit(event: 'message', data: RawInboundMessage): void;
  private emit(event: 'qr', data: string): void;
  private emit(event: 'status', data: WaStatusValue): void;
  private emit(event: string, data: unknown): void {
    if (event === 'message') this.messageListeners.forEach(cb => cb(data as RawInboundMessage));
    if (event === 'qr') this.qrListeners.forEach(cb => cb(data as string));
    if (event === 'status') this.statusListeners.forEach(cb => cb(data as WaStatusValue));
  }

  async connect(): Promise<void> {
    console.log('[Baileys] Inicializando sessão em', this.sessionDir);
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      console.log('[Baileys] Buscando versão mais recente do WhatsApp...');
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 8000)
        ),
      ]);
      version = result.version;
      console.log('[Baileys] Versão obtida:', version);
    } catch {
      console.log('[Baileys] Usando versão fallback:', version);
    }

    console.log('[Baileys] Criando socket...');
    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['LinguaFlow', 'Chrome', '120.0.0'],
    });
    console.log('[Baileys] Socket criado, aguardando eventos...');

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[Baileys] QR gerado — escaneie com o WhatsApp');
        const dataUrl = await qrcode.toDataURL(qr);
        this.emit('qr', dataUrl);
      }

      if (connection === 'open') {
        console.log('[Baileys] ✅ WhatsApp conectado!');
        this.currentStatus = 'open';
        this.emit('status', 'open');
      }

      if (connection === 'connecting') {
        console.log('[Baileys] Conectando ao WhatsApp...');
        this.currentStatus = 'connecting';
        this.emit('status', 'connecting');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        console.log('[Baileys] Conexão fechada. Código:', statusCode);
        this.currentStatus = 'close';
        this.emit('status', 'close');

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('[Baileys] Reconectando em 3s...');
          setTimeout(() => this.connect(), 3000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          null;

        if (!text) continue;

        const fromPhone = (msg.key.remoteJid ?? '').replace('@s.whatsapp.net', '');
        const fromName = msg.pushName ?? undefined;
        const waMessageId = msg.key.id ?? `${Date.now()}`;
        const timestamp = (msg.messageTimestamp as number) * 1000;

        this.emit('message', { waMessageId, fromPhone, fromName, text, timestamp });
      }
    });
  }

  async disconnect(): Promise<void> {
    await this.sock?.logout();
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
