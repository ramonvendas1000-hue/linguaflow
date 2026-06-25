export type LangCode = 'pt' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'ja' | 'zh' | 'ru' | 'ar';
export type Direction = 'inbound' | 'outbound';
export type TranslationStatus = 'ok' | 'pending' | 'failed' | 'skipped';
export type WaStatus = 'disconnected' | 'connecting' | 'open' | 'close';

export interface Message {
  id: string;
  contactId: string;
  direction: Direction;
  originalText: string;
  originalLang: LangCode;
  translatedText: string;
  translatedLang: LangCode;
  translationStatus: TranslationStatus;
  translationProvider?: 'deepl' | 'openai' | 'mock';
  timestamp: number;
  delivered?: boolean;
  read?: boolean;
  waMessageId?: string;
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  currentLang: LangCode;
  autoDetectLang: boolean;
  listId: string;
  country?: string;
  timezone?: string;
  online?: boolean;
  unread: number;
  lastMessageAt?: number;
  createdAt: number;
}

export interface CrmList {
  id: string;
  name: string;
  color: string;
  order: number;
  isSystem?: boolean;
}
