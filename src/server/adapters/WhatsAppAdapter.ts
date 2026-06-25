export interface RawInboundMessage {
  waMessageId: string;
  fromPhone: string;
  fromName?: string;
  text: string;
  timestamp: number;
  fromMe?: boolean;
}

export interface RawContact {
  phone: string;
  name?: string;
}

export type WaStatusValue = 'connecting' | 'open' | 'close';

export interface WhatsAppAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(phone: string, text: string): Promise<void>;
  on(event: 'message',  cb: (msg: RawInboundMessage) => void): void;
  on(event: 'contact',  cb: (c: RawContact) => void): void;
  on(event: 'qr',       cb: (qrDataUrl: string) => void): void;
  on(event: 'status',   cb: (status: WaStatusValue) => void): void;
  status(): WaStatusValue;
}
