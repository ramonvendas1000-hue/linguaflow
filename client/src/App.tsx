import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { fadeUp, fadeIn, pop, staggerContainer, spring } from './lib/motion';
import { mockContacts, mockMessages, mockLists } from './mockData';
import type { Contact, Message, CrmList, LangCode, WaStatus } from './types';

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

interface AppState {
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
        ? existing.map(m => m.id === msg.id ? msg : m)
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
          c.id === msg.contactId
            ? { ...c, lastMessageAt: msg.timestamp, unread }
            : c
        ),
      };
    }),

  updateContact: (contact) =>
    set((s) => ({
      contacts: s.contacts.some(c => c.id === contact.id)
        ? s.contacts.map(c => c.id === contact.id ? contact : c)
        : [...s.contacts, contact],
    })),

  upsertList: (list) =>
    set((s) => ({
      lists: s.lists.some(l => l.id === list.id)
        ? s.lists.map(l => l.id === list.id ? list : l)
        : [...s.lists, list],
    })),

  removeList: (listId) =>
    set((s) => ({ lists: s.lists.filter(l => l.id !== listId) })),

  toggleOriginal: (msgId) =>
    set((s) => ({ showOriginal: { ...s.showOriginal, [msgId]: !s.showOriginal[msgId] } })),

  markRead: (contactId) =>
    set((s) => ({
      contacts: s.contacts.map(c => c.id === contactId ? { ...c, unread: 0 } : c),
    })),
}));

const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true';

let socketInstance: Socket | null = null;

async function initSocket(): Promise<Socket | null> {
  if (IS_DEMO) return null;
  if (socketInstance) return socketInstance;
  const { io } = await import('socket.io-client');
  // In dev: VITE_SERVER_URL points to the backend (port 4000).
  // In prod: Express serves both frontend and API on the same origin, so we connect to window.location.origin.
  const url = import.meta.env.VITE_SERVER_URL
    ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');
  socketInstance = io(url, { transports: ['websocket', 'polling'], autoConnect: true });
  return socketInstance;
}

function getSocket(): Socket | null {
  return socketInstance;
}

function QRCodeScreen({ qr, status }: { qr: string | null; status: WaStatus }) {
  return (
    <motion.div
      variants={fadeIn}
      initial="hidden"
      animate="visible"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 24,
        background: '#0A0E1A',
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 800, color: '#E5E9F2', letterSpacing: '-0.5px' }}>
        🌐 LinguaFlow
      </div>
      <div style={{
        background: '#161D2E',
        borderRadius: 16,
        padding: 24,
        border: '1px solid rgba(148,163,184,0.10)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
      }}>
        {qr ? (
          <img src={qr} alt="QR Code WhatsApp" style={{ width: 240, height: 240, borderRadius: 8 }} />
        ) : (
          <div style={{
            width: 240, height: 240, borderRadius: 8,
            background: '#0B0F1C',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12,
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              border: '3px solid #2563EB',
              borderTopColor: 'transparent',
              animation: 'spin 1s linear infinite',
            }} />
            <span style={{ color: '#94A3B8', fontSize: 13 }}>
              {status === 'connecting' ? 'Conectando...' : 'Aguardando QR...'}
            </span>
          </div>
        )}
        <div style={{
          padding: '6px 14px',
          borderRadius: 20,
          background: status === 'open' ? 'rgba(16,185,129,0.15)' : 'rgba(37,99,235,0.15)',
          color: status === 'open' ? '#10B981' : '#06B6D4',
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {status === 'open' ? '● CONECTADO' : status === 'connecting' ? '◌ CONECTANDO' : '○ AGUARDANDO'}
        </div>
      </div>
      <p style={{ color: '#64748B', fontSize: 13, textAlign: 'center', maxWidth: 280 }}>
        Abra o WhatsApp no seu celular → Dispositivos conectados → Conectar dispositivo
      </p>
    </motion.div>
  );
}

