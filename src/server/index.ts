import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaileysAdapter } from './adapters/BaileysAdapter.js';
import { MessagePipeline } from './MessagePipeline.js';
import * as db from './services/db.js';
import type {
  SendMessagePayload,
  MoveContactPayload,
  SetLangPayload,
  ListCreatePayload,
  ListRenamePayload,
  ListDeletePayload,
  ChatReadPayload,
  LangCode,
} from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: '*' },
});

app.use(cors());
app.use(express.json());

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

app.get('/api/bootstrap', (_req, res) => {
  res.json({
    contacts: db.allContacts(),
    messages: db.allMessagesGrouped(),
    lists: db.allLists(),
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const wa = new BaileysAdapter();
const pipeline = new MessagePipeline(wa, io);

// Cache the last QR so late-connecting clients get it immediately
let lastQr: string | null = null;

wa.on('qr', (qrDataUrl) => {
  lastQr = qrDataUrl;
  io.emit('wa:qr', qrDataUrl);
  console.log('[Server] QR emitido para todos os clientes conectados');
});

wa.on('status', (status) => {
  if (status === 'open') lastQr = null; // clear QR once connected
  io.emit('wa:status', status);
});

wa.on('message', async (raw) => {
  try {
    await pipeline.handleInbound(raw);
  } catch (err) {
    console.error('[inbound error]', err);
  }
});

io.on('connection', (socket) => {
  console.log('[socket] client connected:', socket.id);

  // Send current WA status immediately
  socket.emit('wa:status', wa.status());

  // If QR already generated and WA not yet connected, send it right away
  if (lastQr && wa.status() !== 'open') {
    console.log('[socket] enviando QR cacheado para', socket.id);
    socket.emit('wa:qr', lastQr);
  }

  socket.emit('bootstrap', {
    contacts: db.allContacts(),
    messages: db.allMessagesGrouped(),
    lists: db.allLists(),
  });

  socket.on('message:send', async (payload: SendMessagePayload) => {
    try {
      await pipeline.handleOutbound(payload.contactId, payload.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      socket.emit('message:error', { contactId: payload.contactId, error: msg });
    }
  });

  socket.on('contact:moveList', ({ contactId, listId }: MoveContactPayload) => {
    const updated = db.updateContact(contactId, { listId });
    if (updated) io.emit('contact:updated', updated);
  });

  socket.on('contact:setLang', ({ contactId, lang }: SetLangPayload) => {
    const updated = db.updateContact(contactId, {
      currentLang: lang as LangCode,
      autoDetectLang: false,
    });
    if (updated) io.emit('contact:updated', updated);
  });

  socket.on('list:create', ({ name, color }: ListCreatePayload) => {
    const list = db.saveList({ name, color });
    io.emit('list:created', list);
  });

  socket.on('list:rename', ({ listId, name }: ListRenamePayload) => {
    const list = db.updateList(listId, { name });
    if (list) io.emit('list:updated', list);
  });

  socket.on('list:delete', ({ listId }: ListDeletePayload) => {
    const ok = db.deleteList(listId);
    if (ok) io.emit('list:deleted', { listId });
  });

  socket.on('chat:read', ({ contactId }: ChatReadPayload) => {
    db.markRead(contactId);
    io.emit('contact:updated', db.getContact(contactId));
  });

  socket.on('disconnect', () => {
    console.log('[socket] client disconnected:', socket.id);
  });
});

async function seedMockData() {
  const { contacts, messages } = await import('../mock/data.js');
  contacts.forEach(c => db.seedContact(c));
  Object.entries(messages).forEach(([contactId, msgs]) => {
    db.seedMessages(contactId, msgs);
  });
}

async function main() {
  await seedMockData();

  httpServer.listen(PORT, () => {
    console.log(`[LinguaFlow] Server running on http://localhost:${PORT}`);
    console.log('[LinguaFlow] Connecting to WhatsApp...');
  });

  try {
    await wa.connect();
  } catch (err) {
    console.error('[WhatsApp] Failed to connect:', err);
  }
}

main();
