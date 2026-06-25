import { v4 as uuid } from 'uuid';
import type { Contact, Message, CrmList } from '../../types/index.js';

const contacts = new Map<string, Contact>();
const messages = new Map<string, Message[]>();
const lists = new Map<string, CrmList>();
const waMessageIndex = new Set<string>();

const DEFAULT_LISTS: CrmList[] = [
  { id: 'list_incoming', name: 'Cliente a caminho', color: '#3B82F6', order: 0, isSystem: true },
  { id: 'list_active',   name: 'Em atendimento',   color: '#06B6D4', order: 1, isSystem: true },
  { id: 'list_interest', name: 'Cliente interessado', color: '#8B5CF6', order: 2, isSystem: true },
  { id: 'list_done',     name: 'Já foi atendido',  color: '#10B981', order: 3, isSystem: true },
];

DEFAULT_LISTS.forEach(l => lists.set(l.id, l));

export function allLists(): CrmList[] {
  return Array.from(lists.values()).sort((a, b) => a.order - b.order);
}

export function saveList(data: Omit<CrmList, 'id' | 'order'>): CrmList {
  const id = uuid();
  const list: CrmList = { ...data, id, order: lists.size };
  lists.set(id, list);
  return list;
}

export function updateList(id: string, patch: Partial<CrmList>): CrmList | null {
  const list = lists.get(id);
  if (!list) return null;
  const updated = { ...list, ...patch };
  lists.set(id, updated);
  return updated;
}

export function deleteList(id: string): boolean {
  const list = lists.get(id);
  if (!list || list.isSystem) return false;
  lists.delete(id);
  contacts.forEach(c => {
    if (c.listId === id) {
      contacts.set(c.id, { ...c, listId: 'list_incoming' });
    }
  });
  return true;
}

export function getContact(id: string): Contact | undefined {
  return contacts.get(id);
}

export function getContactByPhone(phone: string): Contact | undefined {
  for (const c of contacts.values()) {
    if (c.phone === phone) return c;
  }
  return undefined;
}

export function saveContact(data: Omit<Contact, 'id' | 'createdAt' | 'unread'>): Contact {
  const id = uuid();
  const contact: Contact = { ...data, id, createdAt: Date.now(), unread: 0 };
  contacts.set(id, contact);
  return contact;
}

export function updateContact(id: string, patch: Partial<Contact>): Contact | null {
  const contact = contacts.get(id);
  if (!contact) return null;
  const updated = { ...contact, ...patch };
  contacts.set(id, updated);
  return updated;
}

export function touchContact(id: string, ts: number): void {
  const c = contacts.get(id);
  if (!c) return;
  contacts.set(id, { ...c, lastMessageAt: ts, unread: c.unread + 1 });
}

export function markRead(id: string): void {
  const c = contacts.get(id);
  if (!c) return;
  contacts.set(id, { ...c, unread: 0 });
}

export function allContacts(): Contact[] {
  return Array.from(contacts.values()).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}

export function saveMessage(msg: Message): Message {
  const list = messages.get(msg.contactId) ?? [];
  list.push(msg);
  messages.set(msg.contactId, list);
  if (msg.waMessageId) waMessageIndex.add(msg.waMessageId);
  return msg;
}

export function isDuplicateWaMessage(waMessageId: string): boolean {
  return waMessageIndex.has(waMessageId);
}

export function getMessages(contactId: string): Message[] {
  return messages.get(contactId) ?? [];
}

export function allMessagesGrouped(): Record<string, Message[]> {
  const result: Record<string, Message[]> = {};
  messages.forEach((msgs, contactId) => {
    result[contactId] = msgs;
  });
  return result;
}

export function updateMessage(contactId: string, messageId: string, patch: Partial<Message>): void {
  const list = messages.get(contactId);
  if (!list) return;
  const idx = list.findIndex(m => m.id === messageId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch };
}

export function seedContact(contact: Contact): void {
  contacts.set(contact.id, contact);
}

export function seedMessages(contactId: string, msgs: Message[]): void {
  messages.set(contactId, msgs);
}