function TopBar({ waStatus, onQrClick }: { waStatus: WaStatus; onQrClick: () => void }) {
  const statusColor = waStatus === 'open' ? '#10B981' : waStatus === 'connecting' ? '#F59E0B' : '#EF4444';
  const statusLabel = waStatus === 'open' ? 'Conectado' : waStatus === 'connecting' ? 'Conectando' : 'Desconectado';

  return (
    <div style={{
      height: 60,
      background: '#0B0F1C',
      borderBottom: '1px solid rgba(148,163,184,0.08)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      gap: 12,
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 20, fontWeight: 800, color: '#E5E9F2', letterSpacing: '-0.5px', flex: 1 }}>
        🌐 LinguaFlow
      </span>

      <motion.button
        variants={pop}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        onClick={onQrClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', borderRadius: 20,
          background: `${statusColor}18`,
          border: `1px solid ${statusColor}40`,
          color: statusColor,
          fontSize: 11, fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 8 }}>●</span>
        {statusLabel}
      </motion.button>

      {IS_DEMO && (
        <div style={{
          padding: '5px 12px', borderRadius: 20,
          background: 'rgba(245,158,11,0.15)',
          border: '1px solid rgba(245,158,11,0.35)',
          color: '#F59E0B',
          fontSize: 11, fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          MODO DEMO
        </div>
      )}
      <div style={{
        padding: '5px 12px', borderRadius: 20,
        background: 'rgba(6,182,212,0.12)',
        border: '1px solid rgba(6,182,212,0.25)',
        color: '#06B6D4',
        fontSize: 11, fontWeight: 700,
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        DeepL + GPT-4o
      </div>

      <div style={{
        width: 34, height: 34, borderRadius: '50%',
        background: '#2563EB',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700, color: '#fff',
      }}>
        OP
      </div>
    </div>
  );
}

function ConversationList() {
  const { contacts, lists, listFilter, searchQuery, activeContactId, setActiveContact, setListFilter, setSearchQuery, markRead } = useStore();
  const socket = getSocket(); // null in demo mode

  const filtered = contacts
    .filter(c => !listFilter || c.listId === listFilter)
    .filter(c => !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.phone.includes(searchQuery))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  function handleSelect(id: string) {
    setActiveContact(id);
    markRead(id);
    socket?.emit('chat:read', { contactId: id });
  }

  return (
    <div style={{
      width: 320,
      background: '#0B0F1C',
      borderRight: '1px solid rgba(148,163,184,0.08)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(148,163,184,0.06)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#161D2E', borderRadius: 10,
          padding: '8px 12px',
          border: '1px solid rgba(148,163,184,0.08)',
        }}>
          <span style={{ color: '#64748B', fontSize: 14 }}>🔍</span>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Buscar contatos..."
            style={{
              background: 'none', border: 'none', outline: 'none',
              color: '#E5E9F2', fontSize: 13, flex: 1,
            }}
          />
        </div>
      </div>

      <div style={{
        padding: '8px 12px',
        display: 'flex', gap: 6, flexWrap: 'wrap',
        borderBottom: '1px solid rgba(148,163,184,0.06)',
      }}>
        <motion.button
          variants={pop} initial="rest" whileHover="hover" whileTap="tap"
          onClick={() => setListFilter(null)}
          style={{
            padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
            cursor: 'pointer',
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
              padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
              cursor: 'pointer',
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
                key={contact.id}
                variants={fadeUp}
                layout
                onClick={() => handleSelect(contact.id)}
                style={{
                  padding: '12px 16px',
                  display: 'flex', alignItems: 'center', gap: 12,
                  cursor: 'pointer',
                  background: activeContactId === contact.id
                    ? 'rgba(37,99,235,0.10)'
                    : 'transparent',
                  borderLeft: activeContactId === contact.id
                    ? '3px solid #2563EB'
                    : '3px solid transparent',
                  transition: 'background 0.15s',
                }}
              >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: '50%',
                    background: avatarColor(contact.id),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 700, color: '#fff',
                  }}>
                    {initials(contact.name)}
                  </div>
                  {contact.online && (
                    <div style={{
                      position: 'absolute', bottom: 0, right: 0,
                      width: 10, height: 10, borderRadius: '50%',
                      background: '#10B981',
                      border: '2px solid #0B0F1C',
                    }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: '#E5E9F2', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {contact.name}
                    </span>
                    <span style={{
                      fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                      color: '#64748B',
                    }}>
                      {contact.lastMessageAt ? formatRelative(contact.lastMessageAt) : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      padding: '1px 6px', borderRadius: 6,
                      background: 'rgba(6,182,212,0.12)', color: '#06B6D4',
                      fontSize: 10, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
                      flexShrink: 0,
                    }}>
                      {LANG_LABELS[contact.currentLang]}
                    </span>
                    <span style={{ fontSize: 12, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {contact.phone}
                    </span>
                    {contact.unread > 0 && (
                      <span style={{
                        minWidth: 18, height: 18, borderRadius: 9,
                        background: '#2563EB', color: '#fff',
                        fontSize: 10, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 4px', flexShrink: 0,
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

function MessageBubble({ msg }: { msg: Message }) {
  const { showOriginal, toggleOriginal } = useStore();
  const isInbound = msg.direction === 'inbound';
  const showing = showOriginal[msg.id];

  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      layout
      style={{
        display: 'flex',
        justifyContent: isInbound ? 'flex-start' : 'flex-end',
        marginBottom: 8,
        padding: '0 16px',
      }}
    >
      <div style={{ maxWidth: '72%' }}>
        {isInbound ? (
          <div style={{
            background: '#161D2E',
            border: '1px solid rgba(148,163,184,0.10)',
            borderRadius: '4px 16px 16px 16px',
            padding: '10px 14px',
          }}>
            <p style={{ color: '#E5E9F2', fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
              {showing ? msg.originalText : msg.translatedText}
            </p>
            {msg.translationStatus === 'ok' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <button
                  onClick={() => toggleOriginal(msg.id)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: '#64748B', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                    padding: 0,
                  }}
                >
                  {showing ? `← PT: ${msg.translatedText.slice(0, 30)}...` : `🌐 Original (${LANG_LABELS[msg.originalLang]})`}
                </button>
              </div>
            )}
            {msg.translationStatus === 'failed' && (
              <span style={{ color: '#EF4444', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                ⚠ tradução falhou
              </span>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <span style={{ color: '#64748B', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                {formatTime(msg.timestamp)}
              </span>
            </div>
          </div>
        ) : (
          <div style={{
            background: 'linear-gradient(135deg, #1D4ED8, #2563EB)',
            borderRadius: '16px 4px 16px 16px',
            padding: '10px 14px',
          }}>
            <p style={{ color: '#fff', fontSize: 13, lineHeight: 1.5, marginBottom: 2, opacity: 0.9 }}>
              {msg.originalText}
            </p>
            <div style={{
              borderTop: '1px solid rgba(255,255,255,0.15)',
              marginTop: 6, paddingTop: 6,
            }}>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', marginRight: 4 }}>
                → {LANG_LABELS[msg.translatedLang]}:
              </span>
              <span style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
                {msg.translatedText}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 4, alignItems: 'center' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                {formatTime(msg.timestamp)}
              </span>
              {msg.delivered && <span style={{ color: '#06B6D4', fontSize: 10 }}>✓✓</span>}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ChatWindow() {
  const { activeContactId, contacts, messages, draft, setDraft, sendError, setSendError } = useStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socket = getSocket(); // null in demo mode

  const contact = contacts.find(c => c.id === activeContactId);
  const msgs = activeContactId ? (messages[activeContactId] ?? []) : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs.length]);

  const send = useCallback(() => {
    if (!draft.trim() || !activeContactId) return;
    setSendError(null);
    if (socket) {
      socket.emit('message:send', { contactId: activeContactId, text: draft.trim() });
    } else {
      setSendError('Modo demo — backend não conectado. Rode npm run dev localmente para enviar mensagens reais.');
    }
    setDraft('');
  }, [draft, activeContactId, socket, setSendError, setDraft]);

  if (!contact) {
    return (
      <div style={{
        flex: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12,
        color: '#64748B',
      }}>
        <span style={{ fontSize: 48 }}>💬</span>
        <p style={{ fontSize: 14 }}>Selecione um contato para iniciar o atendimento</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        height: 64, flexShrink: 0,
        background: '#0B0F1C',
        borderBottom: '1px solid rgba(148,163,184,0.08)',
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 20px',
      }}>
        <div style={{ position: 'relative' }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%',
            background: avatarColor(contact.id),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color: '#fff',
          }}>
            {initials(contact.name)}
          </div>
          {contact.online && (
            <div style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 9, height: 9, borderRadius: '50%',
              background: '#10B981', border: '2px solid #0B0F1C',
            }} />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#E5E9F2' }}>{contact.name}</div>
          <div style={{ fontSize: 11, color: '#64748B' }}>
            {contact.phone} · {contact.online ? 'online' : 'offline'}
          </div>
        </div>
        <span style={{
          padding: '4px 12px', borderRadius: 20,
          background: 'rgba(6,182,212,0.12)',
          border: '1px solid rgba(6,182,212,0.25)',
          color: '#06B6D4', fontSize: 12, fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {LANG_LABELS[contact.currentLang]} {LANG_NAMES[contact.currentLang]}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
        <AnimatePresence>
          {msgs.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid rgba(148,163,184,0.08)',
        background: '#0B0F1C',
        flexShrink: 0,
      }}>
        {sendError && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 8,
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#EF4444', fontSize: 12,
          }}>
            ⚠ {sendError}
          </div>
        )}
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-end',
          background: '#161D2E',
          borderRadius: 14,
          border: '1px solid rgba(148,163,184,0.10)',
          padding: '8px 12px',
        }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Digite em português... (será traduzido automaticamente)"
            rows={1}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: '#E5E9F2', fontSize: 13, resize: 'none',
              fontFamily: 'Manrope, sans-serif', lineHeight: 1.5,
              maxHeight: 120, overflowY: 'auto',
            }}
          />
          <motion.button
            variants={pop} initial="rest" whileHover="hover" whileTap="tap"
            onClick={send}
            disabled={!draft.trim()}
            style={{
              width: 36, height: 36, borderRadius: '50%',
              background: draft.trim() ? '#2563EB' : 'rgba(148,163,184,0.12)',
              border: 'none', cursor: draft.trim() ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'background 0.2s',
              color: draft.trim() ? '#fff' : '#64748B',
              fontSize: 16,
            }}
          >
            ➤
          </motion.button>
        </div>
        <p style={{ color: '#64748B', fontSize: 10, marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
          Enter para enviar · Shift+Enter nova linha · tradução automática → {LANG_NAMES[contact.currentLang]}
        </p>
      </div>
    </div>
  );
}

function ContactPanel() {
  const { activeContactId, contacts, lists, updateContact } = useStore();
  const socket = getSocket(); // null in demo mode
  const contact = contacts.find(c => c.id === activeContactId);

  if (!contact) return null;

  const currentList = lists.find(l => l.id === contact.listId);

  function handleLangChange(lang: LangCode) {
    if (!contact) return;
    socket?.emit('contact:setLang', { contactId: contact.id, lang });
    updateContact({ ...contact, currentLang: lang, autoDetectLang: false });
  }

  function handleMoveList(listId: string) {
    if (!contact) return;
    socket?.emit('contact:moveList', { contactId: contact.id, listId });
    updateContact({ ...contact, listId });
  }

  return (
    <motion.div
      variants={slideLeftVariant}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        width: 300, flexShrink: 0,
        background: '#0B0F1C',
        borderLeft: '1px solid rgba(148,163,184,0.08)',
        overflowY: 'auto',
        padding: '20px 16px',
        display: 'flex', flexDirection: 'column', gap: 20,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: avatarColor(contact.id),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 800, color: '#fff',
          margin: '0 auto 12px',
        }}>
          {initials(contact.name)}
        </div>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#E5E9F2' }}>{contact.name}</div>
        <div style={{ color: '#64748B', fontSize: 12, marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
          +{contact.phone}
        </div>
        {contact.country && (
          <div style={{ color: '#94A3B8', fontSize: 12, marginTop: 4 }}>
            📍 {contact.country}
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          Idioma do Cliente
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(Object.keys(LANG_LABELS) as LangCode[]).map(lang => (
            <motion.button
              key={lang}
              variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={() => handleLangChange(lang)}
              style={{
                padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
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

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          Estágio CRM
        </div>
        {currentList && (
          <div style={{
            padding: '6px 12px', borderRadius: 8, marginBottom: 8,
            background: `${currentList.color}15`,
            border: `1px solid ${currentList.color}40`,
            color: currentList.color, fontSize: 12, fontWeight: 600, textAlign: 'center',
          }}>
            {currentList.name}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {lists.map(list => (
            <motion.button
              key={list.id}
              variants={pop} initial="rest" whileHover="hover" whileTap="tap"
              onClick={() => handleMoveList(list.id)}
              style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
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

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          Detalhes
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            ['Telefone', `+${contact.phone}`],
            ['Idioma', LANG_NAMES[contact.currentLang]],
            ['País', contact.country ?? '—'],
            ['Status', contact.online ? 'Online' : 'Offline'],
            ['Cadastro', new Date(contact.createdAt).toLocaleDateString('pt-BR')],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#64748B', fontSize: 11 }}>{label}</span>
              <span style={{ color: '#94A3B8', fontSize: 12, fontFamily: label === 'Telefone' ? 'JetBrains Mono, monospace' : undefined }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

const slideLeftVariant = {
  hidden:  { x: '100%', opacity: 0 },
  visible: { x: 0, opacity: 1, transition: spring.smooth },
  exit:    { x: '100%', opacity: 0, transition: spring.snappy },
};

export default function App() {
  const {
    setContacts, setMessages, setLists,
    setWaStatus, setQr, waStatus, qrCode,
    ingestMessage, updateContact, upsertList, removeList,
    activeContactId, setSendError,
  } = useStore();

  const [showQrModal, setShowQrModal] = useState(false);

  useEffect(() => {
    if (IS_DEMO) {
      setContacts(mockContacts);
      setMessages(mockMessages);
      setLists(mockLists);
      return;
    }
    fetch('/api/bootstrap')
      .then(r => r.json())
      .then(data => {
        setContacts(data.contacts);
        setMessages(data.messages);
        setLists(data.lists);
      })
      .catch(() => {
        setContacts(mockContacts);
        setMessages(mockMessages);
        setLists(mockLists);
      });
  }, [setContacts, setMessages, setLists]);

  useEffect(() => {
    if (IS_DEMO) return;
    let socket: Socket | null = null;

    initSocket().then((s) => {
      if (!s) return;
      socket = s;
      socket.on('wa:status', (status: WaStatus) => setWaStatus(status));
      socket.on('wa:qr', (qr: string) => { setQr(qr); setShowQrModal(true); });
      socket.on('message:new', (msg: Message) => ingestMessage(msg));
      socket.on('message:error', ({ error }: { contactId: string; error: string }) => setSendError(error));
      socket.on('contact:updated', (c: Contact) => updateContact(c));
      socket.on('list:created', (l: CrmList) => upsertList(l));
      socket.on('list:updated', (l: CrmList) => upsertList(l));
      socket.on('list:deleted', ({ listId }: { listId: string }) => removeList(listId));
      socket.on('bootstrap', (data: { contacts: Contact[]; messages: Record<string, Message[]>; lists: CrmList[] }) => {
        setContacts(data.contacts);
        setMessages(data.messages);
        setLists(data.lists);
      });
    });

    return () => {
      socket?.off('wa:status');
      socket?.off('wa:qr');
      socket?.off('message:new');
      socket?.off('message:error');
      socket?.off('contact:updated');
      socket?.off('list:created');
      socket?.off('list:updated');
      socket?.off('list:deleted');
      socket?.off('bootstrap');
    };
  }, [setWaStatus, setQr, ingestMessage, setSendError, updateContact, upsertList, removeList, setContacts, setMessages, setLists]);

  const needsQr = waStatus !== 'open' && qrCode;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0A0E1A' }}>
      <TopBar waStatus={waStatus} onQrClick={() => setShowQrModal(true)} />

      <AnimatePresence>
        {showQrModal && waStatus !== 'open' && (
          <motion.div
            variants={backdropVariant}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={() => setShowQrModal(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 50,
              background: 'rgba(0,0,0,0.8)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <motion.div
              variants={modalVariant}
              onClick={e => e.stopPropagation()}
              style={{ width: 360 }}
            >
              <QRCodeScreen qr={qrCode} status={waStatus} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {needsQr && !showQrModal ? null : null}

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
