import { v4 as uuid } from 'uuid';
import type { Contact, Message, CrmList, ContactNote } from '../../types/index.js';

const DEFAULT_LISTS: CrmList[] = [
  { id: 'list_incoming', name: 'Cliente a caminho',    color: '#3B82F6', order: 0, isSystem: true },
  { id: 'list_active',   name: 'Em atendimento',       color: '#06B6D4', order: 1, isSystem: true },
  { id: 'list_interest', name: 'Cliente interessado',  color: '#8B5CF6', order: 2, isSystem: true },
  { id: 'list_done',     name: 'Já foi atendido',      color: '#10B981', order: 3, isSystem: true },
];

export class DbStore {
  private contacts = new Map<string, Contact>();
  private messages  = new Map<string, Message[]>();
  private lists     = new Map<string, CrmList>();
  private waMessageIndex = new Set<string>();

  constructor() {
    DEFAULT_LISTS.forEach(l => this.lists.set(l.id, l));
  }

  // ─── Lists ───────────────────────────────────────────────────────────────
  allLists(): CrmList[] {
    return Array.from(this.lists.values()).sort((a, b) => a.order - b.order);
  }

  saveList(data: Omit<CrmList, 'id' | 'order'>): CrmList {
    const id = uuid();
    const list: CrmList = { ...data, id, order: this.lists.size };
    this.lists.set(id, list);
    return list;
  }

  updateList(id: string, patch: Partial<CrmList>): CrmList | null {
    const list = this.lists.get(id);
    if (!list) return null;
    const updated = { ...list, ...patch };
    this.lists.set(id, updated);
    return updated;
  }

  deleteList(id: string): boolean {
    const list = this.lists.get(id);
    if (!list || list.isSystem) return false;
    this.lists.delete(id);
    this.contacts.forEach(c => {
      if (c.listId === id) this.contacts.set(c.id, { ...c, listId: 'list_incoming' });
    });
    return true;
  }

  // ─── Contacts ────────────────────────────────────────────────────────────
  getContact(id: string): Contact | undefined {
    return this.contacts.get(id);
  }

  getContactByPhone(phone: string): Contact | undefined {
    for (const c of this.contacts.values()) {
      if (c.phone === phone) return c;
    }
    return undefined;
  }

  saveContact(data: Omit<Contact, 'id' | 'createdAt' | 'unread'>): Contact {
    const id = uuid();
    const contact: Contact = { ...data, id, createdAt: Date.now(), unread: 0, notes: [] };
    this.contacts.set(id, contact);
    return contact;
  }

  updateContact(id: string, patch: Partial<Contact>): Contact | null {
    const contact = this.contacts.get(id);
    if (!contact) return null;
    const updated = { ...contact, ...patch };
    this.contacts.set(id, updated);
    return updated;
  }

  touchContact(id: string, ts: number): void {
    const c = this.contacts.get(id);
    if (!c) return;
    this.contacts.set(id, { ...c, lastMessageAt: ts, unread: c.unread + 1 });
  }

  markRead(id: string): void {
    const c = this.contacts.get(id);
    if (!c) return;
    this.contacts.set(id, { ...c, unread: 0 });
  }

  allContacts(): Contact[] {
    return Array.from(this.contacts.values())
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }

  addNote(contactId: string, text: string): Contact | null {
    const c = this.contacts.get(contactId);
    if (!c) return null;
    const note: ContactNote = { id: uuid(), text, createdAt: Date.now() };
    const updated = { ...c, notes: [...(c.notes ?? []), note] };
    this.contacts.set(contactId, updated);
    return updated;
  }

  removeNote(contactId: string, noteId: string): Contact | null {
    const c = this.contacts.get(contactId);
    if (!c) return null;
    const updated = { ...c, notes: (c.notes ?? []).filter(n => n.id !== noteId) };
    this.contacts.set(contactId, updated);
    return updated;
  }

  // ─── Messages ────────────────────────────────────────────────────────────
  saveMessage(msg: Message): Message {
    const list = this.messages.get(msg.contactId) ?? [];
    list.push(msg);
    this.messages.set(msg.contactId, list);
    if (msg.waMessageId) this.waMessageIndex.add(msg.waMessageId);
    return msg;
  }

  isDuplicateWaMessage(waMessageId: string): boolean {
    return this.waMessageIndex.has(waMessageId);
  }

  getMessages(contactId: string): Message[] {
    return this.messages.get(contactId) ?? [];
  }

  allMessagesGrouped(): Record<string, Message[]> {
    const result: Record<string, Message[]> = {};
    this.messages.forEach((msgs, contactId) => { result[contactId] = msgs; });
    return result;
  }

  updateMessage(contactId: string, messageId: string, patch: Partial<Message>): void {
    const list = this.messages.get(contactId);
    if (!list) return;
    const idx = list.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    list[idx] = { ...list[idx], ...patch };
  }
}
