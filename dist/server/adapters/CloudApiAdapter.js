const GRAPH_URL = 'https://graph.facebook.com/v19.0';
export class CloudApiAdapter {
    constructor(phoneNumberId, token) {
        this._status = 'close';
        this.messageListeners = [];
        this.contactListeners = [];
        this.qrListeners = [];
        this.statusListeners = [];
        this.phoneNumberId = phoneNumberId;
        this.token = token;
    }
    status() { return this._status; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event, cb) {
        if (event === 'message')
            this.messageListeners.push(cb);
        if (event === 'contact')
            this.contactListeners.push(cb);
        if (event === 'qr')
            this.qrListeners.push(cb);
        if (event === 'status')
            this.statusListeners.push(cb);
    }
    emit(event, data) {
        if (event === 'message')
            this.messageListeners.forEach(cb => cb(data));
        if (event === 'contact')
            this.contactListeners.forEach(cb => cb(data));
        if (event === 'qr')
            this.qrListeners.forEach(cb => cb(data));
        if (event === 'status')
            this.statusListeners.forEach(cb => cb(data));
    }
    async connect() {
        this._status = 'connecting';
        this.emit('status', 'connecting');
        try {
            const res = await fetch(`${GRAPH_URL}/${this.phoneNumberId}?fields=display_phone_number,verified_name`, {
                headers: { 'Authorization': `Bearer ${this.token}` },
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(`Cloud API auth error: ${body?.error?.message ?? res.status}`);
            }
            const info = await res.json();
            console.log(`[CloudAPI] Connected: ${info.verified_name} (${info.display_phone_number})`);
            this._status = 'open';
            this.emit('status', 'open');
        }
        catch (err) {
            this._status = 'close';
            this.emit('status', 'close');
            throw err;
        }
    }
    async disconnect() {
        this._status = 'close';
        this.emit('status', 'close');
    }
    async sendMessage(phone, text) {
        // Normalize: strip + and non-digits for Meta API
        const to = phone.replace(/[^\d]/g, '');
        if (!to)
            throw new Error(`Invalid phone number: ${phone}`);
        const res = await fetch(`${GRAPH_URL}/${this.phoneNumberId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'text',
                text: { body: text, preview_url: false },
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Cloud API send error ${res.status}: ${err?.error?.message ?? 'unknown'} (code ${err?.error?.code})`);
        }
    }
    // Called by the webhook handler in index.ts
    processWebhook(body) {
        for (const entry of body.entry ?? []) {
            for (const change of entry.changes ?? []) {
                if (change.field !== 'messages')
                    continue;
                const value = change.value;
                // Build name lookup from contacts array
                const nameMap = new Map();
                for (const c of value.contacts ?? []) {
                    nameMap.set(c.wa_id, c.profile.name);
                }
                // Emit discovered contacts
                for (const c of value.contacts ?? []) {
                    this.emit('contact', { phone: c.wa_id, name: c.profile.name });
                }
                // Emit inbound text messages
                for (const msg of value.messages ?? []) {
                    if (msg.type !== 'text' || !msg.text?.body)
                        continue;
                    this.emit('message', {
                        waMessageId: msg.id,
                        fromPhone: msg.from,
                        fromName: nameMap.get(msg.from),
                        text: msg.text.body,
                        timestamp: parseInt(msg.timestamp, 10) * 1000,
                        fromMe: false,
                    });
                }
            }
        }
    }
}
