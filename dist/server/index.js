import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkspaceManager } from './WorkspaceManager.js';
import { eventLog } from './adapters/BaileysAdapter.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, { cors: { origin: '*' } });
app.use(cors());
app.use(express.json());
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
// Debug endpoint — shows current server state
app.get('/api/debug', (_req, res) => {
    const workspaces = wm.list().map(info => {
        const ws = wm.get(info.id);
        const contacts = ws.db.allContacts();
        const msgs = ws.db.allMessagesGrouped();
        const totalMsgs = Object.values(msgs).reduce((n, arr) => n + arr.length, 0);
        return {
            id: info.id, name: info.name, slug: info.slug,
            waStatus: ws.wa.status(),
            contacts: contacts.length,
            messages: totalMsgs,
            contactList: contacts.map(c => ({ name: c.name, phone: c.phone, lang: c.currentLang })),
        };
    });
    res.json({ workspaces, uptime: process.uptime(), ts: Date.now(), cwd: process.cwd(), events: eventLog.slice(-50) });
});
app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
});
const wm = new WorkspaceManager(io);
io.on('connection', (socket) => {
    console.log('[socket] connected:', socket.id);
    // Send current workspace list so the client can pick one
    socket.emit('workspace:list', wm.list());
    // ── Workspace: join ──────────────────────────────────────────────────────
    socket.on('workspace:join', ({ workspaceId }) => {
        const ws = wm.get(workspaceId);
        if (!ws) {
            socket.emit('workspace:error', { message: 'Workspace não encontrado' });
            return;
        }
        socket.join(workspaceId);
        socket.emit('workspace:joined', ws.info);
        socket.emit('wa:status', ws.wa.status());
        if (ws.lastQr && ws.wa.status() !== 'open') {
            socket.emit('wa:qr', ws.lastQr);
        }
        socket.emit('bootstrap', {
            contacts: ws.db.allContacts(),
            messages: ws.db.allMessagesGrouped(),
            lists: ws.db.allLists(),
            workspace: ws.info,
        });
    });
    // ── Workspace: create ────────────────────────────────────────────────────
    socket.on('workspace:create', ({ name }) => {
        if (!name?.trim()) {
            socket.emit('workspace:error', { message: 'Nome obrigatório' });
            return;
        }
        const info = wm.create(name.trim());
        io.emit('workspace:list', wm.list()); // broadcast updated list to everyone
        socket.join(info.id);
        socket.emit('workspace:joined', info);
        const ws = wm.get(info.id);
        socket.emit('wa:status', ws.wa.status());
        socket.emit('bootstrap', {
            contacts: ws.db.allContacts(),
            messages: ws.db.allMessagesGrouped(),
            lists: ws.db.allLists(),
            workspace: info,
        });
    });
    // ── Workspace: delete ────────────────────────────────────────────────────
    socket.on('workspace:delete', async ({ workspaceId }) => {
        await wm.delete(workspaceId);
        io.emit('workspace:list', wm.list());
    });
    // ── Workspace: manual sync (re-sends bootstrap) ─────────────────────────
    socket.on('workspace:sync', ({ workspaceId }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        socket.emit('bootstrap', {
            contacts: ws.db.allContacts(),
            messages: ws.db.allMessagesGrouped(),
            lists: ws.db.allLists(),
            workspace: ws.info,
        });
        console.log(`[sync] bootstrap re-sent: ${ws.db.allContacts().length} contacts`);
    });
    // ── WhatsApp: manual disconnect ──────────────────────────────────────────
    socket.on('wa:disconnect', async ({ workspaceId }) => {
        const ws = wm.get(workspaceId);
        if (ws)
            await ws.wa.disconnect();
    });
    // ── WhatsApp: reconnect (re-trigger QR) ─────────────────────────────────
    socket.on('wa:reconnect', async ({ workspaceId }) => {
        const ws = wm.get(workspaceId);
        if (ws)
            await ws.wa.connect();
    });
    // ── Messages ─────────────────────────────────────────────────────────────
    socket.on('message:send', async (payload) => {
        const ws = wm.get(payload.workspaceId);
        if (!ws)
            return;
        try {
            await ws.pipeline.handleOutbound(payload.contactId, payload.text);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            socket.emit('message:error', { contactId: payload.contactId, error: msg });
        }
    });
    // ── Contacts ─────────────────────────────────────────────────────────────
    socket.on('contact:moveList', ({ workspaceId, contactId, listId }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const updated = ws.db.updateContact(contactId, { listId });
        if (updated)
            io.to(workspaceId).emit('contact:updated', updated);
    });
    socket.on('contact:setLang', ({ workspaceId, contactId, lang }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const updated = ws.db.updateContact(contactId, { currentLang: lang, autoDetectLang: false });
        if (updated)
            io.to(workspaceId).emit('contact:updated', updated);
    });
    socket.on('contact:rename', ({ workspaceId, contactId, name }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const updated = ws.db.updateContact(contactId, { name });
        if (updated)
            io.to(workspaceId).emit('contact:updated', updated);
    });
    socket.on('contact:addNote', ({ workspaceId, contactId, text }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const updated = ws.db.addNote(contactId, text);
        if (updated)
            io.to(workspaceId).emit('contact:updated', updated);
    });
    socket.on('contact:removeNote', ({ workspaceId, contactId, noteId }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const updated = ws.db.removeNote(contactId, noteId);
        if (updated)
            io.to(workspaceId).emit('contact:updated', updated);
    });
    // ── Lists ─────────────────────────────────────────────────────────────────
    socket.on('list:create', ({ workspaceId, name, color }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const list = ws.db.saveList({ name, color });
        io.to(workspaceId).emit('list:created', list);
    });
    socket.on('list:rename', ({ workspaceId, listId, name }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const list = ws.db.updateList(listId, { name });
        if (list)
            io.to(workspaceId).emit('list:updated', list);
    });
    socket.on('list:delete', ({ workspaceId, listId }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        const ok = ws.db.deleteList(listId);
        if (ok)
            io.to(workspaceId).emit('list:deleted', { listId });
    });
    // ── Chat read ─────────────────────────────────────────────────────────────
    socket.on('chat:read', ({ workspaceId, contactId }) => {
        const ws = wm.get(workspaceId);
        if (!ws)
            return;
        ws.db.markRead(contactId);
        io.to(workspaceId).emit('contact:updated', ws.db.getContact(contactId));
    });
    socket.on('disconnect', () => {
        console.log('[socket] disconnected:', socket.id);
    });
});
httpServer.listen(PORT, () => {
    console.log(`[LinguaFlow] Server running on http://localhost:${PORT}`);
    console.log('[LinguaFlow] Multi-workspace mode active');
});
