import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Compass,
  Dumbbell,
  FileText,
  Gavel,
  Mail,
  MessageSquare,
  Newspaper,
  Play,
  Shield,
  Sparkles,
  Swords,
  TrendingUp,
  Trophy,
  Users,
} from 'lucide-react';
import type { LeagueStateSnapshot } from '../types/game';
import {
  formatCurrencyLakhs,
  formatTimeAgo,
  getCompetitionDisplayLabel,
  getFormatDisplayLabel,
  getLeagueFormats,
} from '../utils/format';
import { useAuth } from '../context/AuthContext';
import { TeamCrest } from '../components/TeamCrest';
import { apiFetch } from '../lib/api';
import type { ActiveTab } from '../components/AppShell';

export type { ActiveTab };

export function DashboardView({
  state,
  onNavigate,
  onInspectTeam,
  onRefreshState,
}: {
  state: LeagueStateSnapshot;
  onNavigate: (tab: ActiveTab) => void;
  onInspectTeam: (teamId: number) => void;
  onRefreshState?: () => Promise<void>;
}) {
  const { user, profile } = useAuth();
  const [socialIdx, setSocialIdx] = useState(0);
  const [upgradingPool, setUpgradingPool] = useState(false);
  const [startingAuction, setStartingAuction] = useState(false);
  const [auctionError, setAuctionError] = useState<string | null>(null);
  const [focusedActionIdx, setFocusedActionIdx] = useState(0);

  const currency = profile?.preferredCurrency || 'INR';
  const myTeam = state.myTeam;
  const auction = state.auctionSnapshot;
  const totalPlayers = auction?.counts.total ?? 0;
  const isHost = state.league.myRole === 'host' || state.league.hostUid === user?.uid;
  const bookmarkedCount = (myTeam?.bookmarkedPlayerIdsJson || []).length;
  const allowedFormats = getLeagueFormats(
    myTeam?.leagueCategory,
    state.league.primaryCompetition
  );
  const primaryFormatLabel = getFormatDisplayLabel(allowedFormats[0]);
  const recentMatches = state.matches || [];

  const unreadInbox = state.notifications.filter(
    (n) => !(n.readByUidsJson || []).includes(user?.uid || '')
  ).length;
  const latestNews = (state.newsFeed || [])[0] || null;
  const pendingIncomingTrades = (state.tradeOffers || []).filter(
    (o) => myTeam && o.recipientTeamId === myTeam.id && o.status === 'pending'
  ).length;
  const pendingPressCount = (state.matches || []).filter(
    (m) => myTeam && (m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id) && !m.pressConferenceCompleted
  ).length;

  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const dayDurationSec = Math.max(60, state.league.dayDurationSec || 600);
  const { currentGameDay, nextDayInSec } = useMemo(() => {
    if (!state.league.seasonStartedAt) {
      return {
        currentGameDay: state.currentGameDay || 1,
        nextDayInSec: state.nextDayInSec || dayDurationSec,
      };
    }
    const startMs = new Date(state.league.seasonStartedAt).getTime();
    if (!Number.isFinite(startMs)) {
      return {
        currentGameDay: state.currentGameDay || 1,
        nextDayInSec: state.nextDayInSec || dayDurationSec,
      };
    }
    const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    const day = Math.floor(elapsedSec / dayDurationSec) + 1;
    const nextIn = dayDurationSec - (elapsedSec % dayDurationSec);
    return { currentGameDay: day, nextDayInSec: nextIn };
  }, [nowMs, state.league.seasonStartedAt, dayDurationSec, state.currentGameDay, state.nextDayInSec]);

  const countdownLabel = `${String(Math.floor(nextDayInSec / 60)).padStart(2, '0')}:${String(
    nextDayInSec % 60
  ).padStart(2, '0')}`;

  const teamById = useMemo(
    () => new Map(state.teams.map((t) => [t.id, t])),
    [state.teams]
  );

  const fixturesList = state.fixtures || [];
  const standingsList = state.standings || [];

  const nextUserFixture = useMemo(() => {
    if (!myTeam) return null;
    const mine = fixturesList.filter(
      (fx) => (fx.homeTeamId === myTeam.id || fx.awayTeamId === myTeam.id) && fx.status !== 'completed'
    );
    const liveOrLobby = mine.find(
      (fx) => fx.status === 'live' || fx.status === 'paused' || fx.status === 'lobby'
    );
    return liveOrLobby || mine[0] || null;
  }, [fixturesList, myTeam]);

  const nextUserOpponent = nextUserFixture && myTeam
    ? teamById.get(
        nextUserFixture.homeTeamId === myTeam.id
          ? nextUserFixture.awayTeamId
          : nextUserFixture.homeTeamId
      ) || null
    : null;
  const isNextUserPvp = Boolean(nextUserOpponent?.ownerUid);

  const allowedLeagues = new Set([
    'IPL',
    'PSL',
    'SA20',
    'International',
    'BBL',
    'The Hundred',
  ]);
  const hasLegacyTeams = state.teams.some(
    (t) => !t.isCustom && !allowedLeagues.has(t.leagueCategory)
  );
  const needsRealUpgrade = hasLegacyTeams || totalPlayers < 80;

  const handleUpgradeRealPool = async () => {
    setUpgradingPool(true);
    try {
      await apiFetch(`/api/leagues/${state.league.id}/upgrade-real-pool`, {
        method: 'POST',
      });
      if (onRefreshState) await onRefreshState();
    } catch {
      // handled gracefully
    } finally {
      setUpgradingPool(false);
    }
  };

  const handleStartAuctionNow = async () => {
    setStartingAuction(true);
    setAuctionError(null);
    try {
      await apiFetch(`/api/leagues/${state.league.id}/auction/start`, {
        method: 'POST',
      });
      if (onRefreshState) await onRefreshState();
      onNavigate('auction');
    } catch (err: any) {
      setAuctionError(err.message || 'Claim a club first to start the auction.');
    } finally {
      setStartingAuction(false);
    }
  };

  // Interactive "Actions Required" stack matching Image 6
  const actionRows: {
    id: string;
    label: string;
    sublabel?: string;
    icon: any;
    urgent?: boolean;
    onClick: () => void;
  }[] = [
    ...(!myTeam
      ? [
          {
            id: 'claim-team',
            label: `Select Your Club (${getCompetitionDisplayLabel(state.league.primaryCompetition)}) — tap to claim`,
            sublabel: `${state.teams.length} authentic clubs ready · Formats: ${allowedFormats.map(getFormatDisplayLabel).join(' / ')}`,
            icon: Shield,
            urgent: true,
            onClick: () => onNavigate('franchises'),
          },
        ]
      : [
          {
            id: 'play-match',
            label: nextUserFixture
              ? isNextUserPvp
                ? `${nextUserFixture.status === 'live' ? 'LIVE PVP NOW' : `DAY ${nextUserFixture.scheduledDay} PVP MATCH`}: ${myTeam.shortCode} vs ${nextUserOpponent?.shortCode} (${nextUserOpponent?.ownerName || 'Friend'})`
                : `Match #${nextUserFixture.matchNumber} (Day ${nextUserFixture.scheduledDay}): ${myTeam.shortCode} vs ${nextUserOpponent?.shortCode} (CPU)`
              : `Play Match vs Opponent (${primaryFormatLabel}) — set XI & toss`,
            sublabel: isNextUserPvp
              ? 'Real-time friend fixture — PvP room locks both XIs and syncs live tactics (never AI-simulated)'
              : `${myTeam.name} Matchday Center · Compare lineups, win probability & simulate match`,
            icon: Swords,
            urgent: true,
            onClick: () => onNavigate('matchday'),
          },
          {
            id: 'lineup',
            label: `Confirm lineup — ${myTeam.shortCode} (${allowedFormats.map(getFormatDisplayLabel).join(' / ')}) · tap to set XI`,
            sublabel: `${myTeam.squadCount ?? 0}/${state.league.maxSquadSize} contracted · Open Team Sheets`,
            icon: FileText,
            onClick: () => onNavigate('squad'),
          },
        ]),
    {
      id: 'auction-lot',
      label:
        auction?.auction.status === 'live' && auction.currentPlayer
          ? `LIVE LOT: ${auction.currentPlayer.name} (${auction.auction.currentSetName || 'Marquee Set'})`
          : `Enter Auction Room (${auction?.counts.pending ?? 0} players in pool)`,
      sublabel: `${bookmarkedCount} scouted targets bookmarked · ${getCompetitionDisplayLabel(state.league.primaryCompetition)} eligible pool`,
      icon: Gavel,
      onClick: () => onNavigate('auction'),
    },
    ...(pendingIncomingTrades > 0
      ? [
          {
            id: 'pending-trades',
            label: `${pendingIncomingTrades} Incoming Trade Proposal${pendingIncomingTrades > 1 ? 's' : ''} Waiting`,
            sublabel: 'Open Transfers Desk to review, accept, or decline club offers',
            icon: ArrowLeftRight,
            urgent: true,
            onClick: () => onNavigate('transfers'),
          },
        ]
      : []),
    ...(pendingPressCount > 0
      ? [
          {
            id: 'pending-press',
            label: `Post-Match Press Briefing Requested (${pendingPressCount} Match${pendingPressCount > 1 ? 'es' : ''})`,
            sublabel: 'Field questions from journalists to publish in The League Gazette',
            icon: Newspaper,
            onClick: () => onNavigate('gazette'),
          },
        ]
      : []),
    {
      id: 'scouts',
      label: `Deploy Scouting & Bookmark Targets (${bookmarkedCount} saved)`,
      sublabel: `${(myTeam?.hiredScoutsJson || []).length}/6 scouts hired · Bookmark stars to alert when they hit the auction`,
      icon: Compass,
      onClick: () => onNavigate('scouts'),
    },
    {
      id: 'inbox-board',
      label: `New Email From The Board — Season 2026/27 & Director Briefing`,
      sublabel: `${unreadInbox} unread operational dispatches`,
      icon: Mail,
      onClick: () => onNavigate('inbox'),
    },
  ];

  // Dynamic Club Social Feed slides matching Image 6 right column
  const topRival = state.teams.find((t) => t.id !== myTeam?.id) || state.teams[1] || state.teams[0];
  const socialSlides = [
    {
      handle: 'Cric Central',
      subhandle: '@criccentral · Just now',
      tag: 'BREAKING',
      tagBg: 'bg-[#EAB308] text-[#0D1014]',
      bannerTitle: 'NEW MANAGER LOCKED IN',
      headline: `${myTeam ? myTeam.name : state.league.name} confirm ${profile?.preferredName || profile?.managerName} at the helm`,
      body: `Board expectations are set: build a ruthless squad through the ${totalPlayers.toLocaleString()}-player auction pool and dominate all formats.`,
      hashtags: '#Breaking #CM27 #Operations',
      metrics: '♥ 1.4K   💬 184   ↗ 92',
      views: '18.2K views',
      vsMode: false,
    },
    {
      handle: myTeam ? myTeam.name : 'Club Insider',
      subhandle: `@${(myTeam?.shortCode || 'cm27').toLowerCase()}official · Today`,
      tag: 'TRAINING',
      tagBg: 'bg-[#2DD4BF]/25 text-[#5EEAD4] border border-[#2DD4BF]/40',
      bannerTitle: 'PRE-SEASON MATCH PREP',
      headline: 'BACK ON THE GRASS',
      body: `Intensive net sessions, tactical RPO drills, and scouting evaluations are underway ahead of ${state.league.name} Matchday 1.`,
      hashtags: `#Training #PreSeason #${myTeam?.shortCode || 'CM27'}`,
      metrics: '♥ 640   💬 52   ↗ 38',
      views: '5.4K views',
      vsMode: true,
    },
    {
      handle: 'Auction Wire',
      subhandle: '@cm27auction · Live',
      tag: 'MARQUEE',
      tagBg: 'bg-rose-500/25 text-rose-200 border border-rose-500/40',
      bannerTitle: `${totalPlayers.toLocaleString()} REAL PLAYERS`,
      headline: 'GLOBAL AUCTION POOL VERIFIED',
      body: 'Competition-authentic squads across IPL, PSL, SA20, BBL, The Hundred, and International Cricket are live.',
      hashtags: '#Auction27 #IPL #PSL #SA20 #GlobalCricket',
      metrics: '♥ 2.1K   💬 310   ↗ 204',
      views: '29.7K views',
      vsMode: false,
    },
  ];
  const activeSlide = socialSlides[socialIdx % socialSlides.length];

  const claimedManagers = state.teams.filter((t) => t.ownerUid);

  useEffect(() => {
    if (actionRows.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedActionIdx((i) => (i + 1) % actionRows.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedActionIdx((i) => (i - 1 + actionRows.length) % actionRows.length);
      } else if (e.key === 'Enter') {
        const row = actionRows[focusedActionIdx];
        if (row) {
          e.preventDefault();
          row.onClick();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actionRows, focusedActionIdx]);

  return (
    <div className="space-y-6">
      {/* Real Player Pool Sync Banner */}
      {needsRealUpgrade && (
        <div className="cm27-panel p-4 border-amber-400/30 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-[#EAB308] shrink-0" />
            <div>
              <div className="text-sm font-semibold text-white">
                Sync Verified Real-Player Registry (6 Competitions)
              </div>
              <div className="text-xs text-slate-400">
                Updates this league with competition-exclusive franchises and authentic players across IPL, PSL, SA20, BBL, The Hundred &amp; Internationals.
              </div>
            </div>
          </div>
          <button
            onClick={handleUpgradeRealPool}
            disabled={upgradingPool}
            className="cm27-btn-3d px-4 py-2 rounded font-bold text-xs uppercase tracking-wider cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {upgradingPool ? 'Syncing Real Registry...' : 'Sync Real Registry'}
          </button>
        </div>
      )}

      {/* Host Start Live Auction Action Bar */}
      {isHost && auction?.auction.status === 'lobby' && (
        <div className="cm27-panel p-4 border-[#93E6EE]/35 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded bg-[#181E27] border border-white/15 flex items-center justify-center shrink-0">
              <Gavel className="w-4 h-4 text-[#93E6EE]" />
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#93E6EE] font-bold">
                HOST COMMISSIONER CONTROL
              </div>
              <div className="text-sm font-semibold text-white">
                Ready to Launch Live Player Auction ({totalPlayers.toLocaleString()} eligible players)
              </div>
              {auctionError && (
                <div className="text-xs text-rose-300 mt-0.5">{auctionError}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {!myTeam && (
              <button
                onClick={() => onNavigate('franchises')}
                className="cm27-btn-dark-3d px-3.5 py-2 rounded text-amber-300 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                Pick Your Club First
              </button>
            )}
            <button
              onClick={handleStartAuctionNow}
              disabled={startingAuction}
              className="cm27-btn-3d flex items-center gap-2 px-5 py-2 rounded disabled:opacity-50 font-bold text-xs uppercase tracking-wider cursor-pointer whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {startingAuction ? 'Starting Auction...' : 'Start Live Auction'}
            </button>
          </div>
        </div>
      )}

      {/* TOP HERO ROW: Season Day + Actions Required | Club Social Wire */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left 8 Columns: Day, Actions Required & Interactive Stack */}
        <div className="lg:col-span-7 xl:col-span-8 space-y-3.5">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/[0.08] pb-3.5">
            <div>
              <div className="flex flex-wrap items-baseline gap-3">
                <h1 className="font-condensed text-4xl sm:text-5xl font-extrabold tracking-tight text-white uppercase leading-none">
                  SEASON 1 · DAY {currentGameDay}
                </h1>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#93E6EE] tabular-nums">
                  <Clock className="w-3 h-3" />
                  <span>NEXT DAY {countdownLabel}</span>
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1.5">
                {getCompetitionDisplayLabel(state.league.primaryCompetition)} · {state.league.name} ·{' '}
                {myTeam ? `${myTeam.name} HQ` : 'Club Selection Open'} · Fast Calendar (10m/day)
              </p>
            </div>
            {myTeam && (
              <button
                onClick={() => onNavigate('matchday')}
                className="cm27-btn-3d flex items-center gap-2 px-4 py-2 rounded font-bold text-xs uppercase tracking-wider cursor-pointer whitespace-nowrap shrink-0"
              >
                <Swords className="w-3.5 h-3.5" />
                {isNextUserPvp && nextUserOpponent
                  ? `Enter Live PvP vs ${nextUserOpponent.shortCode}`
                  : 'Matchday & Schedule'}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-rose-300 font-semibold">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span>Actions Required</span>
            </div>
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">
              {unreadInbox} unread · {totalPlayers.toLocaleString()} players · {state.members.filter((m) => m.isOnline).length} online
            </span>
          </div>

          <div className="space-y-1.5">
            {actionRows.map((row, idx) => {
              const Icon = row.icon;
              const isFocused = focusedActionIdx === idx;
              return (
                <button
                  key={row.id}
                  onMouseEnter={() => setFocusedActionIdx(idx)}
                  onClick={row.onClick}
                  className={`cm27-hover-sweep w-full text-left px-4 py-3 rounded border flex items-center justify-between gap-3 cursor-pointer transition-all ${
                    isFocused
                      ? 'cm27-card-focus'
                      : row.urgent
                        ? 'bg-[#1A1417]/90 border-rose-500/35 hover:border-rose-400/60'
                        : 'bg-[#11151C]/92 border-white/[0.08] hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${
                        row.urgent
                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                          : 'bg-[#0C0F14] text-slate-300 border border-white/[0.08]'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-semibold text-white truncate">
                        {row.label}
                      </div>
                      {row.sublabel && (
                        <div className="text-[11px] text-slate-400 truncate mt-0.5">
                          {row.sublabel}
                        </div>
                      )}
                    </div>
                  </div>
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      row.urgent ? 'bg-rose-400' : isFocused ? 'bg-[#93E6EE]' : 'bg-slate-500'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Right 4 Columns: Club Social / Media Feed Card */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-2">
          <div className="cm27-panel p-4 space-y-3">
            {/* Social Header */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <TeamCrest
                  templateKey={myTeam?.templateKey}
                  shortCode={myTeam?.shortCode || 'CC'}
                  primaryColor={myTeam?.primaryColor}
                  secondaryColor={myTeam?.secondaryColor}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="text-xs font-bold text-white flex items-center gap-1.5 truncate">
                    <span>{activeSlide.handle}</span>
                    <span className="inline-block w-3 h-3 rounded-full bg-[#93E6EE] text-[8px] text-[#0B0E14] font-bold text-center leading-3">
                      ✓
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate">{activeSlide.subhandle}</div>
                </div>
              </div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">CLUB WIRE</span>
            </div>

            {/* Visual Match / Club Spotlight Box */}
            <div className="relative h-48 cm27-panel-inset overflow-hidden p-4 flex flex-col justify-between">
              <div
                className="absolute inset-0 pointer-events-none opacity-45"
                style={{
                  background:
                    'radial-gradient(circle at 25% 25%, rgba(148, 163, 184, 0.16), transparent 55%), radial-gradient(circle at 80% 80%, rgba(234, 179, 8, 0.08), transparent 55%)',
                }}
              />
              <div className="relative z-10 flex items-center justify-between">
                <span
                  className={`px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider rounded ${activeSlide.tagBg}`}
                >
                  {activeSlide.tag}
                </span>
                <span className="text-[10px] font-mono text-slate-400">{state.league.inviteCode}</span>
              </div>

              {activeSlide.vsMode ? (
                <div className="relative z-10 flex items-center justify-center gap-4 my-auto">
                  <div className="text-center">
                    <TeamCrest
                      templateKey={myTeam?.templateKey}
                      shortCode={myTeam?.shortCode || 'XI'}
                      primaryColor={myTeam?.primaryColor}
                      secondaryColor={myTeam?.secondaryColor}
                      size="md"
                    />
                    <div className="font-condensed text-xl font-extrabold text-white mt-1">
                      {myTeam?.shortCode || 'YOUR XI'}
                    </div>
                  </div>
                  <span className="text-xs font-mono text-slate-400">vs</span>
                  <div className="text-center">
                    <TeamCrest
                      templateKey={topRival?.templateKey}
                      shortCode={topRival?.shortCode || 'XI'}
                      primaryColor={topRival?.primaryColor}
                      secondaryColor={topRival?.secondaryColor}
                      size="md"
                    />
                    <div className="font-condensed text-xl font-extrabold text-white mt-1">
                      {topRival?.shortCode || 'RIVAL'}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="relative z-10 text-center my-auto space-y-1">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-slate-400">
                    CLUB DISPATCH
                  </div>
                  <div className="font-condensed text-3xl font-extrabold text-white tracking-tight uppercase">
                    {activeSlide.bannerTitle}
                  </div>
                </div>
              )}

              <div className="relative z-10 flex items-center justify-center gap-1.5">
                {socialSlides.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setSocialIdx(idx)}
                    className={`h-1 rounded-sm transition-all cursor-pointer ${
                      idx === socialIdx ? 'w-5 bg-[#93E6EE]' : 'w-2 bg-white/20'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Social Caption */}
            <div className="space-y-1.5">
              <h3 className="font-condensed text-xl font-bold text-white uppercase tracking-wide">
                {activeSlide.headline}
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">{activeSlide.body}</p>
              <p className="text-[11px] font-mono text-[#EAB308]/90">{activeSlide.hashtags}</p>
              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-slate-500">
                <span>{activeSlide.metrics}</span>
                <span>{activeSlide.views}</span>
              </div>
            </div>
          </div>

          {/* Slide Navigation Controls */}
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => setSocialIdx((i) => (i - 1 + socialSlides.length) % socialSlides.length)}
              className="cm27-btn-dark-3d p-1.5 rounded text-slate-300 cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setSocialIdx((i) => (i + 1) % socialSlides.length)}
              className="cm27-btn-dark-3d p-1.5 rounded text-slate-300 cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* OPERATIONS GRID: Quick-Access CM27 Action Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <button
          onClick={() => onNavigate('matchday')}
          className="cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer space-y-2"
        >
          <div className="flex items-center justify-between">
            <Swords className="w-4 h-4 text-[#93E6EE]" />
            <span className="text-[10px] font-mono uppercase text-[#93E6EE] tabular-nums">
              {primaryFormatLabel} · {recentMatches.length} Played
            </span>
          </div>
          <div className="font-condensed text-2xl font-bold text-white uppercase">
            PLAY MATCHDAY
          </div>
          <div className="text-xs text-slate-400">
            Select XI, compare vs opponent, flip the toss &amp; simulate full scorecard
          </div>
        </button>

        <button
          onClick={() => onNavigate('auction')}
          className="cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer space-y-2"
        >
          <div className="flex items-center justify-between">
            <Gavel className="w-4 h-4 text-[#EAB308]" />
            <span className="text-[10px] font-mono uppercase text-[#EAB308]">
              {auction?.auction.status || 'lobby'}
            </span>
          </div>
          <div className="font-condensed text-2xl font-bold text-white uppercase">
            LIVE PLAYER AUCTION
          </div>
          <div className="text-xs text-slate-400 tabular-nums">
            {auction?.counts.sold ?? 0} sold · {auction?.counts.pending ?? 0} remaining lots
          </div>
        </button>

        <button
          onClick={() => onNavigate('squad')}
          className="cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer space-y-2"
        >
          <div className="flex items-center justify-between">
            <ClipboardList className="w-4 h-4 text-slate-300" />
            <span className="text-[10px] font-mono uppercase text-slate-300 tabular-nums">
              {myTeam ? `${myTeam.squadCount ?? 0} Players` : 'No Club'}
            </span>
          </div>
          <div className="font-condensed text-2xl font-bold text-white uppercase">
            SQUAD, STAFF &amp; LINEUPS
          </div>
          <div className="text-xs text-slate-400">
            Manage {allowedFormats.map(getFormatDisplayLabel).join(' / ')} XI, staff &amp; plans
          </div>
        </button>

        <button
          onClick={() => onNavigate('scouts')}
          className="cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer space-y-2"
        >
          <div className="flex items-center justify-between">
            <Compass className="w-4 h-4 text-slate-300" />
            <span className="text-[10px] font-mono uppercase text-[#EAB308] tabular-nums">
              {bookmarkedCount} Targets
            </span>
          </div>
          <div className="font-condensed text-2xl font-bold text-white uppercase">
            SCOUTING &amp; TARGETS
          </div>
          <div className="text-xs text-slate-400">
            Bookmark targets to get live alerts when they enter the auction stage
          </div>
        </button>
      </div>

      {/* DEEP MANAGEMENT STRIP: Training Ground | Transfer Desk | The League Gazette */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        <button
          onClick={() => onNavigate('training')}
          className="lg:col-span-3 cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <Dumbbell className="w-4 h-4 text-[#93E6EE]" />
            <span className="text-[10px] font-mono uppercase text-[#4ADE80] tabular-nums">
              {myTeam
                ? `${Math.max(0, 2 - (myTeam.trainingSlotsUsedDay === currentGameDay ? myTeam.trainingSlotsUsedCount ?? 0 : 0))}/2 Slots Left`
                : 'Drills'}
            </span>
          </div>
          <div className="font-condensed text-xl font-bold text-white uppercase">
            TRAINING GROUND
          </div>
          <div className="text-xs text-slate-400">
            Interactive skill drills, attribute upgrades &amp; trait unlocks
          </div>
        </button>

        <button
          onClick={() => onNavigate('transfers')}
          className="lg:col-span-3 cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <ArrowLeftRight className="w-4 h-4 text-[#EAB308]" />
            <span className="text-[10px] font-mono uppercase text-[#EAB308] tabular-nums">
              {pendingIncomingTrades > 0 ? `${pendingIncomingTrades} Pending` : 'Trade Window'}
            </span>
          </div>
          <div className="font-condensed text-xl font-bold text-white uppercase">
            TRANSFERS &amp; INJURY POOL
          </div>
          <div className="text-xs text-slate-400">
            Player/cash swaps, AI GM enquiries &amp; injury cover signings
          </div>
        </button>

        <button
          onClick={() => onNavigate('gazette')}
          className="lg:col-span-6 cm27-hover-sweep cm27-panel cm27-card-glow text-left p-4 cursor-pointer flex flex-col justify-between space-y-1.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-[#EAB308]">
              <Newspaper className="w-4 h-4" />
              <span>THE LEAGUE GAZETTE WIRE</span>
            </div>
            <span className="text-[10px] font-mono text-[#93E6EE] uppercase">
              {pendingPressCount > 0 ? `${pendingPressCount} Press Briefing Due →` : 'Read Broadsheet →'}
            </span>
          </div>
          {latestNews ? (
            <>
              <div className="font-condensed text-xl font-bold text-white uppercase truncate">
                {latestNews.headline}
              </div>
              <div className="text-xs text-slate-400 line-clamp-1">
                {latestNews.quote ? `"${latestNews.quote}" — ` : ''}
                {latestNews.summary}
              </div>
            </>
          ) : (
            <>
              <div className="font-condensed text-xl font-bold text-white uppercase">
                LEAGUE MEDIA &amp; PRESS CONFERENCES
              </div>
              <div className="text-xs text-slate-400">
                Post-match press conferences, milestone reports, medical dispatches &amp; trade alerts
              </div>
            </>
          )}
        </button>
      </div>

      {/* LOWER SPLIT: Multiplayer League Standings & Operations Comms */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Claimed Clubs & Purse Table */}
        <div className="lg:col-span-7 cm27-panel p-5 space-y-3">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[#93E6EE]" />
              <h2 className="font-condensed text-2xl font-bold text-white uppercase">
                ACTIVE FRANCHISES ({claimedManagers.length}/{state.teams.length})
              </h2>
            </div>
            <button
              onClick={() => onNavigate('franchises')}
              className="text-xs font-mono text-[#EAB308] hover:text-amber-300 cursor-pointer whitespace-nowrap"
            >
              Browse All {state.teams.length} Clubs →
            </button>
          </div>

          <div className="divide-y divide-white/[0.06]">
            {(claimedManagers.length > 0 ? claimedManagers : state.teams.slice(0, 6)).map((team) => (
              <div
                key={team.id}
                onClick={() => onInspectTeam(team.id)}
                className="py-2.5 px-2 rounded hover:bg-white/[0.03] flex items-center justify-between gap-3 cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <TeamCrest
                    templateKey={team.templateKey}
                    shortCode={team.shortCode}
                    primaryColor={team.primaryColor}
                    secondaryColor={team.secondaryColor}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-semibold text-white truncate flex items-center gap-2">
                      <span>{team.name}</span>
                      <span className="text-[10px] font-mono text-slate-500">
                        · {team.leagueCategory}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {team.ownerName ? `Mgr: ${team.ownerName}` : 'AI-Managed Club (Claimable)'} · Coach: {team.coachName}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-mono text-[#4ADE80] font-semibold tabular-nums">
                    {formatCurrencyLakhs(team.remainingBudget, currency)}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 tabular-nums">
                    {team.squadCount ?? 0} players
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Club Board & Live Chat Digest */}
        <div className="lg:col-span-5 cm27-panel p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[#93E6EE]" />
              <h2 className="font-condensed text-2xl font-bold text-white uppercase">
                OPERATIONS PULSE
              </h2>
            </div>
            <button
              onClick={() => onNavigate('chat')}
              className="text-xs font-mono text-[#93E6EE] hover:text-white flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <MessageSquare className="w-3 h-3" />
              Open Chat
            </button>
          </div>

          {myTeam ? (
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div className="cm27-panel-inset p-3">
                <div className="text-[10px] font-mono uppercase text-slate-500">Head Coach</div>
                <div className="text-white font-semibold mt-0.5 truncate">{myTeam.coachName}</div>
              </div>
              <div className="cm27-panel-inset p-3">
                <div className="text-[10px] font-mono uppercase text-slate-500">Target T20 RPO</div>
                <div className="text-[#EAB308] font-mono font-bold mt-0.5 tabular-nums">
                  {myTeam.tacticsJson?.aimRpo ?? 9.2} RPO ({myTeam.tacticsJson?.t20Tempo ?? 'Aggressive'})
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 rounded bg-amber-500/10 border border-amber-400/25 text-xs text-amber-200">
              Claim any franchise or national team in <strong>Teams</strong> to unlock staff hiring, scouting, and auction bidding.
            </div>
          )}

          <div className="space-y-2 pt-1">
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
              Recent League Comms
            </div>
            {state.messages.slice(-4).map((m) => (
              <div
                key={m.id}
                className="cm27-panel-inset p-2.5 text-xs"
              >
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                  <span className="text-[#93E6EE] font-semibold">
                    {m.teamShortCode || 'HQ'} · {m.managerName || 'System'}
                  </span>
                  <span>{formatTimeAgo(m.createdAt)}</span>
                </div>
                <div className="text-slate-200 mt-0.5 line-clamp-2">{m.body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* IPL-STYLE POINTS TABLE & AUTOMATED TOURNAMENT SCHEDULE */}
      {(standingsList.length > 0 || fixturesList.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Standings / Points Table */}
          <div className="lg:col-span-7 cm27-panel p-5 space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
              <div className="flex items-center gap-2">
                <Trophy className="w-4 h-4 text-[#EAB308]" />
                <h2 className="font-condensed text-2xl font-bold text-white uppercase">
                  TOURNAMENT STANDINGS &amp; NRR
                </h2>
              </div>
              <span className="text-[10px] font-mono uppercase text-[#93E6EE]">
                TOP 4 QUALIFY FOR PLAYOFFS
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-[#0C0F14] text-slate-400 font-mono text-[10px] uppercase">
                  <tr>
                    <th className="py-2 px-2.5">#</th>
                    <th className="py-2 px-2.5">CLUB</th>
                    <th className="py-2 px-2 text-right">P</th>
                    <th className="py-2 px-2 text-right">W</th>
                    <th className="py-2 px-2 text-right">L</th>
                    <th className="py-2 px-2 text-right">NRR</th>
                    <th className="py-2 px-2.5 text-right">PTS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {standingsList.map((row, idx) => {
                    const isMine = myTeam?.id === row.teamId;
                    const inPlayoffZone = idx < 4;
                    return (
                      <tr
                        key={row.teamId}
                        onClick={() => onInspectTeam(row.teamId)}
                        className={`cursor-pointer transition-colors ${
                          isMine
                            ? 'bg-[#1D2532]/85 text-white'
                            : 'hover:bg-white/[0.03] text-slate-200'
                        } ${idx === 3 ? 'border-b-2 border-[#93E6EE]/40' : ''}`}
                      >
                        <td className="py-2 px-2.5 font-mono tabular-nums">
                          <span
                            className={`inline-block w-5 text-center rounded ${
                              inPlayoffZone
                                ? 'text-[#93E6EE] font-bold'
                                : 'text-slate-500'
                            }`}
                          >
                            {idx + 1}
                          </span>
                        </td>
                        <td className="py-2 px-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <TeamCrest
                              templateKey={row.templateKey}
                              shortCode={row.shortCode}
                              primaryColor={row.primaryColor}
                              secondaryColor={row.secondaryColor}
                              size="sm"
                            />
                            <div className="min-w-0">
                              <div className="font-semibold truncate flex items-center gap-1.5">
                                <span>{row.shortCode}</span>
                                <span className="text-[10px] text-slate-400 font-normal truncate hidden sm:inline">
                                  {row.teamName}
                                </span>
                                {row.ownerUid && (
                                  <span className="px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[9px] font-mono">
                                    HUMAN
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">{row.played}</td>
                        <td className="py-2 px-2 text-right font-mono text-[#4ADE80] tabular-nums">
                          {row.won}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-rose-400 tabular-nums">
                          {row.lost}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-slate-300 tabular-nums">
                          {row.nrr >= 0 ? `+${row.nrr.toFixed(3)}` : row.nrr.toFixed(3)}
                        </td>
                        <td className="py-2 px-2.5 text-right font-mono font-bold text-amber-400 tabular-nums">
                          {row.points}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Upcoming Automated Fixtures */}
          <div className="lg:col-span-5 cm27-panel p-5 space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-[#93E6EE]" />
                <h2 className="font-condensed text-2xl font-bold text-white uppercase">
                  TOURNAMENT SCHEDULE
                </h2>
              </div>
              <button
                onClick={() => onNavigate('matchday')}
                className="text-xs font-mono text-[#93E6EE] hover:text-white cursor-pointer whitespace-nowrap"
              >
                Open Matchday →
              </button>
            </div>

            <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
              {fixturesList
                .filter((fx) => fx.status !== 'completed')
                .slice(0, 8)
                .map((fx) => {
                  const home = teamById.get(fx.homeTeamId);
                  const away = teamById.get(fx.awayTeamId);
                  const isPvp = Boolean(home?.ownerUid && away?.ownerUid);
                  const involvesMe =
                    myTeam && (fx.homeTeamId === myTeam.id || fx.awayTeamId === myTeam.id);
                  return (
                    <button
                      key={fx.id}
                      onClick={() => onNavigate('matchday')}
                      className={`w-full p-2.5 rounded border text-left transition-colors cursor-pointer ${
                        involvesMe
                          ? 'bg-[#1B222D] border-[#93E6EE]/55 hover:border-[#93E6EE]'
                          : 'cm27-panel-inset hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-slate-400 tabular-nums">
                          M#{fx.matchNumber} · DAY {fx.scheduledDay} ·{' '}
                          <span className="uppercase text-[#EAB308]">{fx.stage}</span>
                        </span>
                        <span
                          className={`text-[10px] font-mono uppercase ${
                            fx.status === 'live'
                              ? 'text-[#4ADE80] font-bold'
                              : isPvp
                                ? 'text-[#93E6EE]'
                                : 'text-slate-500'
                          }`}
                        >
                          {fx.status === 'live' ? 'LIVE NOW' : isPvp ? 'HUMAN PVP' : 'VS CPU'}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs font-bold text-white">
                        <span>
                          {home?.shortCode || 'TBD'} vs {away?.shortCode || 'TBD'}
                        </span>
                        <span className="text-[11px] font-normal text-slate-400 truncate max-w-[150px]">
                          {fx.venue}
                        </span>
                      </div>
                    </button>
                  );
                })}
              {fixturesList.filter((fx) => fx.status !== 'completed').length === 0 && (
                <div className="cm27-panel-inset p-4 text-xs text-slate-400 text-center">
                  All scheduled fixtures completed!
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
