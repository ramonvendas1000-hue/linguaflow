import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import path from 'path';
import pino from 'pino';
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export class BaileysAdapter {
    constructor(sessionDir = '.wa-sessions') {
        this.sock = null;
        this.currentStatus = 'close';
        this.manuallyDisconnected = false;
        this.connecting = false;
        this.reconnectTimer = null;
        this.messageListeners = [];
        this.qrListeners = [];
        this.statusListeners = [];
        this.sessionDir = path.resolve(sessionDir);
    }
    status() {
        return this.currentStatus;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event, cb) {
        if (event === 'message')
            this.messageListeners.push(cb);
        if (event === 'qr')
            this.qrListeners.push(cb);
        if (event === 'status')
            this.statusListeners.push(cb);
    }
    emit(event, data) {
        if (event === 'message')
            this.messageListeners.forEach(cb => cb(data));
        if (event === 'qr')
            this.qrListeners.forEach(cb => cb(data));
        if (event === 'status')
            this.statusListeners.forEach(cb => cb(data));
    }
    async connect() {
        if (this.connecting)
            return;
        this.connecting = true;
        this.manuallyDisconnected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Close any existing socket cleanly before reconnecting
        if (this.sock) {
            try {
                this.sock.end(undefined);
            }
            catch { }
            this.sock = null;
        }
        console.log('[Baileys] Inicializando sessão em', this.sessionDir);
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        let version = [2, 3000, 1015901307];
        try {
            const result = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
            ]);
            version = result.version;
        }
        catch {
            console.log('[Baileys] Usando versão fallback:', version);
        }
        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['LinguaFlow', 'Chrome', '120.0.0'],
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 500,
            connectTimeoutMs: 30000,
        });
        this.connecting = false;
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
                this.currentStatus = 'connecting';
                this.emit('status', 'connecting');
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log('[Baileys] Conexão fechada. Código:', statusCode);
                this.currentStatus = 'close';
                this.emit('status', 'close');
                if (this.manuallyDisconnected) {
                    console.log('[Baileys] Desconexão manual — não reconectando');
                    return;
                }
                const noReconnect = [
                    DisconnectReason.loggedOut,
                    DisconnectReason.connectionReplaced,
                    DisconnectReason.badSession,
                ];
                if (noReconnect.includes(statusCode)) {
                    console.log('[Baileys] Motivo de desconexão permanente:', statusCode);
                    return;
                }
                const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 4000;
                console.log(`[Baileys] Reconectando em ${delay}ms...`);
                this.reconnectTimer = setTimeout(() => this.connect(), delay);
            }
        });
        // Sync existing WhatsApp message history on connect
        this.sock.ev.on('messaging-history.set', ({ messages: histMsgs }) => {
            const cutoff = Date.now() - HISTORY_WINDOW_MS;
            let synced = 0;
            for (const msg of histMsgs) {
                if (msg.key.fromMe)
                    continue;
                if (!msg.message)
                    continue;
                const ts = Number(msg.messageTimestamp) * 1000;
                if (ts < cutoff)
                    continue;
                const text = msg.message.conversation ??
                    msg.message.extendedTextMessage?.text ??
                    null;
                if (!text)
                    continue;
                const remoteJid = msg.key.remoteJid ?? '';
                if (remoteJid.includes('@g.us'))
                    continue; // skip groups
                const fromPhone = remoteJid.replace('@s.whatsapp.net', '');
                if (!fromPhone)
                    continue;
                this.emit('message', {
                    waMessageId: msg.key.id ?? `hist_${Date.now()}_${synced}`,
                    fromPhone,
                    fromName: undefined,
                    text,
                    timestamp: ts,
                });
                synced++;
            }
            if (synced > 0) {
                console.log(`[Baileys] Sincronizadas ${synced} mensagens do histórico`);
            }
        });
        this.sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify')
                return;
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe)
                    continue;
                const text = msg.message.conversation ??
                    msg.message.extendedTextMessage?.text ??
                    null;
                if (!text)
                    continue;
                const fromPhone = (msg.key.remoteJid ?? '').replace('@s.whatsapp.net', '');
                const fromName = msg.pushName ?? undefined;
                const waMessageId = msg.key.id ?? `${Date.now()}`;
                const timestamp = Number(msg.messageTimestamp) * 1000;
                this.emit('message', { waMessageId, fromPhone, fromName, text, timestamp });
            }
        });
    }
    async disconnect() {
        this.manuallyDisconnected = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            await this.sock?.logout();
        }
        catch {
            this.sock?.end(undefined);
        }
        this.sock = null;
        this.currentStatus = 'close';
        this.emit('status', 'close');
    }
    async sendMessage(phone, text) {
        if (!this.sock)
            throw new Error('WhatsApp not connected');
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        await this.sock.sendMessage(jid, { text });
    }
}
