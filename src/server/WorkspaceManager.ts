import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Server as SocketServer } from 'socket.io';
import { BaileysAdapter } from './adapters/BaileysAdapter.js';
import { MessagePipeline } from './MessagePipeline.js';
import { DbStore } from './services/DbStore.js';
import type { WorkspaceInfo } from '../types/index.js';

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'workspace';
}

interface Workspace {
  info: WorkspaceInfo;
  wa: BaileysAdapter;
  db: DbStore;
  pipeline: MessagePipeline;
  lastQr: string | null;
}

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private slugIndex  = new Map<string, string>(); // slug → workspaceId

  constructor(private io: SocketServer) {}

  create(name: string): WorkspaceInfo {
    const slug = nameToSlug(name);

    // Reuse workspace if same slug already exists (e.g. server restart)
    const existingId = this.slugIndex.get(slug);
    if (existingId) {
      const ws = this.workspaces.get(existingId);
      if (ws) return ws.info;
    }

    const id = uuid();
    const info: WorkspaceInfo = { id, name, slug, createdAt: Date.now() };

    const sessionDir = path.resolve(`.wa-sessions/${slug}`);
    const wa       = new BaileysAdapter(sessionDir);
    const db       = new DbStore();
    const pipeline = new MessagePipeline(wa, this.io, id, db);

    const workspace: Workspace = { info, wa, db, pipeline, lastQr: null };
    this.workspaces.set(id, workspace);
    this.slugIndex.set(slug, id);

    wa.on('qr', (qrDataUrl) => {
      workspace.lastQr = qrDataUrl;
      this.io.to(id).emit('wa:qr', qrDataUrl);
      console.log(`[ws:${slug}] QR emitido`);
    });

    wa.on('status', (status) => {
      if (status === 'open') workspace.lastQr = null;
      this.io.to(id).emit('wa:status', status);
    });

    wa.on('message', async (raw) => {
      try {
        await pipeline.handleInbound(raw);
      } catch (err) {
        console.error(`[ws:${slug}] inbound error:`, err);
      }
    });

    wa.connect().catch(err => console.error(`[ws:${slug}] connect error:`, err));

    console.log(`[WorkspaceManager] Workspace criado: "${name}" (slug: ${slug}, id: ${id})`);
    return info;
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  list(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values()).map(w => w.info);
  }

  async delete(id: string): Promise<boolean> {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    await ws.wa.disconnect().catch(() => {});
    this.slugIndex.delete(ws.info.slug);
    this.workspaces.delete(id);
    return true;
  }
}
