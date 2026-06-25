export type LangCode = 'pt' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'ja' | 'zh' | 'ru' | 'ar';
export type Direction = 'inbound' | 'outbound';
export type TranslationStatus = 'ok' | 'pending' | 'failed' | 'skipped';
export type WaStatus = 'disconnected' | 'connecting' | 'open' | 'close';

export interface ContactNote {
  id: string;
  text: string;
  createdAt: number;
}

export interface Message {
  id: string;
  contactId: string;
  direction: Direction;
  originalText: string;
  originalLang: LangCode;
  translatedText: string;
  translatedLang: LangCode;
  translationStatus: TranslationStatus;
  translationProvider?: 'deepl' | 'openai' | 'google' | 'mock';
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
  notes?: ContactNote[];
}

export interface CrmList {
  id: string;
  name: string;
  color: string;
  order: number;
  isSystem?: boolean;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}
