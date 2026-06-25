import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Server as SocketServer } from 'socket.io';
import { BaileysAdapter } from './adapters/BaileysAdapter.js';
import { CloudApiAdapter } from './adapters/CloudApiAdapter.js';
import type { WhatsAppAdapter } from './adapters/WhatsAppAdapter.js';
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

export type AdapterType = 'baileys' | 'cloudapi';

interface Workspace {
  info: WorkspaceInfo;
  wa: WhatsAppAdapter;
  adapterType: AdapterType;
  db: DbStore;
  pipeline: MessagePipeline;
  lastQr: string | null;
}

// Check if Cloud API env vars are set
export function cloudApiAvailable(): boolean {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private slugIndex  = new Map<string, string>();
  // Map phoneNumberId → workspaceId for Cloud API webhook routing
  private phoneNumberIdIndex = new Map<string, string>();

  constructor(private io: SocketServer) {}

  create(name: string, adapterType?: AdapterType): WorkspaceInfo {
    const slug = nameToSlug(name);

    // Reuse workspace if same slug already exists (e.g. server restart)
    const existingId = this.slugIndex.get(slug);
    if (existingId) {
      const ws = this.workspaces.get(existingId);
      if (ws) return ws.info;
    }

    // Auto-select adapter: Cloud API if available and requested (or if Baileys not explicitly chosen)
    const type: AdapterType = adapterType
      ?? (cloudApiAvailable() ? 'cloudapi' : 'baileys');

    const id = uuid();
    const info: WorkspaceInfo = { id, name, slug, createdAt: Date.now() };

    let wa: WhatsAppAdapter;
    if (type === 'cloudapi') {
      const token         = process.env.WHATSAPP_TOKEN!;
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
      wa = new CloudApiAdapter(phoneNumberId, token);
      this.phoneNumberIdIndex.set(phoneNumberId, id);
    } else {
      const sessionDir = path.resolve(`.wa-sessions/${slug}`);
      wa = new BaileysAdapter(sessionDir);
    }

    const db       = new DbStore();
    const pipeline = new MessagePipeline(wa, this.io, id, db);

    const workspace: Workspace = { info, wa, adapterType: type, db, pipeline, lastQr: null };
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

      if (status === 'open') {
        const delays = type === 'cloudapi' ? [500] : [3000, 8000, 15000];
        delays.forEach(delay => {
          setTimeout(() => {
            const contactCount = workspace.db.allContacts().length;
            console.log(`[ws:${slug}] auto-bootstrap @${delay}ms: ${contactCount} contacts`);
            this.io.to(id).emit('bootstrap', {
              contacts: workspace.db.allContacts(),
              messages: workspace.db.allMessagesGrouped(),
              lists:    workspace.db.allLists(),
              workspace: info,
            });
          }, delay);
        });
      }
    });

    wa.on('contact', (raw) => {
      try { pipeline.handleContactDiscovery(raw); } catch {}
    });

    wa.on('message', async (raw) => {
      try {
        if (raw.fromMe) {
          await pipeline.handleHistoryOutbound(raw);
        } else {
          await pipeline.handleInbound(raw);
        }
      } catch (err) {
        console.error(`[ws:${slug}] message error:`, err);
      }
    });

    wa.connect().catch(err => console.error(`[ws:${slug}] connect error:`, err));

    console.log(`[WorkspaceManager] Workspace criado: "${name}" (slug: ${slug}, adapter: ${type})`);
    return info;
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  getByPhoneNumberId(phoneNumberId: string): Workspace | undefined {
    const id = this.phoneNumberIdIndex.get(phoneNumberId);
    if (!id) return undefined;
    return this.workspaces.get(id);
  }

  list(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values()).map(w => w.info);
  }

  adapterType(id: string): AdapterType | undefined {
    return this.workspaces.get(id)?.adapterType;
  }

  async delete(id: string): Promise<boolean> {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    await ws.wa.disconnect().catch(() => {});
    this.slugIndex.delete(ws.info.slug);
    // Remove from phoneNumberId index if Cloud API
    for (const [pid, wid] of this.phoneNumberIdIndex.entries()) {
      if (wid === id) { this.phoneNumberIdIndex.delete(pid); break; }
    }
    this.workspaces.delete(id);
    return true;
  }
}
