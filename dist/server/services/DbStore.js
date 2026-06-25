import { v4 as uuid } from 'uuid';
const DEFAULT_LISTS = [
    { id: 'list_incoming', name: 'Cliente a caminho', color: '#3B82F6', order: 0, isSystem: true },
    { id: 'list_active', name: 'Em atendimento', color: '#06B6D4', order: 1, isSystem: true },
    { id: 'list_interest', name: 'Cliente interessado', color: '#8B5CF6', order: 2, isSystem: true },
    { id: 'list_done', name: 'Já foi atendido', color: '#10B981', order: 3, isSystem: true },
];
export class DbStore {
    constructor() {
        this.contacts = new Map();
        this.messages = new Map();
        this.lists = new Map();
        this.waMessageIndex = new Set();
        this.contactCounter = 0;
        DEFAULT_LISTS.forEach(l => this.lists.set(l.id, l));
    }
    nextContactName() {
        this.contactCounter++;
        return `Contato ${this.contactCounter}`;
    }
    // ─── Lists ───────────────────────────────────────────────────────────────
    allLists() {
        return Array.from(this.lists.values()).sort((a, b) => a.order - b.order);
    }
    saveList(data) {
        const id = uuid();
        const list = { ...data, id, order: this.lists.size };
        this.lists.set(id, list);
        return list;
    }
    updateList(id, patch) {
        const list = this.lists.get(id);
        if (!list)
            return null;
        const updated = { ...list, ...patch };
        this.lists.set(id, updated);
        return updated;
    }
    deleteList(id) {
        const list = this.lists.get(id);
        if (!list || list.isSystem)
            return false;
        this.lists.delete(id);
        this.contacts.forEach(c => {
            if (c.listId === id)
                this.contacts.set(c.id, { ...c, listId: 'list_incoming' });
        });
        return true;
    }
    // ─── Contacts ────────────────────────────────────────────────────────────
    getContact(id) {
        return this.contacts.get(id);
    }
    getContactByPhone(phone) {
        for (const c of this.contacts.values()) {
            if (c.phone === phone)
                return c;
        }
        return undefined;
    }
    saveContact(data) {
        const id = uuid();
        const contact = { ...data, id, createdAt: Date.now(), unread: 0, notes: [] };
        this.contacts.set(id, contact);
        return contact;
    }
    updateContact(id, patch) {
        const contact = this.contacts.get(id);
        if (!contact)
            return null;
        const updated = { ...contact, ...patch };
        this.contacts.set(id, updated);
        return updated;
    }
    touchContact(id, ts) {
        const c = this.contacts.get(id);
        if (!c)
            return;
        this.contacts.set(id, { ...c, lastMessageAt: ts, unread: c.unread + 1 });
    }
    markRead(id) {
        const c = this.contacts.get(id);
        if (!c)
            return;
        this.contacts.set(id, { ...c, unread: 0 });
    }
    allContacts() {
        return Array.from(this.contacts.values())
            .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    }
    addNote(contactId, text) {
        const c = this.contacts.get(contactId);
        if (!c)
            return null;
        const note = { id: uuid(), text, createdAt: Date.now() };
        const updated = { ...c, notes: [...(c.notes ?? []), note] };
        this.contacts.set(contactId, updated);
        return updated;
    }
    removeNote(contactId, noteId) {
        const c = this.contacts.get(contactId);
        if (!c)
            return null;
        const updated = { ...c, notes: (c.notes ?? []).filter(n => n.id !== noteId) };
        this.contacts.set(contactId, updated);
        return updated;
    }
    // ─── Messages ────────────────────────────────────────────────────────────
    saveMessage(msg) {
        const list = this.messages.get(msg.contactId) ?? [];
        list.push(msg);
        this.messages.set(msg.contactId, list);
        if (msg.waMessageId)
            this.waMessageIndex.add(msg.waMessageId);
        return msg;
    }
    isDuplicateWaMessage(waMessageId) {
        return this.waMessageIndex.has(waMessageId);
    }
    getMessages(contactId) {
        return this.messages.get(contactId) ?? [];
    }
    allMessagesGrouped() {
        const result = {};
        this.messages.forEach((msgs, contactId) => { result[contactId] = msgs; });
        return result;
    }
    updateMessage(contactId, messageId, patch) {
        const list = this.messages.get(contactId);
        if (!list)
            return;
        const idx = list.findIndex(m => m.id === messageId);
        if (idx === -1)
            return;
        list[idx] = { ...list[idx], ...patch };
    }
}
