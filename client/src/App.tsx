import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { fadeUp, fadeIn, pop, staggerContainer, spring } from './lib/motion';
import type { Contact, Message, CrmList, LangCode, WaStatus, WorkspaceInfo, ContactNote } from './types';

// ── Constants ──────────────────────────────────────────────────────────────
const AVATAR_COLORS = ['#3B82F6', '#06B6D4', '#8B5CF6', '#F59E0B', '#EC4899', '#10B981'];
const LANG_LABELS: Record<LangCode, string> = {
  pt: 'PT', en: 'EN', es: 'ES', fr: 'FR', de: 'DE',
  it: 'IT', ja: 'JA', zh: 'ZH', ru: 'RU', ar: 'AR',
};
const LANG_NAMES: Record<LangCode, string> = {
  pt: 'Português', en: 'English', es: 'Español', fr: 'Français',
  de: 'Deutsch', it: 'Italiano', ja: '日本語', zh: '中文', ru: 'Русский', ar: 'العربية',
};

function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatRelative(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'agora';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ── Store ──────────────────────────────────────────────────────────────────
interface AppState {
  workspace: WorkspaceInfo | null;
  workspaceList: WorkspaceInfo[];
  contacts: Contact[];
  messages: Record<string, Message[]>;
  lists: CrmList[];
  activeContactId: string | null;
  waStatus: WaStatus;
  qrCode: string | null;
  listFilter: string | null;
  searchQuery: string;
  draft: string;
  sendError: string | null;
  showOriginal: Record<string, boolean>;

  setWorkspace: (w: WorkspaceInfo | null) => void;
  setWorkspaceList: (list: WorkspaceInfo[]) => void;
  setContacts: (c: Contact[]) => void;
  setMessages: (m: Record<string, Message[]>) => void;
  setLists: (l: CrmList[]) => void;
  setActiveContact: (id: string | null) => void;
  setWaStatus: (s: WaStatus) => void;
  setQr: (q: string | null) => void;
  setListFilter: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
  setDraft: (d: string) => void;
  setSendError: (e: string | null) => void;
  ingestMessage: (msg: Message) => void;
  updateContact: (c: Contact) => void;
  upsertList: (l: CrmList) => void;
  removeList: (listId: string) => void;
  toggleOriginal: (msgId: string) => void;
  markRead: (contactId: string) => void;
}

const useStore = create<AppState>((set) => ({
  workspace: null,
  workspaceList: [],
  contacts: [],
  messages: {},
  lists: [],
  activeContactId: null,
  waStatus: 'disconnected',
  qrCode: null,
  listFilter: null,
  searchQuery: '',
  draft: '',
  sendError: null,
  showOriginal: {},

  setWorkspace: (workspace) => set({ workspace }),
  setWorkspaceList: (workspaceList) => set({ workspaceList }),
  setContacts: (contacts) => set({ contacts }),
  setMessages: (messages) => set({ messages }),
  setLists: (lists) => set({ lists }),
  setActiveContact: (id) => set({ activeContactId: id, draft: '', sendError: null }),
  setWaStatus: (waStatus) => set({ waStatus }),
  setQr: (qrCode) => set({ qrCode }),
  setListFilter: (listFilter) => set({ listFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setDraft: (draft) => set({ draft }),
  setSendError: (sendError) => set({ sendError }),

  ingestMessage: (msg) =>
    set((s) => {
      const existing = s.messages[msg.contactId] ?? [];
      const deduped = existing.some(m => m.id === msg.id)
        ? existing.map(m => (m.id === msg.id ? msg : m))
        : [...existing, msg];
      const updatedContact = s.contacts.find(c => c.id === msg.contactId);
      if (!updatedContact) return { messages: { ...s.messages, [msg.contactId]: deduped } };
      const isActive = s.activeContactId === msg.contactId;
      const unread = msg.direction === 'inbound' && !isActive
        ? updatedContact.unread + 1
        : updatedContact.unread;
      return {
        messages: { ...s.messages, [msg.contactId]: deduped },
        contacts: s.contacts.map(c =>
          c.id === msg.contactId ? { ...c, lastMessageAt: msg.timestamp, unread } : c
        ),
      };
    }),

  updateContact: (contact) =>
    set((s) => ({
      contacts: s.contacts.some(c => c.id === contact.id)
        ? s.contacts.map(c => (c.id === contact.id ? contact : c))
        : [...s.contacts, contact],
    })),

  upsertList: (list) =>
    set((s) => ({
      lists: s.lists.some(l => l.id === list.id)
        ? s.lists.map(l => (l.id === list.id ? list : l))
        : [...s.lists, list],
    })),

  removeList: (listId) => set((s) => ({ lists: s.lists.filter(l => l.id !== listId) })),
  toggleOriginal: (msgId) =>
    set((s) => ({ showOriginal: { ...s.showOriginal, [msgId]: !s.showOriginal[msgId] } })),
  markRead: (contactId) =>
    set((s) => ({
      contacts: s.contacts.map(c => (c.id === contactId ? { ...c, unread: 0 } : c)),
    })),
}));

// ── Socket singleton ───────────────────────────────────────────────────────
let socketInstance: Socket | null = null;

async function initSocket(): Promise<Socket> {
  if (socketInstance) return socketInstance;
  const { io } = await import('socket.io-client');
  const url = import.meta.env.VITE_SERVER_URL
    ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');
  socketInstance = io(url, { transports: ['websocket', 'polling'], autoConnect: true });
  return socketInstance;
}

function getSocket(): Socket | null { return socketInstance; }

// ── Motion variants ────────────────────────────────────────────────────────
const backdropVariant = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit:    { opacity: 0, transition: { duration: 0.15 } },
};
const modalVariant = {
  hidden:  { opacity: 0, scale: 0.95, y: 12 },
  visible: { opacity: 1, scale: 1, y: 0, transition: spring.smooth },
  exit:    { opacity: 0, scale: 0.97, y: 6, transition: spring.snappy },
};
const slideLeftVariant = {
  hidden:  { x: '100%', opacity: 0 },
  visible: { x: 0, opacity: 1, transition: spring.smooth },
  exit:    { x: '100%', opacity: 0, transition: spring.snappy },
};

// ── Workspace Screen ───────────────────────────────────────────────────────
function WorkspaceScreen() {
  const { workspaceList, setWorkspace, setWorkspaceList, setContacts, setMessages, setLists, setWaStatus } = useStore();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  function joinWorkspace(id: string) {
    getSocket()?.emit('workspace:join', { workspaceId: id });
  }

  function createWorkspace() {
    const name = newName.trim();
    if (!name) { setError('Digite um nome'); return; }
    setCreating(true);
    setError('');
    getSocket()?.emit('workspace:create', { name });
    setNewName('');
    setCreating(false);
  }

  return (
    <motion.div
      variants={fadeIn} initial="hidden" animate="visible"
      style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: '#0A0E1A', gap: 32, padding: 32,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🌐</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: '#E5E9F2', letterSpacing: '-0.5px' }}>
          LinguaFlow
        </div>
        <div style={{ color: '#64748B', fontSize: 14, marginTop: 6 }}>
          Central de Atendimento com Tradução em Tempo Real
        </div>
      </div>

      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Create workspace */}
        <div style={{
          background: '#161D2E', borderRadius: 16, padding: 20,
          border: '1px solid rgba(148,163,184,0.10)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
            Criar Novo Workspace
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createWorkspace()}
              placeholder="Ex: Atendimento Ramon"
              style={{
                flex: 1, background: '#0B0F1C', border: '1px solid rgba(148,163,184,0.12)',
                borderRadius: 10, padding: '10px 14px', color: '#E5E9F2', fontSize: 14, outline: 'none',
              }}
            />
            <motion.button
              variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={createWorkspace}
              disabled={creating}
              style={{
                padding: '10px 18px', borderRadius: 10, background: '#2563EB',
                border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Criar
            </motion.button>
          </div>
          {error && <div style={{ color: '#EF4444', fontSize: 12, marginTop: 8 }}>{error}</div>}
          <div style={{ color: '#475569', fontSize: 11, marginTop: 10 }}>
            💡 Use o mesmo nome após reinicializações para reconectar sem escanear QR novamente
          </div>
        </div>

        {/* Existing workspaces */}
        {workspaceList.length > 0 && (
          <div style={{
            background: '#161D2E', borderRadius: 16, padding: 20,
            border: '1px solid rgba(148,163,184,0.10)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
              Workspaces Ativos
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {workspaceList.map(ws => (
                <motion.button
                  key={ws.id}
                  variants={pop} initial="rest" whileHover="hover" whileTap="tap"
                  onClick={() => joinWorkspace(ws.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 16px', borderRadius: 12, background: '#0B0F1C',
                    border: '1px solid rgba(37,99,235,0.25)', color: '#E5E9F2',
                    cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: '50%',
                    background: avatarColor(ws.id),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 700, color: '#fff', flexShrink: 0,
                  }}>
                    {ws.name[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{ws.name}</div>
                    <div style={{ color: '#64748B', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                      /{ws.slug}
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', color: '#64748B', fontSize: 18 }}>→</div>
                </motion.button>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── QR Modal ───────────────────────────────────────────────────────────────
function QRModal({ qr, status, workspaceId, onClose }: { qr: string | null; status: WaStatus; workspaceId: string; onClose: () => void }) {
  const socket = getSocket();

  function handleDisconnect() {
    socket?.emit('wa:disconnect', { workspaceId });
  }
  function handleReconnect() {
    socket?.emit('wa:reconnect', { workspaceId });
  }

  return (
    <motion.div
      variants={backdropVariant} initial="hidden" animate="visible" exit="exit"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <motion.div
        variants={modalVariant}
        onClick={e => e.stopPropagation()}
        style={{
          background: '#161D2E', borderRadius: 20, padding: 28,
          border: '1px solid rgba(148,163,184,0.12)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
          width: 320,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 800, color: '#E5E9F2' }}>📱 WhatsApp</div>

        {qr && status !== 'open' ? (
          <img src={qr} alt="QR Code" style={{ width: 220, height: 220, borderRadius: 10 }} />
        ) : (
          <div style={{
            width: 220, height: 220, borderRadius: 10, background: '#0B0F1C',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12,
          }}>
            {status === 'open' ? (
              <>
                <div style={{ fontSize: 40 }}>✅</div>
                <span style={{ color: '#10B981', fontSize: 14, fontWeight: 700 }}>Conectado!</span>
              </>
            ) : (
              <>
                <div style={{
                  width: 36, height: 36, borderRadius: '50%',
                  border: '3px solid #2563EB', borderTopColor: 'transparent',
                  animation: 'spin 1s linear infinite',
                }} />
                <span style={{ color: '#94A3B8', fontSize: 13 }}>
                  {status === 'connecting' ? 'Conectando...' : 'Aguardando QR...'}
                </span>
              </>
            )}
          </div>
        )}

        <div style={{
          padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace',
          background: status === 'open' ? 'rgba(16,185,129,0.15)' : 'rgba(37,99,235,0.10)',
          color: status === 'open' ? '#10B981' : '#60A5FA',
          border: `1px solid ${status === 'open' ? 'rgba(16,185,129,0.3)' : 'rgba(37,99,235,0.25)'}`,
        }}>
          {status === 'open' ? '● CONECTADO' : status === 'connecting' ? '◌ CONECTANDO' : '○ AGUARDANDO QR'}
        </div>

        {status !== 'open' && (
          <p style={{ color: '#64748B', fontSize: 12, textAlign: 'center', margin: 0 }}>
            WhatsApp → Dispositivos conectados → Conectar dispositivo
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          {status === 'open' ? (
            <motion.button
              variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={handleDisconnect}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, fontSize: 12, fontWeight: 700,
                background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                color: '#EF4444', cursor: 'pointer',
              }}
            >
              Desconectar
            </motion.button>
          ) : (
            <motion.button
              variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={handleReconnect}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, fontSize: 12, fontWeight: 700,
                background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(37,99,235,0.3)',
                color: '#60A5FA', cursor: 'pointer',
              }}
            >
              Reconectar
            </motion.button>
          )}
          <motion.button
            variants={pop} initial="rest" whileHover="hover" whileTap="tap"
            onClick={onClose}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 10, fontSize: 12, fontWeight: 700,
              background: 'rgba(148,163,184,0.08)', border: '1px solid transparent',
              color: '#64748B', cursor: 'pointer',
            }}
          >
            Fechar
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── TopBar ─────────────────────────────────────────────────────────────────
function TopBar({ onQrClick, onLeave }: { onQrClick: () => void; onLeave: () => void }) {
  const { waStatus, workspace } = useStore();
  const statusColor = waStatus === 'open' ? '#10B981' : waStatus === 'connecting' ? '#F59E0B' : '#EF4444';
  const statusLabel = waStatus === 'open' ? 'Conectado' : waStatus === 'connecting' ? 'Conectando' : 'Desconectado';

  return (
    <div style={{
      height: 60, background: '#0B0F1C',
      borderBottom: '1px solid rgba(148,163,184,0.08)',
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12, flexShrink: 0,
    }}>
      <span style={{ fontSize: 18, fontWeight: 800, color: '#E5E9F2', letterSpacing: '-0.5px', flex: 1 }}>
        🌐 LinguaFlow{workspace ? ` · ${workspace.name}` : ''}
      </span>

      <motion.button
        variants={pop} initial="rest" whileHover="hover" whileTap="tap"
        onClick={onQrClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 20,
          background: `${statusColor}18`, border: `1px solid ${statusColor}40`,
          color: statusColor, fontSize: 11, fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 8 }}>●</span>{statusLabel}
      </motion.button>

      <div style={{
        padding: '5px 12px', borderRadius: 20,
        background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)',
        color: '#06B6D4', fontSize: 11, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
      }}>
        DeepL + GPT-4o
      </div>

      <motion.button
        variants={pop} initial="rest" whileHover="hover" whileTap="tap"
        onClick={onLeave}
        title="Trocar workspace"
        style={{
          padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: 'rgba(148,163,184,0.08)', border: '1px solid transparent',
          color: '#64748B', cursor: 'pointer',
        }}
      >
        ⇄ Sair
      </motion.button>
    </div>
  );
}

// ── Conversation List ──────────────────────────────────────────────────────
function ConversationList() {
  const { contacts, lists, listFilter, searchQuery, activeContactId, setActiveContact, setListFilter, setSearchQuery, markRead, workspace } = useStore();
  const socket = getSocket();

  const filtered = contacts
    .filter(c => !listFilter || c.listId === listFilter)
    .filter(c => !searchQuery ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.phone.includes(searchQuery))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  function handleSelect(id: string) {
    setActiveContact(id);
    markRead(id);
    socket?.emit('chat:read', { workspaceId: workspace?.id, contactId: id });
  }

  return (
    <div style={{
      width: 300, background: '#0B0F1C',
      borderRight: '1px solid rgba(148,163,184,0.08)',
      display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,0.06)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#161D2E', borderRadius: 10, padding: '7px 12px',
          border: '1px solid rgba(148,163,184,0.08)',
        }}>
          <span style={{ color: '#64748B', fontSize: 14 }}>🔍</span>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Buscar contatos..."
            style={{ background: 'none', border: 'none', outline: 'none', color: '#E5E9F2', fontSize: 13, flex: 1 }}
          />
        </div>
      </div>

      <div style={{ padding: '8px 10px', display: 'flex', gap: 5, flexWrap: 'wrap', borderBottom: '1px solid rgba(148,163,184,0.06)' }}>
        <motion.button
          variants={pop} initial="rest" whileHover="hover" whileTap="tap"
          onClick={() => setListFilter(null)}
          style={{
            padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            background: !listFilter ? 'rgba(37,99,235,0.2)' : 'rgba(148,163,184,0.08)',
            color: !listFilter ? '#60A5FA' : '#64748B',
            border: !listFilter ? '1px solid rgba(37,99,235,0.4)' : '1px solid transparent',
          }}
        >
          Todos
        </motion.button>
        {lists.map(list => (
          <motion.button
            key={list.id}
            variants={pop} initial="rest" whileHover="hover" whileTap="tap"
            onClick={() => setListFilter(listFilter === list.id ? null : list.id)}
            style={{
              padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 600, cursor: 'pointer',
              background: listFilter === list.id ? `${list.color}20` : 'rgba(148,163,184,0.08)',
              color: listFilter === list.id ? list.color : '#64748B',
              border: listFilter === list.id ? `1px solid ${list.color}50` : '1px solid transparent',
            }}
          >
            {list.name}
          </motion.button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <motion.div variants={staggerContainer} initial="hidden" animate="visible">
          <AnimatePresence>
            {filtered.map(contact => (
              <motion.div
                key={contact.id} variants={fadeUp} layout
                onClick={() => handleSelect(contact.id)}
                style={{
                  padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10,
                  cursor: 'pointer',
                  background: activeContactId === contact.id ? 'rgba(37,99,235,0.10)' : 'transparent',
                  borderLeft: activeContactId === contact.id ? '3px solid #2563EB' : '3px solid transparent',
                  transition: 'background 0.15s',
                }}
              >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: avatarColor(contact.id),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, color: '#fff',
                  }}>
                    {initials(contact.name)}
                  </div>
                  {contact.online && (
                    <div style={{
                      position: 'absolute', bottom: 0, right: 0,
                      width: 10, height: 10, borderRadius: '50%',
                      background: '#10B981', border: '2px solid #0B0F1C',
                    }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: '#E5E9F2', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {contact.name}
                    </span>
                    <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: '#64748B' }}>
                      {contact.lastMessageAt ? formatRelative(contact.lastMessageAt) : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      padding: '1px 5px', borderRadius: 5,
                      background: 'rgba(6,182,212,0.12)', color: '#06B6D4',
                      fontSize: 10, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', flexShrink: 0,
                    }}>
                      {LANG_LABELS[contact.currentLang]}
                    </span>
                    <span style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {contact.phone}
                    </span>
                    {contact.unread > 0 && (
                      <span style={{
                        minWidth: 17, height: 17, borderRadius: 9, background: '#2563EB',
                        color: '#fff', fontSize: 10, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', flexShrink: 0,
                      }}>
                        {contact.unread}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: '#64748B', fontSize: 13 }}>
              Nenhum contato encontrado
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

// ── Message Bubble ─────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: Message }) {
  const { showOriginal, toggleOriginal } = useStore();
  const isInbound = msg.direction === 'inbound';
  const showing   = showOriginal[msg.id];

  return (
    <motion.div
      variants={fadeUp} initial="hidden" animate="visible" layout
      style={{ display: 'flex', justifyContent: isInbound ? 'flex-start' : 'flex-end', marginBottom: 8, padding: '0 16px' }}
    >
      <div style={{ maxWidth: '72%' }}>
        {isInbound ? (
          <div style={{ background: '#161D2E', border: '1px solid rgba(148,163,184,0.10)', borderRadius: '4px 16px 16px 16px', padding: '10px 14px' }}>
            <p style={{ color: '#E5E9F2', fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
              {showing ? msg.originalText : msg.translatedText}
            </p>
            {msg.translationStatus === 'ok' && (
              <button onClick={() => toggleOriginal(msg.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', padding: 0 }}>
                {showing ? `← PT` : `🌐 Original (${LANG_LABELS[msg.originalLang]})`}
              </button>
            )}
            {msg.translationStatus === 'failed' && (
              <span style={{ color: '#EF4444', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>⚠ tradução falhou</span>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <span style={{ color: '#64748B', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>{formatTime(msg.timestamp)}</span>
            </div>
          </div>
        ) : (
          <div style={{ background: 'linear-gradient(135deg, #1D4ED8, #2563EB)', borderRadius: '16px 4px 16px 16px', padding: '10px 14px' }}>
            <p style={{ color: '#fff', fontSize: 13, lineHeight: 1.5, marginBottom: 2, opacity: 0.9 }}>{msg.originalText}</p>
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', marginTop: 6, paddingTop: 6 }}>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', marginRight: 4 }}>
                → {LANG_LABELS[msg.translatedLang]}:
              </span>
              <span style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>{msg.translatedText}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 4, alignItems: 'center' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>{formatTime(msg.timestamp)}</span>
              {msg.delivered && <span style={{ color: '#06B6D4', fontSize: 10 }}>✓✓</span>}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Chat Window ────────────────────────────────────────────────────────────
function ChatWindow() {
  const { activeContactId, contacts, messages, draft, setDraft, sendError, setSendError, workspace } = useStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socket = getSocket();

  const contact = contacts.find(c => c.id === activeContactId);
  const msgs    = activeContactId ? (messages[activeContactId] ?? []) : [];

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length]);

  const send = useCallback(() => {
    if (!draft.trim() || !activeContactId || !workspace) return;
    setSendError(null);
    socket?.emit('message:send', { workspaceId: workspace.id, contactId: activeContactId, text: draft.trim() });
    setDraft('');
  }, [draft, activeContactId, socket, workspace, setSendError, setDraft]);

  if (!contact) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: '#64748B' }}>
        <span style={{ fontSize: 48 }}>💬</span>
        <p style={{ fontSize: 14 }}>Selecione um contato para iniciar o atendimento</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        height: 64, flexShrink: 0, background: '#0B0F1C',
        borderBottom: '1px solid rgba(148,163,184,0.08)',
        display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px',
      }}>
        <div style={{ position: 'relative' }}>
          <div style={{ width: 38, height: 38, borderRadius: '50%', background: avatarColor(contact.id), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>
            {initials(contact.name)}
          </div>
          {contact.online && (
            <div style={{ position: 'absolute', bottom: 0, right: 0, width: 9, height: 9, borderRadius: '50%', background: '#10B981', border: '2px solid #0B0F1C' }} />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#E5E9F2' }}>{contact.name}</div>
          <div style={{ fontSize: 11, color: '#64748B' }}>{contact.phone} · {contact.online ? 'online' : 'offline'}</div>
        </div>
        <span style={{ padding: '4px 12px', borderRadius: 20, background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)', color: '#06B6D4', fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
          {LANG_LABELS[contact.currentLang]} {LANG_NAMES[contact.currentLang]}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
        <AnimatePresence>
          {msgs.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(148,163,184,0.08)', background: '#0B0F1C', flexShrink: 0 }}>
        {sendError && (
          <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#EF4444', fontSize: 12 }}>
            ⚠ {sendError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', background: '#161D2E', borderRadius: 14, border: '1px solid rgba(148,163,184,0.10)', padding: '8px 12px' }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Digite em português... (será traduzido automaticamente)"
            rows={1}
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#E5E9F2', fontSize: 13, resize: 'none', fontFamily: 'Manrope, sans-serif', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' }}
          />
          <motion.button
            variants={pop} initial="rest" whileHover="hover" whileTap="tap"
            onClick={send} disabled={!draft.trim()}
            style={{
              width: 36, height: 36, borderRadius: '50%',
              background: draft.trim() ? '#2563EB' : 'rgba(148,163,184,0.12)',
              border: 'none', cursor: draft.trim() ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'background 0.2s',
              color: draft.trim() ? '#fff' : '#64748B', fontSize: 16,
            }}
          >
            ➤
          </motion.button>
        </div>
        <p style={{ color: '#64748B', fontSize: 10, marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
          Enter para enviar · Shift+Enter nova linha · tradução → {LANG_NAMES[contact.currentLang]}
        </p>
      </div>
    </div>
  );
}

// ── Contact Panel (CRM) ────────────────────────────────────────────────────
function ContactPanel() {
  const { activeContactId, contacts, lists, updateContact, workspace } = useStore();
  const socket  = getSocket();
  const contact = contacts.find(c => c.id === activeContactId);

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput]     = useState('');
  const [noteInput, setNoteInput]     = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);

  useEffect(() => {
    if (contact) setNameInput(contact.name);
  }, [contact?.id]);

  if (!contact) return null;

  const currentList = lists.find(l => l.id === contact.listId);

  function emit(event: string, payload: object) {
    socket?.emit(event, { workspaceId: workspace?.id, ...payload });
  }

  function handleSaveName() {
    if (!nameInput.trim() || nameInput === contact!.name) { setEditingName(false); return; }
    emit('contact:rename', { contactId: contact!.id, name: nameInput.trim() });
    updateContact({ ...contact!, name: nameInput.trim() });
    setEditingName(false);
  }

  function handleLangChange(lang: LangCode) {
    emit('contact:setLang', { contactId: contact!.id, lang });
    updateContact({ ...contact!, currentLang: lang, autoDetectLang: false });
  }

  function handleMoveList(listId: string) {
    emit('contact:moveList', { contactId: contact!.id, listId });
    updateContact({ ...contact!, listId });
  }

  function handleAddNote() {
    if (!noteInput.trim()) return;
    emit('contact:addNote', { contactId: contact!.id, text: noteInput.trim() });
    setNoteInput('');
    setShowNoteInput(false);
  }

  function handleRemoveNote(noteId: string) {
    emit('contact:removeNote', { contactId: contact!.id, noteId });
  }

  return (
    <motion.div
      variants={slideLeftVariant} initial="hidden" animate="visible" exit="exit"
      style={{
        width: 290, flexShrink: 0, background: '#0B0F1C',
        borderLeft: '1px solid rgba(148,163,184,0.08)',
        overflowY: 'auto', padding: '20px 14px',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}
    >
      {/* Avatar + name edit */}
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 60, height: 60, borderRadius: '50%', background: avatarColor(contact.id),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, fontWeight: 800, color: '#fff', margin: '0 auto 10px',
        }}>
          {initials(contact.name)}
        </div>

        {editingName ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false); }}
              autoFocus
              style={{
                flex: 1, background: '#161D2E', border: '1px solid rgba(37,99,235,0.4)',
                borderRadius: 8, padding: '5px 8px', color: '#E5E9F2', fontSize: 13, outline: 'none', textAlign: 'center',
              }}
            />
            <motion.button variants={pop} initial="rest" whileHover="hover" whileTap="tap" onClick={handleSaveName} style={{ padding: '5px 8px', borderRadius: 8, background: '#2563EB', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}>✓</motion.button>
            <motion.button variants={pop} initial="rest" whileHover="hover" whileTap="tap" onClick={() => setEditingName(false)} style={{ padding: '5px 8px', borderRadius: 8, background: 'rgba(148,163,184,0.08)', border: 'none', color: '#64748B', fontSize: 11, cursor: 'pointer' }}>✕</motion.button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#E5E9F2' }}>{contact.name}</div>
            <motion.button variants={pop} initial="rest" whileHover="hover" whileTap="tap" onClick={() => { setNameInput(contact.name); setEditingName(true); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B', fontSize: 12, padding: '2px 4px' }}>✏</motion.button>
          </div>
        )}

        <div style={{ color: '#64748B', fontSize: 11, marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>+{contact.phone}</div>
      </div>

      {/* Language */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Idioma do Cliente</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {(Object.keys(LANG_LABELS) as LangCode[]).map(lang => (
            <motion.button
              key={lang} variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={() => handleLangChange(lang)}
              style={{
                padding: '3px 8px', borderRadius: 7, fontSize: 10, fontWeight: 700,
                fontFamily: 'JetBrains Mono, monospace', cursor: 'pointer',
                background: contact.currentLang === lang ? 'rgba(6,182,212,0.2)' : 'rgba(148,163,184,0.08)',
                color: contact.currentLang === lang ? '#06B6D4' : '#64748B',
                border: contact.currentLang === lang ? '1px solid rgba(6,182,212,0.4)' : '1px solid transparent',
              }}
            >
              {lang.toUpperCase()}
            </motion.button>
          ))}
        </div>
      </div>

      {/* CRM Stage */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Estágio CRM</div>
        {currentList && (
          <div style={{ padding: '5px 10px', borderRadius: 7, marginBottom: 7, background: `${currentList.color}15`, border: `1px solid ${currentList.color}40`, color: currentList.color, fontSize: 11, fontWeight: 600, textAlign: 'center' }}>
            {currentList.name}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {lists.map(list => (
            <motion.button
              key={list.id} variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={() => handleMoveList(list.id)}
              style={{
                padding: '7px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', textAlign: 'left',
                background: contact.listId === list.id ? `${list.color}18` : 'rgba(148,163,184,0.06)',
                color: contact.listId === list.id ? list.color : '#94A3B8',
                border: contact.listId === list.id ? `1px solid ${list.color}40` : '1px solid transparent',
              }}
            >
              {contact.listId === list.id ? '✓ ' : ''}{list.name}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Notes / Cards */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Anotações</div>
          <motion.button
            variants={pop} initial="rest" whileHover="hover" whileTap="tap"
            onClick={() => setShowNoteInput(v => !v)}
            style={{ background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(37,99,235,0.3)', color: '#60A5FA', fontSize: 10, fontWeight: 700, borderRadius: 7, padding: '3px 8px', cursor: 'pointer' }}
          >
            + Adicionar
          </motion.button>
        </div>

        <AnimatePresence>
          {showNoteInput && (
            <motion.div variants={fadeUp} initial="hidden" animate="visible" exit="exit" style={{ marginBottom: 8 }}>
              <textarea
                value={noteInput}
                onChange={e => setNoteInput(e.target.value)}
                placeholder="Digite uma anotação..."
                rows={3}
                autoFocus
                style={{
                  width: '100%', background: '#161D2E', border: '1px solid rgba(37,99,235,0.3)',
                  borderRadius: 10, padding: '8px 10px', color: '#E5E9F2', fontSize: 12,
                  resize: 'none', outline: 'none', fontFamily: 'Manrope, sans-serif',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <motion.button
                  variants={pop} initial="rest" whileHover="hover" whileTap="tap"
                  onClick={handleAddNote}
                  style={{ flex: 1, padding: '6px 0', borderRadius: 8, background: '#2563EB', border: 'none', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >
                  Salvar
                </motion.button>
                <motion.button
                  variants={pop} initial="rest" whileHover="hover" whileTap="tap"
                  onClick={() => { setShowNoteInput(false); setNoteInput(''); }}
                  style={{ padding: '6px 12px', borderRadius: 8, background: 'rgba(148,163,184,0.08)', border: 'none', color: '#64748B', fontSize: 11, cursor: 'pointer' }}
                >
                  Cancelar
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {(contact.notes ?? []).length === 0 && !showNoteInput && (
            <div style={{ color: '#475569', fontSize: 11, textAlign: 'center', padding: '12px 0' }}>
              Nenhuma anotação ainda
            </div>
          )}
          {(contact.notes ?? []).map((note: ContactNote) => (
            <motion.div
              key={note.id} variants={fadeUp} initial="hidden" animate="visible" exit="exit" layout
              style={{ background: '#161D2E', borderRadius: 10, padding: '10px 12px', marginBottom: 6, border: '1px solid rgba(148,163,184,0.08)', position: 'relative' }}
            >
              <p style={{ color: '#CBD5E1', fontSize: 12, lineHeight: 1.5, margin: 0, paddingRight: 20 }}>{note.text}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span style={{ color: '#475569', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                  {new Date(note.createdAt).toLocaleDateString('pt-BR')}
                </span>
                <motion.button
                  variants={pop} initial="rest" whileHover="hover" whileTap="tap"
                  onClick={() => handleRemoveNote(note.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444', fontSize: 12, padding: '0 2px' }}
                >
                  🗑
                </motion.button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Info */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Detalhes</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[
            ['Telefone', `+${contact.phone}`],
            ['País', contact.country ?? '—'],
            ['Status', contact.online ? 'Online' : 'Offline'],
            ['Cadastro', new Date(contact.createdAt).toLocaleDateString('pt-BR')],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#64748B', fontSize: 11 }}>{label}</span>
              <span style={{ color: '#94A3B8', fontSize: 11, fontFamily: label === 'Telefone' ? 'JetBrains Mono, monospace' : undefined }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ── App Root ───────────────────────────────────────────────────────────────
export default function App() {
  const {
    workspace, workspaceList,
    setWorkspace, setWorkspaceList,
    setContacts, setMessages, setLists,
    setWaStatus, setQr, waStatus, qrCode,
    ingestMessage, updateContact, upsertList, removeList, setSendError,
    activeContactId,
  } = useStore();

  const [showQrModal, setShowQrModal] = useState(false);

  useEffect(() => {
    let socket: typeof socketInstance;

    initSocket().then((s) => {
      socket = s;

      socket.on('workspace:list', (list: WorkspaceInfo[]) => setWorkspaceList(list));
      socket.on('workspace:joined', (info: WorkspaceInfo) => setWorkspace(info));

      socket.on('wa:status', (status: WaStatus) => setWaStatus(status));
      socket.on('wa:qr', (qr: string) => { setQr(qr); setShowQrModal(true); });

      socket.on('bootstrap', (data: { contacts: Contact[]; messages: Record<string, Message[]>; lists: CrmList[] }) => {
        setContacts(data.contacts);
        setMessages(data.messages);
        setLists(data.lists);
      });

      socket.on('message:new', (msg: Message) => ingestMessage(msg));
      socket.on('message:error', ({ error }: { contactId: string; error: string }) => setSendError(error));
      socket.on('contact:updated', (c: Contact) => { if (c) updateContact(c); });
      socket.on('list:created', (l: CrmList) => upsertList(l));
      socket.on('list:updated', (l: CrmList) => upsertList(l));
      socket.on('list:deleted', ({ listId }: { listId: string }) => removeList(listId));
    });

    return () => {
      socket?.off('workspace:list');
      socket?.off('workspace:joined');
      socket?.off('wa:status');
      socket?.off('wa:qr');
      socket?.off('bootstrap');
      socket?.off('message:new');
      socket?.off('message:error');
      socket?.off('contact:updated');
      socket?.off('list:created');
      socket?.off('list:updated');
      socket?.off('list:deleted');
    };
  }, [setWorkspaceList, setWorkspace, setWaStatus, setQr, setContacts, setMessages, setLists, ingestMessage, setSendError, updateContact, upsertList, removeList]);

  function handleLeave() {
    setWorkspace(null);
    setContacts([]);
    setMessages({});
    setLists([]);
    setWaStatus('disconnected');
    setQr(null);
    getSocket()?.emit('workspace:list:get');
  }

  if (!workspace) {
    return <WorkspaceScreen />;
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0A0E1A' }}>
      <TopBar onQrClick={() => setShowQrModal(true)} onLeave={handleLeave} />

      <AnimatePresence>
        {showQrModal && (
          <QRModal
            qr={qrCode}
            status={waStatus}
            workspaceId={workspace.id}
            onClose={() => setShowQrModal(false)}
          />
        )}
      </AnimatePresence>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <ConversationList />
        <ChatWindow />
        <AnimatePresence>
          {activeContactId && <ContactPanel key={activeContactId} />}
        </AnimatePresence>
      </div>
    </div>
  );
}
