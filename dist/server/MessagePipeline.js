import { v4 as uuid } from 'uuid';
import { translate, detectLang } from './services/translation.js';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
export class MessagePipeline {
    constructor(wa, io, workspaceId, db) {
        this.wa = wa;
        this.io = io;
        this.workspaceId = workspaceId;
        this.db = db;
    }
    broadcast(event, data) {
        this.io.to(this.workspaceId).emit(event, data);
    }
    cleanPhone(phone) {
        return phone.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '');
    }
    isLidPhone(phone) {
        return phone.endsWith('@lid') || (!phone.includes('@') && /^\d{10,}$/.test(phone));
    }
    isAutoName(name, phone) {
        const clean = this.cleanPhone(phone);
        return name === clean || name === phone || /^Contato \d+$/.test(name) || /^\d{10,}$/.test(name);
    }
    bestName(rawName, phone) {
        if (rawName)
            return rawName;
        if (!this.isLidPhone(phone))
            return this.cleanPhone(phone);
        return this.db.nextContactName(); // "Contato 1", "Contato 2", etc.
    }
    // Called by chats.set / contacts.set — ensures contact exists without a message
    handleContactDiscovery(raw) {
        let contact = this.db.getContactByPhone(raw.phone);
        if (!contact) {
            contact = this.db.saveContact({
                name: this.bestName(raw.name, raw.phone),
                phone: raw.phone,
                currentLang: 'pt',
                autoDetectLang: true,
                listId: 'list_incoming',
                online: false,
            });
            this.broadcast('contact:updated', contact);
        }
        else if (raw.name && this.isAutoName(contact.name, contact.phone)) {
            // We now have a real name (pushName) — upgrade from auto-number
            const updated = this.db.updateContact(contact.id, { name: raw.name });
            if (updated)
                this.broadcast('contact:updated', updated);
        }
    }
    // Historical outbound messages (fromMe=true) — show in thread without re-sending
    async handleHistoryOutbound(raw) {
        if (this.db.isDuplicateWaMessage(raw.waMessageId))
            return;
        let contact = this.db.getContactByPhone(raw.fromPhone);
        if (!contact) {
            contact = this.db.saveContact({
                name: this.bestName(raw.fromName, raw.fromPhone),
                phone: raw.fromPhone,
                currentLang: 'pt',
                autoDetectLang: true,
                listId: 'list_incoming',
                online: false,
            });
            this.broadcast('contact:updated', contact);
        }
        const message = {
            id: uuid(),
            contactId: contact.id,
            direction: 'outbound',
            originalText: raw.text,
            originalLang: 'pt',
            translatedText: raw.text,
            translatedLang: 'pt',
            translationStatus: 'skipped',
            timestamp: raw.timestamp,
            waMessageId: raw.waMessageId,
            delivered: true,
        };
        this.db.saveMessage(message);
        this.db.touchContact(contact.id, raw.timestamp);
        this.broadcast('message:new', message);
    }
    async handleInbound(raw) {
        if (this.db.isDuplicateWaMessage(raw.waMessageId))
            return;
        let contact = this.db.getContactByPhone(raw.fromPhone);
        if (!contact) {
            contact = this.db.saveContact({
                name: this.bestName(raw.fromName, raw.fromPhone),
                phone: raw.fromPhone,
                currentLang: 'pt',
                autoDetectLang: true,
                listId: 'list_incoming',
                online: true,
            });
        }
        else if (raw.fromName && this.isAutoName(contact.name, contact.phone)) {
            // Upgrade from auto-number to real pushName
            const updated = this.db.updateContact(contact.id, { name: raw.fromName, online: true });
            if (updated) {
                contact = updated;
                this.broadcast('contact:updated', updated);
            }
        }
        else {
            this.db.updateContact(contact.id, { online: true });
        }
        const detectedLang = contact.autoDetectLang
            ? await detectLang(raw.text)
            : contact.currentLang;
        if (contact.autoDetectLang && detectedLang !== contact.currentLang) {
            this.db.updateContact(contact.id, { currentLang: detectedLang, autoDetectLang: false });
            contact = this.db.getContact(contact.id);
        }
        const translationResult = await translate({ text: raw.text, from: detectedLang, to: 'pt' });
        const message = {
            id: uuid(),
            contactId: contact.id,
            direction: 'inbound',
            originalText: raw.text,
            originalLang: detectedLang,
            translatedText: translationResult.ok ? translationResult.text : raw.text,
            translatedLang: 'pt',
            translationStatus: translationResult.ok ? 'ok' : 'failed',
            translationProvider: translationResult.provider,
            timestamp: raw.timestamp,
            waMessageId: raw.waMessageId,
        };
        this.db.saveMessage(message);
        this.db.touchContact(contact.id, raw.timestamp);
        this.broadcast('message:new', message);
        this.broadcast('contact:updated', this.db.getContact(contact.id));
        if (!translationResult.ok) {
            this.retryTranslation(message, raw.text, detectedLang, 'pt', 0);
        }
    }
    async handleOutbound(contactId, textPt) {
        const contact = this.db.getContact(contactId);
        if (!contact)
            throw new Error(`Contact not found: ${contactId}`);
        const customerLang = contact.currentLang;
        const translationResult = await translate({ text: textPt, from: 'pt', to: customerLang });
        if (!translationResult.ok) {
            throw new Error('Translation failed — message NOT sent to protect customer experience');
        }
        await this.wa.sendMessage(contact.phone, translationResult.text);
        const message = {
            id: uuid(),
            contactId,
            direction: 'outbound',
            originalText: textPt,
            originalLang: 'pt',
            translatedText: translationResult.text,
            translatedLang: customerLang,
            translationStatus: 'ok',
            translationProvider: translationResult.provider,
            timestamp: Date.now(),
            delivered: true,
        };
        this.db.saveMessage(message);
        this.db.touchContact(contactId, message.timestamp);
        this.broadcast('message:new', message);
        return message;
    }
    retryTranslation(msg, originalText, from, to, attempt) {
        if (attempt >= MAX_RETRIES)
            return;
        setTimeout(async () => {
            const result = await translate({ text: originalText, from, to });
            if (result.ok) {
                this.db.updateMessage(msg.contactId, msg.id, {
                    translatedText: result.text,
                    translationStatus: 'ok',
                    translationProvider: result.provider,
                });
                const updated = this.db.getMessages(msg.contactId).find(m => m.id === msg.id);
                if (updated)
                    this.broadcast('message:new', updated);
            }
            else {
                this.retryTranslation(msg, originalText, from, to, attempt + 1);
            }
        }, RETRY_DELAY_MS * (attempt + 1));
    }
}
