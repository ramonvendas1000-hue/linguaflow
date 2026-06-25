import { v4 as uuid } from 'uuid';
import { translate, detectLang } from './services/translation.js';
import * as db from './services/db.js';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
export class MessagePipeline {
    constructor(wa, io) {
        this.wa = wa;
        this.io = io;
    }
    async handleInbound(raw) {
        if (db.isDuplicateWaMessage(raw.waMessageId))
            return;
        let contact = db.getContactByPhone(raw.fromPhone);
        if (!contact) {
            contact = db.saveContact({
                name: raw.fromName ?? raw.fromPhone,
                phone: raw.fromPhone,
                currentLang: 'en',
                autoDetectLang: true,
                listId: 'list_incoming',
                online: true,
            });
        }
        const detectedLang = contact.autoDetectLang
            ? await detectLang(raw.text)
            : contact.currentLang;
        if (contact.autoDetectLang && detectedLang !== contact.currentLang) {
            db.updateContact(contact.id, { currentLang: detectedLang, autoDetectLang: false });
            contact = db.getContact(contact.id);
        }
        const translationResult = await translate({
            text: raw.text,
            from: detectedLang,
            to: 'pt',
        });
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
        db.saveMessage(message);
        db.touchContact(contact.id, raw.timestamp);
        this.io.emit('message:new', message);
        if (!translationResult.ok) {
            this.retryTranslation(message, raw.text, detectedLang, 'pt', 0);
        }
    }
    async handleOutbound(contactId, textPt) {
        const contact = db.getContact(contactId);
        if (!contact)
            throw new Error(`Contact not found: ${contactId}`);
        const customerLang = contact.currentLang;
        const translationResult = await translate({
            text: textPt,
            from: 'pt',
            to: customerLang,
        });
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
        db.saveMessage(message);
        db.touchContact(contactId, message.timestamp);
        this.io.emit('message:new', message);
        return message;
    }
    retryTranslation(msg, originalText, from, to, attempt) {
        if (attempt >= MAX_RETRIES)
            return;
        setTimeout(async () => {
            const result = await translate({ text: originalText, from, to });
            if (result.ok) {
                db.updateMessage(msg.contactId, msg.id, {
                    translatedText: result.text,
                    translationStatus: 'ok',
                    translationProvider: result.provider,
                });
                const updated = db.getMessages(msg.contactId).find(m => m.id === msg.id);
                if (updated)
                    this.io.emit('message:new', updated);
            }
            else {
                this.retryTranslation(msg, originalText, from, to, attempt + 1);
            }
        }, RETRY_DELAY_MS * (attempt + 1));
    }
}
