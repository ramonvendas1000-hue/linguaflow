export interface RawInboundMessage {
  waMessageId: string;
  fromPhone: string;
  fromName?: string;
  text: string;
  timestamp: number;
}

export type WaEvent = 'message' | 'qr' | 'status';
export type WaStatusValue = 'connecting' | 'open' | 'close';

export interface WhatsAppAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(phone: string, text: string): Promise<void>;
  on(event: 'message', cb: (msg: RawInboundMessage) => void): void;
  on(event: 'qr', cb: (qrDataUrl: string) => void): void;
  on(event: 'status', cb: (status: WaStatusValue) => void): void;
  status(): WaStatusValue;
}
