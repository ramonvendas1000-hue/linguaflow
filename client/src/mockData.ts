import type { Contact, Message, CrmList } from './types';

export const mockLists: CrmList[] = [
  { id: 'list_incoming', name: 'Cliente a caminho',    color: '#3B82F6', order: 0, isSystem: true },
  { id: 'list_active',   name: 'Em atendimento',       color: '#06B6D4', order: 1, isSystem: true },
  { id: 'list_interest', name: 'Cliente interessado',  color: '#8B5CF6', order: 2, isSystem: true },
  { id: 'list_done',     name: 'Já foi atendido',      color: '#10B981', order: 3, isSystem: true },
];

const now = Date.now();

export const mockContacts: Contact[] = [
  {
    id: 'contact_1', name: 'Sarah Johnson', phone: '15551234567',
    currentLang: 'en', autoDetectLang: false, listId: 'list_active',
    country: 'US', online: true, unread: 2,
    lastMessageAt: now - 60000, createdAt: now - 86400000,
  },
  {
    id: 'contact_2', name: 'Carlos Méndez', phone: '5491155556789',
    currentLang: 'es', autoDetectLang: false, listId: 'list_incoming',
    country: 'AR', online: false, unread: 0,
    lastMessageAt: now - 3600000, createdAt: now - 172800000,
  },
  {
    id: 'contact_3', name: 'Hans Müller', phone: '4915112345678',
    currentLang: 'de', autoDetectLang: false, listId: 'list_interest',
    country: 'DE', online: false, unread: 1,
    lastMessageAt: now - 7200000, createdAt: now - 259200000,
  },
  {
    id: 'contact_4', name: 'Giulia Rossi', phone: '393331234567',
    currentLang: 'it', autoDetectLang: false, listId: 'list_done',
    country: 'IT', online: true, unread: 0,
    lastMessageAt: now - 14400000, createdAt: now - 345600000,
  },
];

export const mockMessages: Record<string, Message[]> = {
  contact_1: [
    {
      id: 'msg_1_1', contactId: 'contact_1', direction: 'inbound',
      originalText: 'Hello! I need help with my order. It hasn\'t arrived yet.',
      originalLang: 'en',
      translatedText: 'Olá! Preciso de ajuda com meu pedido. Ele ainda não chegou.',
      translatedLang: 'pt', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 300000,
    },
    {
      id: 'msg_1_2', contactId: 'contact_1', direction: 'outbound',
      originalText: 'Olá Sarah! Vou verificar o status do seu pedido agora mesmo.',
      originalLang: 'pt',
      translatedText: 'Hello Sarah! I\'ll check the status of your order right now.',
      translatedLang: 'en', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 240000, delivered: true,
    },
    {
      id: 'msg_1_3', contactId: 'contact_1', direction: 'inbound',
      originalText: 'Thank you! The order number is #45231.',
      originalLang: 'en',
      translatedText: 'Obrigada! O número do pedido é #45231.',
      translatedLang: 'pt', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 120000,
    },
    {
      id: 'msg_1_4', contactId: 'contact_1', direction: 'inbound',
      originalText: 'Is there any update on when it will be delivered?',
      originalLang: 'en',
      translatedText: 'Há alguma atualização sobre quando será entregue?',
      translatedLang: 'pt', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 60000,
    },
  ],
  contact_2: [
    {
      id: 'msg_2_1', contactId: 'contact_2', direction: 'inbound',
      originalText: 'Hola, tengo una consulta sobre los precios de sus productos.',
      originalLang: 'es',
      translatedText: 'Olá, tenho uma dúvida sobre os preços dos seus produtos.',
      translatedLang: 'pt', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 3600000,
    },
    {
      id: 'msg_2_2', contactId: 'contact_2', direction: 'outbound',
      originalText: 'Olá Carlos! Claro, posso te ajudar com informações sobre os preços.',
      originalLang: 'pt',
      translatedText: '¡Hola Carlos! Claro, puedo ayudarte con información sobre los precios.',
      translatedLang: 'es', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 3540000, delivered: true,
    },
  ],
  contact_3: [
    {
      id: 'msg_3_1', contactId: 'contact_3', direction: 'inbound',
      originalText: 'Guten Tag, ich interessiere mich für Ihre Produkte.',
      originalLang: 'de',
      translatedText: 'Bom dia, tenho interesse nos seus produtos.',
      translatedLang: 'pt', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 7200000,
    },
  ],
  contact_4: [
    {
      id: 'msg_4_1', contactId: 'contact_4', direction: 'inbound',
      originalText: 'Grazie per il vostro servizio eccellente!',
      originalLang: 'it',
      translatedText: 'Obrigado pelo seu excelente serviço!',
      translatedLang: 'pt', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 14400000,
    },
    {
      id: 'msg_4_2', contactId: 'contact_4', direction: 'outbound',
      originalText: 'Obrigado, Giulia! Fico feliz que tenha gostado do nosso atendimento.',
      originalLang: 'pt',
      translatedText: 'Grazie, Giulia! Sono felice che tu abbia apprezzato il nostro servizio.',
      translatedLang: 'it', translationStatus: 'ok', translationProvider: 'mock',
      timestamp: now - 14340000, delivered: true,
    },
  ],
};
