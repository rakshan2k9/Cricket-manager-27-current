import { useEffect, useState } from 'react';
import { Check, CheckCheck, MailOpen, ArrowRight } from 'lucide-react';
import type { LeagueStateSnapshot } from '../types/game';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import type { ActiveTab } from '../components/AppShell';

export function InboxView({
  state,
  onRefreshState,
  onNavigate,
}: {
  state: LeagueStateSnapshot;
  onRefreshState: () => Promise<void>;
  onNavigate: (tab: ActiveTab) => void;
}) {
  const { user } = useAuth();
  const [subFilter, setSubFilter] = useState<'all' | 'unread'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(
    state.notifications[0]?.id ?? null
  );
  const [marking, setMarking] = useState(false);

  const visibleMessages = state.notifications.filter((n) => {
    if (subFilter === 'unread') {
      return !(n.readByUidsJson || []).includes(user?.uid || '');
    }
    return true;
  });

  const activeMessage =
    visibleMessages.find((n) => n.id === selectedId) || visibleMessages[0] || null;

  useEffect(() => {
    if (visibleMessages.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const curIdx = Math.max(
        0,
        visibleMessages.findIndex((m) => m.id === (activeMessage?.id ?? null))
      );
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = visibleMessages[(curIdx + 1) % visibleMessages.length];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = visibleMessages[(curIdx - 1 + visibleMessages.length) % visibleMessages.length];
        if (prev) setSelectedId(prev.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleMessages, activeMessage?.id]);

  const handleMarkAllRead = async () => {
    setMarking(true);
    try {
      await apiFetch(`/api/leagues/${state.league.id}/notifications/read`, {
        method: 'POST',
      });
      await onRefreshState();
    } finally {
      setMarking(false);
    }
  };

  const formatShortDate = (iso: string) => {
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${mon}`;
  };

  const suggestActionForMessage = (category: string): { label: string; tab: ActiveTab } | null => {
    const cat = category.toLowerCase();
    if (cat.includes('director')) return { label: 'Open Squad & Lineups', tab: 'squad' };
    if (cat.includes('chief')) return { label: 'Open Coaching Staff', tab: 'squad' };
    if (cat.includes('academy') || cat.includes('scout'))
      return { label: 'Open Scouting Network', tab: 'scouts' };
    if (cat.includes('auction')) return { label: 'Go to Auction Floor', tab: 'auction' };
    return { label: 'View Teams & Board', tab: 'franchises' };
  };

  return (
    <div className="space-y-4">
      {/* Top Sub-bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
        <div className="flex items-center gap-4">
          <h1 className="font-condensed text-3xl font-extrabold text-white uppercase">
            CLUB INBOX
          </h1>
          <div className="flex items-center gap-1 border-b border-transparent text-xs">
            <button
              onClick={() => setSubFilter('all')}
              className={`px-3 py-1.5 border-b-2 cursor-pointer transition-colors whitespace-nowrap ${
                subFilter === 'all'
                  ? 'border-[#93E6EE] text-white font-semibold'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              All ({state.notifications.length})
            </button>
            <button
              onClick={() => setSubFilter('unread')}
              className={`px-3 py-1.5 border-b-2 cursor-pointer transition-colors whitespace-nowrap ${
                subFilter === 'unread'
                  ? 'border-[#93E6EE] text-white font-semibold'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              Unread
            </button>
          </div>
        </div>

        <button
          onClick={handleMarkAllRead}
          disabled={marking}
          className="cm27-btn-dark-3d px-3.5 py-1.5 rounded text-xs text-slate-200 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
        >
          <CheckCheck className="w-3.5 h-3.5 text-[#93E6EE]" />
          <span>{marking ? 'Updating...' : 'Mark All Read'}</span>
        </button>
      </div>

      {/* Split Master-Detail Reader matching Reference Image */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[540px]">
        {/* Left List */}
        <div className="lg:col-span-5 space-y-1.5 max-h-[640px] overflow-y-auto pr-1">
          {visibleMessages.length === 0 ? (
            <div className="cm27-panel p-8 text-center text-xs text-slate-500">
              Inbox clear — no matching dispatches.
            </div>
          ) : (
            visibleMessages.map((msg) => {
              const selected = activeMessage?.id === msg.id;
              const isRead = (msg.readByUidsJson || []).includes(user?.uid || '');
              return (
                <button
                  key={msg.id}
                  onClick={() => setSelectedId(msg.id)}
                  className={`cm27-hover-sweep w-full text-left px-4 py-3.5 rounded border transition-all flex items-center justify-between gap-3 cursor-pointer ${
                    selected
                      ? 'cm27-card-focus'
                      : 'bg-[#11151C]/92 border-white/[0.07] hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                        isRead
                          ? 'bg-[#22C55E] text-[#0B0E14]'
                          : 'bg-[#22C55E]/20 text-[#4ADE80] border border-[#22C55E]/60'
                      }`}
                    >
                      <Check className="w-3 h-3 stroke-[3]" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-bold text-white truncate">
                        {msg.category}
                      </div>
                      <div
                        className={`text-xs truncate mt-0.5 ${
                          selected ? 'text-[#93E6EE] font-medium' : 'text-slate-400'
                        }`}
                      >
                        {msg.title}
                      </div>
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400 shrink-0 tabular-nums">
                    {formatShortDate(msg.createdAt)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Right Full Memo Reader */}
        <div className="lg:col-span-7 cm27-panel p-6 sm:p-8 flex flex-col justify-between">
          {activeMessage ? (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] pb-4">
                <div>
                  <h2 className="text-lg font-bold text-white">{activeMessage.category}</h2>
                  <p className="text-sm text-slate-400 mt-0.5">{activeMessage.title}</p>
                </div>
                <span className="text-xs font-mono text-slate-400 tabular-nums">
                  {formatShortDate(activeMessage.createdAt)}
                </span>
              </div>

              <div className="text-sm text-slate-200 leading-relaxed whitespace-pre-line font-normal max-w-2xl">
                {activeMessage.body}
              </div>
            </div>
          ) : (
            <div className="m-auto text-center space-y-2 text-slate-500">
              <MailOpen className="w-8 h-8 mx-auto opacity-50" />
              <p className="text-xs">Select an inbox dispatch to read its briefing.</p>
            </div>
          )}

          {activeMessage && (() => {
            const action = suggestActionForMessage(activeMessage.category);
            if (!action) return null;
            return (
              <div className="pt-6 border-t border-white/[0.06] flex justify-end">
                <button
                  onClick={() => onNavigate(action.tab)}
                  className="cm27-btn-3d px-4 py-2 rounded text-xs font-bold flex items-center gap-2 cursor-pointer whitespace-nowrap"
                >
                  <span>{action.label}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
