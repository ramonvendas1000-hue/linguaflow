import path from 'path';
import { v4 as uuid } from 'uuid';
import { BaileysAdapter } from './adapters/BaileysAdapter.js';
import { MessagePipeline } from './MessagePipeline.js';
import { DbStore } from './services/DbStore.js';
function nameToSlug(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'workspace';
}
export class WorkspaceManager {
    constructor(io) {
        this.io = io;
        this.workspaces = new Map();
        this.slugIndex = new Map(); // slug → workspaceId
    }
    create(name) {
        const slug = nameToSlug(name);
        // Reuse workspace if same slug already exists (e.g. server restart)
        const existingId = this.slugIndex.get(slug);
        if (existingId) {
            const ws = this.workspaces.get(existingId);
            if (ws)
                return ws.info;
        }
        const id = uuid();
        const info = { id, name, slug, createdAt: Date.now() };
        const sessionDir = path.resolve(`.wa-sessions/${slug}`);
        const wa = new BaileysAdapter(sessionDir);
        const db = new DbStore();
        const pipeline = new MessagePipeline(wa, this.io, id, db);
        const workspace = { info, wa, db, pipeline, lastQr: null };
        this.workspaces.set(id, workspace);
        this.slugIndex.set(slug, id);
        wa.on('qr', (qrDataUrl) => {
            workspace.lastQr = qrDataUrl;
            this.io.to(id).emit('wa:qr', qrDataUrl);
            console.log(`[ws:${slug}] QR emitido`);
        });
        wa.on('status', (status) => {
            if (status === 'open')
                workspace.lastQr = null;
            this.io.to(id).emit('wa:status', status);
        });
        wa.on('message', async (raw) => {
            try {
                await pipeline.handleInbound(raw);
            }
            catch (err) {
                console.error(`[ws:${slug}] inbound error:`, err);
            }
        });
        wa.connect().catch(err => console.error(`[ws:${slug}] connect error:`, err));
        console.log(`[WorkspaceManager] Workspace criado: "${name}" (slug: ${slug}, id: ${id})`);
        return info;
    }
    get(id) {
        return this.workspaces.get(id);
    }
    list() {
        return Array.from(this.workspaces.values()).map(w => w.info);
    }
    async delete(id) {
        const ws = this.workspaces.get(id);
        if (!ws)
            return false;
        await ws.wa.disconnect().catch(() => { });
        this.slugIndex.delete(ws.info.slug);
        this.workspaces.delete(id);
        return true;
    }
}
