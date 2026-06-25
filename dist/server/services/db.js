import { v4 as uuid } from 'uuid';
const contacts = new Map();
const messages = new Map();
const lists = new Map();
const waMessageIndex = new Set();
const DEFAULT_LISTS = [
    { id: 'list_incoming', name: 'Cliente a caminho', color: '#3B82F6', order: 0, isSystem: true },
    { id: 'list_active', name: 'Em atendimento', color: '#06B6D4', order: 1, isSystem: true },
    { id: 'list_interest', name: 'Cliente interessado', color: '#8B5CF6', order: 2, isSystem: true },
    { id: 'list_done', name: 'Já foi atendido', color: '#10B981', order: 3, isSystem: true },
];
DEFAULT_LISTS.forEach(l => lists.set(l.id, l));
export function allLists() {
    return Array.from(lists.values()).sort((a, b) => a.order - b.order);
}
export function saveList(data) {
    const id = uuid();
    const list = { ...data, id, order: lists.size };
    lists.set(id, list);
    return list;
}
export function updateList(id, patch) {
    const list = lists.get(id);
    if (!list)
        return null;
    const updated = { ...list, ...patch };
    lists.set(id, updated);
    return updated;
}
export function deleteList(id) {
    const list = lists.get(id);
    if (!list || list.isSystem)
        return false;
    lists.delete(id);
    contacts.forEach(c => {
        if (c.listId === id) {
            contacts.set(c.id, { ...c, listId: 'list_incoming' });
        }
    });
    return true;
}
export function getContact(id) {
    return contacts.get(id);
}
export function getContactByPhone(phone) {
    for (const c of contacts.values()) {
        if (c.phone === phone)
            return c;
    }
    return undefined;
}
export function saveContact(data) {
    const id = uuid();
    const contact = { ...data, id, createdAt: Date.now(), unread: 0 };
    contacts.set(id, contact);
    return contact;
}
export function updateContact(id, patch) {
    const contact = contacts.get(id);
    if (!contact)
        return null;
    const updated = { ...contact, ...patch };
    contacts.set(id, updated);
    return updated;
}
export function touchContact(id, ts) {
    const c = contacts.get(id);
    if (!c)
        return;
    contacts.set(id, { ...c, lastMessageAt: ts, unread: c.unread + 1 });
}
export function markRead(id) {
    const c = contacts.get(id);
    if (!c)
        return;
    contacts.set(id, { ...c, unread: 0 });
}
export function allContacts() {
    return Array.from(contacts.values()).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}
export function saveMessage(msg) {
    const list = messages.get(msg.contactId) ?? [];
    list.push(msg);
    messages.set(msg.contactId, list);
    if (msg.waMessageId)
        waMessageIndex.add(msg.waMessageId);
    return msg;
}
export function isDuplicateWaMessage(waMessageId) {
    return waMessageIndex.has(waMessageId);
}
export function getMessages(contactId) {
    return messages.get(contactId) ?? [];
}
export function allMessagesGrouped() {
    const result = {};
    messages.forEach((msgs, contactId) => {
        result[contactId] = msgs;
    });
    return result;
}
export function updateMessage(contactId, messageId, patch) {
    const list = messages.get(contactId);
    if (!list)
        return;
    const idx = list.findIndex(m => m.id === messageId);
    if (idx === -1)
        return;
    list[idx] = { ...list[idx], ...patch };
}
export function seedContact(contact) {
    contacts.set(contact.id, contact);
}
export function seedMessages(contactId, msgs) {
    messages.set(contactId, msgs);
}
