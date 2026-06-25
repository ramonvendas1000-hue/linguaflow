import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import path from 'path';
import pino from 'pino';
export class BaileysAdapter {
    constructor(sessionDir = '.wa-sessions') {
        this.sock = null;
        this.currentStatus = 'close';
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
        console.log('[Baileys] Inicializando sessão em', this.sessionDir);
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        let version = [2, 3000, 1015901307];
        try {
            console.log('[Baileys] Buscando versão mais recente do WhatsApp...');
            const result = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
            ]);
            version = result.version;
            console.log('[Baileys] Versão obtida:', version);
        }
        catch {
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
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
                const timestamp = msg.messageTimestamp * 1000;
                this.emit('message', { waMessageId, fromPhone, fromName, text, timestamp });
            }
        });
    }
    async disconnect() {
        await this.sock?.logout();
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
