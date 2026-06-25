import type { WhatsAppAdapter, RawInboundMessage, RawContact, WaStatusValue } from './WhatsAppAdapter.js';

type EventCallback<T> = (data: T) => void;

interface CloudApiMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface CloudApiContact {
  wa_id: string;
  profile: { name: string };
}

interface CloudApiWebhookValue {
  messaging_product: string;
  metadata: { phone_number_id: string };
  messages?: CloudApiMessage[];
  contacts?: CloudApiContact[];
  statuses?: Array<{ id: string; status: string; timestamp: string; recipient_id: string }>;
}

export interface CloudApiWebhookBody {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{ field: string; value: CloudApiWebhookValue }>;
  }>;
}

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

export class CloudApiAdapter implements WhatsAppAdapter {
  private phoneNumberId: string;
  private token: string;
  private _status: WaStatusValue = 'close';

  private messageListeners: EventCallback<RawInboundMessage>[] = [];
  private contactListeners: EventCallback<RawContact>[] = [];
  private qrListeners: EventCallback<string>[] = [];
  private statusListeners: EventCallback<WaStatusValue>[] = [];

  constructor(phoneNumberId: string, token: string) {
    this.phoneNumberId = phoneNumberId;
    this.token = token;
  }

  status(): WaStatusValue { return this._status; }

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
    this._status = 'connecting';
    this.emit('status', 'connecting');

    try {
      const res = await fetch(`${GRAPH_URL}/${this.phoneNumberId}?fields=display_phone_number,verified_name`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(`Cloud API auth error: ${body?.error?.message ?? res.status}`);
      }

      const info = await res.json() as { display_phone_number?: string; verified_name?: string };
      console.log(`[CloudAPI] Connected: ${info.verified_name} (${info.display_phone_number})`);
      this._status = 'open';
      this.emit('status', 'open');
    } catch (err) {
      this._status = 'close';
      this.emit('status', 'close');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this._status = 'close';
    this.emit('status', 'close');
  }

  async sendMessage(phone: string, text: string): Promise<void> {
    // Normalize: strip + and non-digits for Meta API
    const to = phone.replace(/[^\d]/g, '');
    if (!to) throw new Error(`Invalid phone number: ${phone}`);

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
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string; code?: number } };
      throw new Error(`Cloud API send error ${res.status}: ${err?.error?.message ?? 'unknown'} (code ${err?.error?.code})`);
    }
  }

  // Called by the webhook handler in index.ts
  processWebhook(body: CloudApiWebhookBody): void {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        // Build name lookup from contacts array
        const nameMap = new Map<string, string>();
        for (const c of value.contacts ?? []) {
          nameMap.set(c.wa_id, c.profile.name);
        }

        // Emit discovered contacts
        for (const c of value.contacts ?? []) {
          this.emit('contact', { phone: c.wa_id, name: c.profile.name });
        }

        // Emit inbound text messages
        for (const msg of value.messages ?? []) {
          if (msg.type !== 'text' || !msg.text?.body) continue;

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
