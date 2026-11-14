import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auctionPlayers,
  auctions,
  bids,
  leagueMessages,
  leagues,
  notifications,
  playerContracts,
  players,
  teams,
} from '../db/schema.ts';
import { getPlayerOverallRating } from './matchEngine.ts';
import { shuffleAuctionPoolByMarqueeSet } from './realCricketData.ts';
import { wsHub } from './wsHub.ts';

function deterministicHash(a: number, b: number): number {
  let x = (a * 374761393 + b * 668265263) ^ 0x5bf03635;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function getPlayerAuctionValuation(
  player: {
    name: string;
    primaryRole: string;
    battingRating: number;
    bowlingRating: number;
    currentForm?: number;
    formDelta?: number;
    marqueeSet?: string | null;
    statsJson?: {
      t20?: { matches?: number; runs?: number; strikeRate?: number; wickets?: number; economy?: number };
    } | null;
  },
  basePrice: number
): { minVal: number; maxVal: number; ovr: number; isFringe: boolean } {
  const ovr = getPlayerOverallRating(player);
  const isMarquee = player.marqueeSet === 'Marquee Stars';
  const t20 = player.statsJson?.t20;
  const provenIplVolume = (t20?.runs || 0) >= 2400 || (t20?.wickets || 0) >= 85;

  if ((isMarquee && (ovr >= 76 || provenIplVolume)) || ovr >= 84) {
    return { minVal: 1450, maxVal: 2550, ovr, isFringe: false };
  }
  if (isMarquee || ovr >= 81) {
    return { minVal: 900, maxVal: 1950, ovr, isFringe: false };
  }
  if (ovr >= 75) {
    return { minVal: 425, maxVal: 1150, ovr, isFringe: false };
  }
  if (ovr >= 68) {
    return { minVal: 160, maxVal: 550, ovr, isFringe: false };
  }
  if (ovr >= 61) {
    return {
      minVal: basePrice,
      maxVal: Math.min(300, Math.max(basePrice, 275)),
      ovr,
      isFringe: true,
    };
  }
  return {
    minVal: basePrice,
    maxVal: Math.min(250, Math.max(basePrice, 175)),
    ovr,
    isFringe: true,
  };
}

export async function getAuctionSnapshot(leagueId: number) {
  const [auction] = await db
    .select()
    .from(auctions)
    .where(eq(auctions.leagueId, leagueId))
    .limit(1);

  if (!auction) return null;

  let currentLot = null;
  let currentPlayer = null;
  let lotBids: Array<{
    id: number;
    amount: number;
    teamId: number;
    teamName: string;
    teamShortCode: string;
    teamColor: string;
    userUid: string;
    createdAt: Date;
  }> = [];

  if (auction.currentLotId) {
    const [lot] = await db
      .select()
      .from(auctionPlayers)
      .where(eq(auctionPlayers.id, auction.currentLotId))
      .limit(1);

    if (lot) {
      currentLot = lot;
      const [player] = await db
        .select()
        .from(players)
        .where(eq(players.id, lot.playerId))
        .limit(1);
      currentPlayer = player ?? null;

      const rawBids = await db
        .select({
          id: bids.id,
          amount: bids.amount,
          teamId: bids.teamId,
          teamName: teams.name,
          teamShortCode: teams.shortCode,
          teamColor: teams.primaryColor,
          userUid: bids.userUid,
          createdAt: bids.createdAt,
        })
        .from(bids)
        .innerJoin(teams, eq(bids.teamId, teams.id))
        .where(eq(bids.auctionPlayerId, lot.id))
        .orderBy(desc(bids.createdAt))
        .limit(20);

      lotBids = rawBids;
    }
  }

  const allLots = await db
    .select({
      status: auctionPlayers.status,
    })
    .from(auctionPlayers)
    .where(eq(auctionPlayers.auctionId, auction.id));

  const counts = {
    total: allLots.length,
    pending: allLots.filter((l) => l.status === 'pending').length,
    sold: allLots.filter((l) => l.status === 'sold').length,
    unsold: allLots.filter((l) => l.status === 'unsold').length,
  };

  return {
    auction,
    currentLot,
    currentPlayer,
    recentBids: lotBids,
    counts,
    serverTime: Date.now(),
  };
}

/**
 * Ensures EVERY club in the league finishes the auction with at least 22+ players
 * before the auction closes. Uses remaining unsold/pending pool fairly.
 */
export async function enforceMinimumSquadCompletion(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  league: typeof leagues.$inferSelect,
  auctionId: number,
  now: Date
): Promise<{ assignedCount: number; systemMsg: typeof leagueMessages.$inferSelect | null }> {
  const requiredMinSquad = Math.max(22, league.minSquadSize || 22);

  const allTeams = await tx
    .select()
    .from(teams)
    .where(eq(teams.leagueId, league.id));

  if (allTeams.length === 0) {
    return { assignedCount: 0, systemMsg: null };
  }

  const existingContracts = await tx
    .select({
      teamId: playerContracts.teamId,
      isOverseas: players.isOverseas,
      primaryRole: players.primaryRole,
    })
    .from(playerContracts)
    .innerJoin(players, eq(playerContracts.playerId, players.id))
    .where(eq(playerContracts.leagueId, league.id));

  const remainingPool = await tx
    .select({
      lot: auctionPlayers,
      player: players,
    })
    .from(auctionPlayers)
    .innerJoin(players, eq(auctionPlayers.playerId, players.id))
    .where(
      and(
        eq(auctionPlayers.auctionId, auctionId),
        inArray(auctionPlayers.status, ['pending', 'unsold'])
      )
    );

  // Sort unassigned pool by OVR descending so quality players are distributed fairly first
  const sortedPool = remainingPool
    .map((entry) => ({
      ...entry,
      ovr: getPlayerOverallRating(entry.player),
      assigned: false,
    }))
    .sort((a, b) => b.ovr - a.ovr);

  const teamStates = allTeams.map((t) => {
    const tContracts = existingContracts.filter((c) => c.teamId === t.id);
    const roleCounts: Record<string, number> = {
      Batsman: 0,
      Bowler: 0,
      'All-Rounder': 0,
      Wicketkeeper: 0,
    };
    for (const c of tContracts) {
      roleCounts[c.primaryRole] = (roleCounts[c.primaryRole] || 0) + 1;
    }
    return {
      team: t,
      remainingBudget: t.remainingBudget,
      squadCount: tContracts.length,
      overseasCount: tContracts.filter((c) => c.isOverseas).length,
      roleCounts,
      dirtyBudget: false,
    };
  });

  const newContracts: Array<typeof playerContracts.$inferInsert> = [];
  const soldUpdates: Array<{ lotId: number; teamId: number; soldPrice: number }> = [];

  while (true) {
    const needyTeams = teamStates
      .filter((ts) => ts.squadCount < requiredMinSquad)
      .sort((a, b) => a.squadCount - b.squadCount || b.remainingBudget - a.remainingBudget);

    if (needyTeams.length === 0) break;

    let assignedInRound = false;
    for (const ts of needyTeams) {
      const slotsNeeded = requiredMinSquad - ts.squadCount;
      if (slotsNeeded <= 0) continue;

      const available = sortedPool.filter((p) => !p.assigned);
      if (available.length === 0) break;

      const needsWk = (ts.roleCounts['Wicketkeeper'] || 0) < 2;
      const needsBowler = (ts.roleCounts['Bowler'] || 0) < 6;
      const needsBatter = (ts.roleCounts['Batsman'] || 0) < 6;

      // First try strict overseas cap compliance
      let eligible = available.filter(
        (entry) => !entry.player.isOverseas || ts.overseasCount < league.maxOverseas
      );
      if (eligible.length === 0) {
        // Emergency fallback only if overseas cap prevents completing 22
        eligible = available;
      }

      // Reserve at least 10L for remaining slots
      const maxForThisSlot = Math.max(
        10,
        ts.remainingBudget - Math.max(0, slotsNeeded - 1) * 10
      );

      // Rank candidates by affordability + positional need + OVR
      eligible.sort((a, b) => {
        const aAff = a.lot.basePrice <= maxForThisSlot ? 1 : 0;
        const bAff = b.lot.basePrice <= maxForThisSlot ? 1 : 0;
        if (aAff !== bAff) return bAff - aAff;

        const scoreRole = (role: string) =>
          (needsWk && role === 'Wicketkeeper' ? 12 : 0) +
          (needsBowler && role === 'Bowler' ? 7 : 0) +
          (needsBatter && role === 'Batsman' ? 6 : 0);

        return b.ovr + scoreRole(b.player.primaryRole) - (a.ovr + scoreRole(a.player.primaryRole));
      });

      const pick = eligible[0];
      if (!pick) continue;

      const fee = Math.min(
        ts.remainingBudget,
        Math.max(10, Math.min(pick.lot.basePrice, maxForThisSlot))
      );

      pick.assigned = true;
      ts.squadCount += 1;
      if (pick.player.isOverseas) ts.overseasCount += 1;
      ts.roleCounts[pick.player.primaryRole] =
        (ts.roleCounts[pick.player.primaryRole] || 0) + 1;
      ts.remainingBudget = Math.max(0, ts.remainingBudget - fee);
      ts.dirtyBudget = true;

      newContracts.push({
        leagueId: league.id,
        teamId: ts.team.id,
        playerId: pick.player.id,
        purchasePrice: fee,
        salary: fee,
        contractYears: 3,
        acquiredVia: 'auction',
      });
      soldUpdates.push({
        lotId: pick.lot.id,
        teamId: ts.team.id,
        soldPrice: fee,
      });
      assignedInRound = true;
    }

    if (!assignedInRound) break;
  }

  for (let i = 0; i < newContracts.length; i += 200) {
    await tx.insert(playerContracts).values(newContracts.slice(i, i + 200));
  }

  for (const upd of soldUpdates) {
    await tx
      .update(auctionPlayers)
      .set({
        status: 'sold',
        soldPrice: upd.soldPrice,
        winningTeamId: upd.teamId,
        updatedAt: now,
      })
      .where(eq(auctionPlayers.id, upd.lotId));
  }

  for (const ts of teamStates) {
    if (ts.dirtyBudget) {
      await tx
        .update(teams)
        .set({ remainingBudget: ts.remainingBudget })
        .where(eq(teams.id, ts.team.id));
    }
  }

  let systemMsg: typeof leagueMessages.$inferSelect | null = null;
  if (newContracts.length > 0) {
    const [msg] = await tx
      .insert(leagueMessages)
      .values({
        leagueId: league.id,
        userUid: league.hostUid,
        teamShortCode: 'AUC',
        body: `Mandatory Squad Completion: Assigned ${newContracts.length} remaining pool players so every franchise finishes with ${requiredMinSquad}+ contracted players.`,
        messageType: 'system',
      })
      .returning();
    systemMsg = msg ?? null;
  }

  return { assignedCount: newContracts.length, systemMsg };
}

export async function settleLotAtomic(auctionId: number, forceSettle = false) {
  const info = await db.transaction(async (tx) => {
    const lockedAuctionRes = await tx.execute(
      sql`SELECT * FROM auctions WHERE id = ${auctionId} FOR UPDATE`
    );
    const auctionRow = lockedAuctionRes.rows[0] as
      | {
          id: number;
          league_id: number;
          status: string;
          current_lot_id: number | null;
          current_bid: number;
          highest_bidder_team_id: number | null;
          highest_bidder_uid: string | null;
          lot_ends_at: Date | null;
          auto_advance: boolean;
          accelerated_round: boolean;
        }
      | undefined;

    if (!auctionRow || !auctionRow.current_lot_id) {
      return null;
    }
    const canForcePaused = forceSettle && auctionRow.status === 'paused';
    if (!canForcePaused && auctionRow.status !== 'live') {
      return null;
    }

    const now = new Date();
    if (!forceSettle && auctionRow.lot_ends_at && new Date(auctionRow.lot_ends_at) > now) {
      return null;
    }

    const [lot] = await tx
      .select()
      .from(auctionPlayers)
      .where(eq(auctionPlayers.id, auctionRow.current_lot_id))
      .limit(1);

    if (!lot || lot.status !== 'active') {
      return null;
    }

    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, auctionRow.league_id))
      .limit(1);

    const [player] = await tx
      .select()
      .from(players)
      .where(eq(players.id, lot.playerId))
      .limit(1);

    if (!league || !player) return null;

    let outcome: 'sold' | 'unsold' = 'unsold';
    let winningTeamId: number | null = null;
    let winningTeamOwnerUid: string | null = null;
    let winningTeamName: string | null = null;
    let winningTeamShortCode: string | null = null;
    let winningTeamNewBudget = 0;
    let soldPrice: number | null = null;

    if (auctionRow.highest_bidder_team_id && auctionRow.current_bid > 0) {
      const lockedTeamRes = await tx.execute(
        sql`SELECT * FROM teams WHERE id = ${auctionRow.highest_bidder_team_id} FOR UPDATE`
      );
      const winningTeam = lockedTeamRes.rows[0] as
        | {
            id: number;
            owner_uid: string | null;
            name: string;
            short_code: string;
            remaining_budget: number;
          }
        | undefined;

      if (winningTeam && winningTeam.remaining_budget >= auctionRow.current_bid) {
        outcome = 'sold';
        soldPrice = auctionRow.current_bid;
        winningTeamId = winningTeam.id;
        winningTeamOwnerUid = winningTeam.owner_uid;
        winningTeamName = winningTeam.name;
        winningTeamShortCode = winningTeam.short_code;
        winningTeamNewBudget = winningTeam.remaining_budget - soldPrice;

        await tx
          .update(teams)
          .set({
            remainingBudget: winningTeamNewBudget,
          })
          .where(eq(teams.id, winningTeam.id));

        await tx.insert(playerContracts).values({
          leagueId: league.id,
          teamId: winningTeam.id,
          playerId: player.id,
          purchasePrice: soldPrice,
          salary: soldPrice,
          contractYears: 3,
          acquiredVia: 'auction',
        });

        await tx
          .update(auctionPlayers)
          .set({
            status: 'sold',
            soldPrice,
            winningTeamId: winningTeam.id,
            updatedAt: now,
          })
          .where(eq(auctionPlayers.id, lot.id));
      } else {
        await tx
          .update(auctionPlayers)
          .set({
            status: 'unsold',
            updatedAt: now,
          })
          .where(eq(auctionPlayers.id, lot.id));
      }
    } else {
      await tx
        .update(auctionPlayers)
        .set({
          status: 'unsold',
          updatedAt: now,
        })
        .where(eq(auctionPlayers.id, lot.id));
    }

    const playerOvr = getPlayerOverallRating(player);
    const createdNotifs: Array<typeof notifications.$inferSelect> = [];

    // Selective Inbox Dispatches: ONLY notify buyers (if human) and managers who bookmarked this player
    const leagueHumanTeams = await tx
      .select({
        id: teams.id,
        ownerUid: teams.ownerUid,
        name: teams.name,
        shortCode: teams.shortCode,
        bookmarkedPlayerIdsJson: teams.bookmarkedPlayerIdsJson,
      })
      .from(teams)
      .where(eq(teams.leagueId, league.id));

    if (outcome === 'sold' && winningTeamOwnerUid) {
      const [buyerNotif] = await tx
        .insert(notifications)
        .values({
          leagueId: league.id,
          targetUid: winningTeamOwnerUid,
          category: 'Auction',
          title: `${player.name} signed by ${winningTeamShortCode} for ${formatLakhsServer(soldPrice!)}`,
          body: `Board Recruitment Desk,\n\nWe have completed the signing of ${player.name} (${player.primaryRole}, ${player.country}, OVR ${playerOvr}) from the ${player.marqueeSet} set for ${formatLakhsServer(soldPrice!)} on a 3-season franchise contract.\n\nYour remaining auction purse now stands at ${formatLakhsServer(winningTeamNewBudget)}. Head to Squad -> Lineups whenever you are ready to integrate them into your starting XI.\n\nChief Executive`,
        })
        .returning();
      if (buyerNotif) createdNotifs.push(buyerNotif);
    }

    for (const hTeam of leagueHumanTeams) {
      if (!hTeam.ownerUid) continue;
      if (outcome === 'sold' && hTeam.id === winningTeamId) continue;
      const bookmarks = Array.isArray(hTeam.bookmarkedPlayerIdsJson)
        ? hTeam.bookmarkedPlayerIdsJson
        : [];
      if (!bookmarks.includes(player.id)) continue;

      if (outcome === 'sold') {
        const [watchNotif] = await tx
          .insert(notifications)
          .values({
            leagueId: league.id,
            targetUid: hTeam.ownerUid,
            category: 'Scouting',
            title: `Watchlist alert: ${player.name} signed by ${winningTeamShortCode}`,
            body: `Scouting Network Report,\n\nYour shortlisted ${player.primaryRole.toLowerCase()} target ${player.name} (${player.country}, OVR ${playerOvr}) was acquired by ${winningTeamName} for ${formatLakhsServer(soldPrice!)} during the ${player.marqueeSet} set.\n\nReview alternative options in Scouting and update your priority watchlist before the upcoming sets resume.\n\nHead of Recruitment`,
          })
          .returning();
        if (watchNotif) createdNotifs.push(watchNotif);
      } else {
        const [unsoldWatchNotif] = await tx
          .insert(notifications)
          .values({
            leagueId: league.id,
            targetUid: hTeam.ownerUid,
            category: 'Scouting',
            title: `Watchlist alert: ${player.name} went unsold`,
            body: `Scouting Network Report,\n\nYour bookmarked ${player.primaryRole.toLowerCase()} target ${player.name} (${player.country}, OVR ${playerOvr}) went unsold at the base reserve of ${formatLakhsServer(lot.basePrice)} in the ${player.marqueeSet} set.\n\n${!auctionRow.accelerated_round ? `${player.name} will automatically return in the Accelerated Unsold Round after the primary sets conclude, giving your franchise a second chance to secure them.` : 'The accelerated round has concluded for this lot.'}\n\nHead of Recruitment`,
          })
          .returning();
        if (unsoldWatchNotif) createdNotifs.push(unsoldWatchNotif);
      }
    }

    const chatBody =
      outcome === 'sold'
        ? `SOLD: ${winningTeamName} (${winningTeamShortCode}) signed ${player.name} (${player.primaryRole}) for ${formatLakhsServer(soldPrice!)}.`
        : `UNSOLD: ${player.name} passed at base price ${formatLakhsServer(lot.basePrice)}.`;

    const [createdMsg] = await tx
      .insert(leagueMessages)
      .values({
        leagueId: league.id,
        userUid: league.hostUid,
        teamShortCode: outcome === 'sold' ? winningTeamShortCode : 'AUC',
        body: chatBody,
        messageType: 'system',
      })
      .returning();

    // Advance to next pending lot if autoAdvance
    let nextLotId: number | null = null;
    let nextStatus = auctionRow.status;
    let nextEndsAt: Date | null = null;
    let nextSetName = player.marqueeSet || 'Marquee Stars';
    let nextAccelerated = Boolean(auctionRow.accelerated_round);
    let extraSystemMsg: typeof leagueMessages.$inferSelect | null = null;
    let completionSystemMsg: typeof leagueMessages.$inferSelect | null = null;

    if (auctionRow.auto_advance) {
      let [nextLot] = await tx
        .select()
        .from(auctionPlayers)
        .where(and(eq(auctionPlayers.auctionId, auctionId), eq(auctionPlayers.status, 'pending')))
        .orderBy(asc(auctionPlayers.lotOrder))
        .limit(1);

      // If primary sets finished and unsold players exist, launch Accelerated Unsold Round automatically!
      if (!nextLot && !nextAccelerated) {
        const unsoldLots = await tx
          .select({
            lot: auctionPlayers,
            player: players,
          })
          .from(auctionPlayers)
          .innerJoin(players, eq(auctionPlayers.playerId, players.id))
          .where(and(eq(auctionPlayers.auctionId, auctionId), eq(auctionPlayers.status, 'unsold')));

        if (unsoldLots.length > 0) {
          nextAccelerated = true;
          const shuffledUnsold = shuffleAuctionPoolByMarqueeSet(
            unsoldLots.map((u) => u.player)
          );
          const lotByPlayerId = new Map(unsoldLots.map((u) => [u.player.id, u.lot.id]));

          const maxOrderRes = await tx
            .select({ maxOrder: sql<number>`COALESCE(MAX(${auctionPlayers.lotOrder}), 0)` })
            .from(auctionPlayers)
            .where(eq(auctionPlayers.auctionId, auctionId));
          const baseOrder = Number(maxOrderRes[0]?.maxOrder || 0);

          for (let i = 0; i < shuffledUnsold.length; i++) {
            const p = shuffledUnsold[i];
            const lotId = lotByPlayerId.get(p.id);
            if (!lotId) continue;
            await tx
              .update(auctionPlayers)
              .set({
                status: 'pending',
                lotOrder: baseOrder + i + 1,
                updatedAt: now,
              })
              .where(eq(auctionPlayers.id, lotId));
          }

          [nextLot] = await tx
            .select()
            .from(auctionPlayers)
            .where(and(eq(auctionPlayers.auctionId, auctionId), eq(auctionPlayers.status, 'pending')))
            .orderBy(asc(auctionPlayers.lotOrder))
            .limit(1);

          const [accelMsg] = await tx
            .insert(leagueMessages)
            .values({
              leagueId: league.id,
              userUid: league.hostUid,
              teamShortCode: 'AUC',
              body: `Primary marquee sets complete! ${unsoldLots.length} unsold players are returning in the Accelerated Unsold Round.`,
              messageType: 'system',
            })
            .returning();
          extraSystemMsg = accelMsg ?? null;
        }
      }

      if (nextLot) {
        nextLotId = nextLot.id;
        nextEndsAt =
          auctionRow.status === 'paused'
            ? null
            : new Date(now.getTime() + league.auctionDurationSec * 1000);
        const [nextPlayer] = await tx
          .select({ marqueeSet: players.marqueeSet })
          .from(players)
          .where(eq(players.id, nextLot.playerId))
          .limit(1);
        nextSetName = nextAccelerated
          ? `Accelerated · ${nextPlayer?.marqueeSet || 'Unsold Pool'}`
          : nextPlayer?.marqueeSet || 'Marquee Stars';

        await tx
          .update(auctionPlayers)
          .set({ status: 'active', updatedAt: now })
          .where(eq(auctionPlayers.id, nextLot.id));
      } else {
        // Guarantee all clubs finish with 22+ players before marking auction completed
        const compRes = await enforceMinimumSquadCompletion(tx, league, auctionId, now);
        completionSystemMsg = compRes.systemMsg;

        nextStatus = 'completed';
        nextSetName = 'Completed';
        await tx
          .update(leagues)
          .set({ status: 'active' })
          .where(eq(leagues.id, league.id));
      }
    }

    await tx
      .update(auctions)
      .set({
        status: nextStatus,
        currentLotId: nextLotId,
        currentBid: 0,
        highestBidderTeamId: null,
        highestBidderUid: null,
        lotEndsAt: nextEndsAt,
        remainingSecondsOnPause:
          nextStatus === 'paused' && nextLotId ? league.auctionDurationSec : null,
        currentSetName: nextSetName,
        acceleratedRound: nextAccelerated,
        skipVotesJson: [],
        ...(nextStatus === 'completed' ? { autoSimVotesJson: [] } : {}),
        updatedAt: now,
      })
      .where(eq(auctions.id, auctionId));

    return {
      leagueId: league.id,
      outcome,
      playerName: player.name,
      winningTeamName,
      winningTeamShortCode,
      soldPrice,
      nextStatus,
      notifications: createdNotifs,
      systemMessage: createdMsg ?? null,
      extraSystemMessage: extraSystemMsg,
      completionSystemMessage: completionSystemMsg,
    };
  });

  if (info) {
    const snapshot = await getAuctionSnapshot(info.leagueId);
    wsHub.broadcastToLeague(info.leagueId, 'auction:lot_settled', {
      outcome: info.outcome,
      playerName: info.playerName,
      winningTeamName: info.winningTeamName,
      winningTeamShortCode: info.winningTeamShortCode,
      soldPrice: info.soldPrice,
      snapshot,
    });
    for (const notif of info.notifications) {
      if (notif.targetUid) {
        wsHub.sendToUser(notif.targetUid, 'notification:new', notif);
      } else {
        wsHub.broadcastToLeague(info.leagueId, 'notification:new', notif);
      }
    }
    if (info.systemMessage) {
      wsHub.broadcastToLeague(info.leagueId, 'chat:message', info.systemMessage);
    }
    if (info.extraSystemMessage) {
      wsHub.broadcastToLeague(info.leagueId, 'chat:message', info.extraSystemMessage);
    }
    if (info.completionSystemMessage) {
      wsHub.broadcastToLeague(info.leagueId, 'chat:message', info.completionSystemMessage);
    }
    if (info.nextStatus === 'completed') {
      wsHub.broadcastToLeague(info.leagueId, 'league:updated', { leagueId: info.leagueId });
    }
  }
}

/**
 * Unanimous Instant Full Auction Simulator:
 * Resolves all active/pending/unsold lots in seconds across ALL franchises (human & AI)
 * respecting budgets, overseas limits, bookmarks, and compulsory 22+ squad completion.
 */
export async function autoSimulateFullAuction(leagueId: number) {
  const result = await db.transaction(async (tx) => {
    const lockedRes = await tx.execute(
      sql`SELECT * FROM auctions WHERE league_id = ${leagueId} FOR UPDATE`
    );
    const auctionRow = lockedRes.rows[0] as
      | {
          id: number;
          league_id: number;
          status: string;
          current_lot_id: number | null;
          current_bid: number;
          highest_bidder_team_id: number | null;
        }
      | undefined;

    if (!auctionRow) {
      throw new Error('Auction not found.');
    }

    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    if (!league) {
      throw new Error('League not found.');
    }

    if (auctionRow.status === 'completed') {
      return {
        alreadyCompleted: true,
        leagueId,
        soldNow: 0,
        completionAssigned: 0,
        systemMsg: null,
        completionMsg: null,
        notifs: [] as Array<typeof notifications.$inferSelect>,
      };
    }

    const now = new Date();
    const requiredMinSquad = Math.max(22, league.minSquadSize || 22);
    const effectiveMaxSquad = Math.max(requiredMinSquad, league.maxSquadSize || 25);
    const budgetScale = Math.max(0.4, league.startingBudget / 10000);
    const bidInc = Math.max(5, league.bidIncrement || 25);

    const allTeams = await tx
      .select()
      .from(teams)
      .where(eq(teams.leagueId, leagueId));

    const existingContracts = await tx
      .select({
        teamId: playerContracts.teamId,
        isOverseas: players.isOverseas,
        primaryRole: players.primaryRole,
      })
      .from(playerContracts)
      .innerJoin(players, eq(playerContracts.playerId, players.id))
      .where(eq(playerContracts.leagueId, leagueId));

    const allLots = await tx
      .select({
        lot: auctionPlayers,
        player: players,
      })
      .from(auctionPlayers)
      .innerJoin(players, eq(auctionPlayers.playerId, players.id))
      .where(eq(auctionPlayers.auctionId, auctionRow.id))
      .orderBy(asc(auctionPlayers.lotOrder));

    const teamStates = allTeams.map((t) => {
      const tContracts = existingContracts.filter((c) => c.teamId === t.id);
      const roleCounts: Record<string, number> = {
        Batsman: 0,
        Bowler: 0,
        'All-Rounder': 0,
        Wicketkeeper: 0,
      };
      for (const c of tContracts) {
        roleCounts[c.primaryRole] = (roleCounts[c.primaryRole] || 0) + 1;
      }
      return {
        team: t,
        isHuman: Boolean(t.ownerUid),
        bookmarks: new Set<number>(
          Array.isArray(t.bookmarkedPlayerIdsJson) ? t.bookmarkedPlayerIdsJson : []
        ),
        remainingBudget: t.remainingBudget,
        squadCount: tContracts.length,
        overseasCount: tContracts.filter((c) => c.isOverseas).length,
        roleCounts,
        signedNames: [] as string[],
      };
    });

    const teamById = new Map(teamStates.map((ts) => [ts.team.id, ts]));

    // Separate active + pending first, then unsold
    const activeAndPending = allLots.filter(
      (item) => item.lot.status === 'active' || item.lot.status === 'pending'
    );
    const priorUnsold = allLots.filter((item) => item.lot.status === 'unsold');
    const lotsToSim = [...activeAndPending, ...priorUnsold];

    const newContracts: Array<typeof playerContracts.$inferInsert> = [];
    const lotUpdates: Array<{
      lotId: number;
      status: 'sold' | 'unsold';
      soldPrice: number | null;
      winningTeamId: number | null;
    }> = [];

    const runLotBidSim = (
      item: typeof lotsToSim[number],
      aggressiveFillMode: boolean
    ): boolean => {
      const { lot, player } = item;
      const { minVal, maxVal, ovr, isFringe } = getPlayerAuctionValuation(player, lot.basePrice);

      const totalContracts = teamStates.reduce((acc, s) => acc + s.squadCount, 0);
      const avgSquad = totalContracts / Math.max(1, teamStates.length);

      const isCurrentlyActiveWithBid =
        lot.id === auctionRow.current_lot_id &&
        auctionRow.current_bid > 0 &&
        auctionRow.highest_bidder_team_id !== null;

      const startingMinPrice = isCurrentlyActiveWithBid
        ? auctionRow.current_bid
        : lot.basePrice;

      const contenders: Array<{
        ts: (typeof teamStates)[number];
        score: number;
        cap: number;
      }> = [];

      for (const ts of teamStates) {
        if (ts.squadCount >= effectiveMaxSquad) continue;
        if (player.isOverseas && ts.overseasCount >= league.maxOverseas) continue;

        const slotsNeededAfterThis = Math.max(0, requiredMinSquad - ts.squadCount - 1);
        const minReserve = slotsNeededAfterThis * 20;
        const spendable = ts.remainingBudget - minReserve;
        if (spendable < lot.basePrice) continue;

        const roleCount = ts.roleCounts[player.primaryRole] || 0;
        const roleNeedMult =
          player.primaryRole === 'Wicketkeeper' && roleCount >= 2
            ? 0.55
            : roleCount >= 7
              ? 0.65
              : roleCount === 0 && ts.squadCount >= 4
                ? 1.3
                : 1.05;

        const isBookmarked = ts.bookmarks.has(player.id);
        const affinity = deterministicHash(lot.id * 37, ts.team.id * 19);
        const catchUp =
          (ts.squadCount < requiredMinSquad ? 0.35 : 0) +
          Math.max(0, avgSquad - ts.squadCount) * 0.14;

        // If under 22, clubs stay engaged; if already >=22, only bid on high-OVR or bookmarked bargains
        if (ts.squadCount >= requiredMinSquad && ovr < 72 && !isBookmarked && !aggressiveFillMode) {
          continue;
        }

        const fierceBias = 0.28 + affinity * 0.68 + (isBookmarked ? 0.18 : 0);
        const rawCap =
          (minVal + fierceBias * (maxVal - minVal)) *
          budgetScale *
          roleNeedMult *
          (ts.squadCount < requiredMinSquad ? 1.04 : 0.8);

        const maxShare =
          player.marqueeSet === 'Marquee Stars' || ovr >= 82 ? 0.26 : 0.2;
        const hardTeamMax = isFringe
          ? Math.round(300 * budgetScale)
          : Math.round(league.startingBudget * maxShare);
        let cap = Math.min(spendable, hardTeamMax, Math.round(rawCap / bidInc) * bidInc);

        if (aggressiveFillMode && ts.squadCount < requiredMinSquad) {
          cap = Math.max(cap, Math.min(spendable, lot.basePrice));
        } else if (ts.squadCount < requiredMinSquad && spendable >= lot.basePrice && cap < lot.basePrice) {
          cap = lot.basePrice;
        }

        if (cap >= lot.basePrice) {
          const priority =
            affinity * 0.65 +
            roleNeedMult * 0.4 +
            catchUp +
            (isBookmarked ? 1.25 : 0);
          contenders.push({ ts, score: priority, cap });
        }
      }

      // If an active lot already has a valid leader, ensure that leader is included
      if (isCurrentlyActiveWithBid && auctionRow.highest_bidder_team_id) {
        const leaderState = teamById.get(auctionRow.highest_bidder_team_id);
        if (
          leaderState &&
          leaderState.remainingBudget >= auctionRow.current_bid &&
          !contenders.some((c) => c.ts.team.id === leaderState.team.id)
        ) {
          contenders.push({
            ts: leaderState,
            score: 1.5,
            cap: Math.max(auctionRow.current_bid, lot.basePrice),
          });
        }
      }

      if (contenders.length === 0) {
        return false;
      }

      // Max 4 teams participate per lot
      contenders.sort((a, b) => b.score - a.score || b.cap - a.cap);
      const poolLimit = Math.min(4, Math.max(2, Math.floor(deterministicHash(lot.id, 409) * 3) + 2));
      const finalists = contenders.slice(0, poolLimit);
      finalists.sort((a, b) => b.cap - a.cap || b.score - a.score);

      const winner = finalists[0];
      let finalPrice = startingMinPrice;

      if (finalists.length >= 2) {
        const runnerUp = finalists[1];
        const contestedPrice = Math.min(
          winner.cap,
          Math.max(startingMinPrice, runnerUp.cap + (winner.cap > runnerUp.cap ? bidInc : 0))
        );
        finalPrice = Math.max(
          startingMinPrice,
          Math.min(winner.cap, Math.round(contestedPrice / bidInc) * bidInc)
        );
      }

      finalPrice = Math.min(winner.ts.remainingBudget, Math.max(lot.basePrice, finalPrice));

      winner.ts.squadCount += 1;
      if (player.isOverseas) winner.ts.overseasCount += 1;
      winner.ts.roleCounts[player.primaryRole] =
        (winner.ts.roleCounts[player.primaryRole] || 0) + 1;
      winner.ts.remainingBudget = Math.max(0, winner.ts.remainingBudget - finalPrice);
      winner.ts.signedNames.push(`${player.name} (${formatLakhsServer(finalPrice)})`);

      newContracts.push({
        leagueId,
        teamId: winner.ts.team.id,
        playerId: player.id,
        purchasePrice: finalPrice,
        salary: finalPrice,
        contractYears: 3,
        acquiredVia: 'auction',
      });

      lotUpdates.push({
        lotId: lot.id,
        status: 'sold',
        soldPrice: finalPrice,
        winningTeamId: winner.ts.team.id,
      });

      return true;
    };

    const secondChanceLots: Array<typeof lotsToSim[number]> = [];

    for (const item of lotsToSim) {
      const sold = runLotBidSim(item, false);
      if (!sold) {
        secondChanceLots.push(item);
      }
    }

    // Second pass over unsold items specifically for any team still below 22
    const stillUnsold: Array<typeof lotsToSim[number]> = [];
    for (const item of secondChanceLots) {
      const anyUnderMin = teamStates.some((ts) => ts.squadCount < requiredMinSquad);
      const sold = anyUnderMin ? runLotBidSim(item, true) : false;
      if (!sold) {
        stillUnsold.push(item);
      }
    }

    for (const item of stillUnsold) {
      lotUpdates.push({
        lotId: item.lot.id,
        status: 'unsold',
        soldPrice: null,
        winningTeamId: null,
      });
    }

    // Flush simulated contracts, lot outcomes, and team purses to DB
    for (let i = 0; i < newContracts.length; i += 200) {
      await tx.insert(playerContracts).values(newContracts.slice(i, i + 200));
    }

    for (const upd of lotUpdates) {
      await tx
        .update(auctionPlayers)
        .set({
          status: upd.status,
          soldPrice: upd.soldPrice,
          winningTeamId: upd.winningTeamId,
          updatedAt: now,
        })
        .where(eq(auctionPlayers.id, upd.lotId));
    }

    for (const ts of teamStates) {
      await tx
        .update(teams)
        .set({ remainingBudget: ts.remainingBudget })
        .where(eq(teams.id, ts.team.id));
    }

    // Guarantee EVERY franchise reaches 22+ contracted players
    const compRes = await enforceMinimumSquadCompletion(tx, league, auctionRow.id, now);

    // Refresh final squad counts for summaries
    const finalContracts = await tx
      .select({ teamId: playerContracts.teamId })
      .from(playerContracts)
      .where(eq(playerContracts.leagueId, leagueId));

    const finalTeamDocs = await tx
      .select()
      .from(teams)
      .where(eq(teams.leagueId, leagueId));

    const createdNotifs: Array<typeof notifications.$inferSelect> = [];
    for (const ft of finalTeamDocs) {
      if (!ft.ownerUid) continue;
      const count = finalContracts.filter((c) => c.teamId === ft.id).length;
      const ts = teamById.get(ft.id);
      const topSignings = (ts?.signedNames || []).slice(0, 6).join(', ');
      const [notif] = await tx
        .insert(notifications)
        .values({
          leagueId,
          targetUid: ft.ownerUid,
          category: 'Auction',
          title: `Instant Auction Complete · ${ft.shortCode} Squad (${count} Players)`,
          body: `Board Recruitment Desk,\n\nBy unanimous manager agreement, the player auction has been auto-simulated to completion.\n\n${ft.name} (${ft.shortCode}) finished with ${count} contracted players and ${formatLakhsServer(ft.remainingBudget)} remaining in the purse.${topSignings ? `\n\nKey auction acquisitions: ${topSignings}.` : ''}\n\nHead to Squad -> Lineups to set your starting XI, captain, and wicketkeeper for the upcoming schedule.\n\nChief Executive`,
        })
        .returning();
      if (notif) createdNotifs.push(notif);
    }

    const totalSoldCount = newContracts.length + compRes.assignedCount;
    const [systemMsg] = await tx
      .insert(leagueMessages)
      .values({
        leagueId,
        userUid: league.hostUid,
        teamShortCode: 'AUC',
        body: `Unanimous Auto-Sim Complete: ${totalSoldCount} players signed across ${finalTeamDocs.length} franchises. Every club has completed a ${requiredMinSquad}+ player squad!`,
        messageType: 'system',
      })
      .returning();

    await tx
      .update(auctions)
      .set({
        status: 'completed',
        currentLotId: null,
        currentBid: 0,
        highestBidderTeamId: null,
        highestBidderUid: null,
        lotEndsAt: null,
        remainingSecondsOnPause: null,
        currentSetName: 'Completed',
        pauseRequestsJson: [],
        pausedByUid: null,
        pausedByName: null,
        autoSimVotesJson: [],
        skipVotesJson: [],
        updatedAt: now,
      })
      .where(eq(auctions.id, auctionRow.id));

    await tx.update(leagues).set({ status: 'active' }).where(eq(leagues.id, leagueId));

    return {
      alreadyCompleted: false,
      leagueId,
      soldNow: totalSoldCount,
      completionAssigned: compRes.assignedCount,
      systemMsg: systemMsg ?? null,
      completionMsg: compRes.systemMsg,
      notifs: createdNotifs,
    };
  });

  const snapshot = await getAuctionSnapshot(leagueId);
  if (!result.alreadyCompleted) {
    wsHub.broadcastToLeague(leagueId, 'auction:auto_simulated', {
      soldCount: result.soldNow,
      snapshot,
    });
    wsHub.broadcastToLeague(leagueId, 'auction:state', snapshot);
    wsHub.broadcastToLeague(leagueId, 'league:updated', { leagueId });
    if (result.systemMsg) {
      wsHub.broadcastToLeague(leagueId, 'chat:message', result.systemMsg);
    }
    if (result.completionMsg) {
      wsHub.broadcastToLeague(leagueId, 'chat:message', result.completionMsg);
    }
    for (const notif of result.notifs) {
      if (notif.targetUid) {
        wsHub.sendToUser(notif.targetUid, 'notification:new', notif);
      }
    }
  }

  return snapshot;
}

/**
 * Evaluates unclaimed AI franchises on live lots and places realistic OVR-capped bids.
 */
async function triggerAiBiddingForAuction(auctionId: number) {
  const aiResult = await db.transaction(async (tx) => {
    const lockedRes = await tx.execute(
      sql`SELECT * FROM auctions WHERE id = ${auctionId} FOR UPDATE`
    );
    const auctionRow = lockedRes.rows[0] as
      | {
          id: number;
          league_id: number;
          status: string;
          current_lot_id: number | null;
          current_bid: number;
          highest_bidder_team_id: number | null;
          lot_ends_at: Date | null;
          updated_at: Date;
        }
      | undefined;

    if (!auctionRow || auctionRow.status !== 'live' || !auctionRow.current_lot_id) {
      return null;
    }

    const now = new Date();
    if (!auctionRow.lot_ends_at) return null;
    const msLeft = new Date(auctionRow.lot_ends_at).getTime() - now.getTime();
    const msSinceUpdate = now.getTime() - new Date(auctionRow.updated_at).getTime();

    // Give human managers natural breathing room (~1.6s pacing between bids)
    if (msLeft <= 1200 || msSinceUpdate < 1600) {
      return null;
    }

    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, auctionRow.league_id))
      .limit(1);
    if (!league) return null;

    const [lot] = await tx
      .select()
      .from(auctionPlayers)
      .where(eq(auctionPlayers.id, auctionRow.current_lot_id))
      .limit(1);
    if (!lot || lot.status !== 'active') return null;

    const [player] = await tx
      .select()
      .from(players)
      .where(eq(players.id, lot.playerId))
      .limit(1);
    if (!player) return null;

    const aiTeams = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.leagueId, league.id), sql`owner_uid IS NULL`));
    if (aiTeams.length === 0) return null;

    const nextBid =
      auctionRow.current_bid === 0
        ? lot.basePrice
        : auctionRow.current_bid + league.bidIncrement;

    const existingBidsOnLot = await tx
      .select({ teamId: bids.teamId })
      .from(bids)
      .where(eq(bids.auctionPlayerId, lot.id));
    const participatingTeamIds = new Set<number>(existingBidsOnLot.map((b) => b.teamId));

    const leagueContracts = await tx
      .select({
        teamId: playerContracts.teamId,
        isOverseas: players.isOverseas,
        primaryRole: players.primaryRole,
      })
      .from(playerContracts)
      .innerJoin(players, eq(playerContracts.playerId, players.id))
      .where(eq(playerContracts.leagueId, league.id));

    const budgetScale = Math.max(0.4, league.startingBudget / 10000);
    const { minVal, maxVal, ovr, isFringe } = getPlayerAuctionValuation(player, lot.basePrice);

    const requiredMinSquad = Math.max(22, league.minSquadSize || 22);
    const effectiveMaxSquad = Math.max(requiredMinSquad, league.maxSquadSize || 25);
    const aiContractsTotal = leagueContracts.filter((c) =>
      aiTeams.some((a) => a.id === c.teamId)
    ).length;
    const avgAiContracts = aiContractsTotal / Math.max(1, aiTeams.length);

    // Rank AI teams with strong catch-up urgency for clubs under 22+ players so none sit idle
    const rankedAi = aiTeams
      .map((aiTeam) => {
        const tContracts = leagueContracts.filter((c) => c.teamId === aiTeam.id);
        const roleCount = tContracts.filter((c) => c.primaryRole === player.primaryRole).length;
        const overseasCount = tContracts.filter((c) => c.isOverseas).length;
        const canFit =
          tContracts.length < effectiveMaxSquad &&
          (!player.isOverseas || overseasCount < league.maxOverseas);

        const roleNeedMult =
          player.primaryRole === 'Wicketkeeper' && roleCount >= 2
            ? 0.5
            : roleCount >= 7
              ? 0.65
              : roleCount === 0 && tContracts.length >= 4
                ? 1.28
                : 1.05;

        const lotAffinity = deterministicHash(lot.id * 31, aiTeam.id * 17);
        const deficit = Math.max(0, requiredMinSquad - tContracts.length);
        const catchUpBoost =
          Math.min(0.8, deficit * 0.03) +
          Math.max(0, avgAiContracts - tContracts.length) * 0.16;

        const priorityScore =
          (canFit ? 1 : -10) * (lotAffinity * 0.72 + roleNeedMult * 0.42 + catchUpBoost);
        return { aiTeam, tContracts, roleNeedMult, lotAffinity, priorityScore, canFit };
      })
      .filter((entry) => entry.canFit)
      .sort((a, b) => b.priorityScore - a.priorityScore);

    if (rankedAi.length === 0) return null;

    // Target 2 or 3 AI contenders per lot (never every team), respecting total 4 participating teams max per lot
    const targetAiCount = deterministicHash(lot.id, 991) > 0.45 ? 3 : 2;
    const targetedAi = rankedAi.slice(0, targetAiCount);

    const candidates: Array<{ team: typeof aiTeams[number]; cap: number }> = [];

    for (const entry of targetedAi) {
      const { aiTeam, tContracts, roleNeedMult, lotAffinity } = entry;
      if (aiTeam.id === auctionRow.highest_bidder_team_id) continue;

      const isAlreadyInLot = participatingTeamIds.has(aiTeam.id);
      if (!isAlreadyInLot && participatingTeamIds.size >= 4) continue;

      const slotsNeededAfterThis = Math.max(0, requiredMinSquad - tContracts.length - 1);
      const minReserve = slotsNeededAfterThis * Math.min(20, league.defaultBasePrice);
      const spendable = aiTeam.remainingBudget - minReserve;
      if (spendable < nextBid) continue;

      if (
        ovr < 66 &&
        lotAffinity < 0.2 &&
        !isAlreadyInLot &&
        tContracts.length >= requiredMinSquad - 4
      ) {
        continue;
      }

      const fierceBias = 0.35 + lotAffinity * 0.65;
      const rawCap = (minVal + fierceBias * (maxVal - minVal)) * budgetScale * roleNeedMult;
      const maxShare =
        player.marqueeSet === 'Marquee Stars' || ovr >= 82 ? 0.26 : 0.2;
      const hardTeamMax = isFringe
        ? Math.round(300 * budgetScale)
        : Math.round(league.startingBudget * maxShare);
      let cap = Math.min(hardTeamMax, Math.round(rawCap / 25) * 25);

      // Clubs under 22 players won't pass up an affordable opening bid
      if (auctionRow.current_bid === 0 && tContracts.length < requiredMinSquad) {
        cap = Math.max(cap, lot.basePrice);
      }

      if (nextBid <= cap) {
        candidates.push({ team: aiTeam, cap });
      }
    }

    // Guarantee that if a lot has 0 bids and any AI club under 22 can afford basePrice, one opens the bid
    if (candidates.length === 0 && auctionRow.current_bid === 0) {
      for (const entry of rankedAi) {
        const { aiTeam, tContracts } = entry;
        if (tContracts.length >= requiredMinSquad) continue;
        const slotsNeededAfterThis = Math.max(0, requiredMinSquad - tContracts.length - 1);
        const minReserve = slotsNeededAfterThis * 15;
        if (aiTeam.remainingBudget - minReserve >= lot.basePrice) {
          candidates.push({ team: aiTeam, cap: lot.basePrice });
          break;
        }
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.cap - a.cap);
    const pickIdx = Math.floor(Math.random() * Math.min(2, candidates.length));
    const chosen = candidates[pickIdx].team;

    const minEnd = new Date(now.getTime() + 7000);
    const nextEndsAt =
      new Date(auctionRow.lot_ends_at) < minEnd ? minEnd : new Date(auctionRow.lot_ends_at);

    await tx.insert(bids).values({
      auctionId: auctionRow.id,
      auctionPlayerId: lot.id,
      leagueId: league.id,
      teamId: chosen.id,
      userUid: league.hostUid,
      amount: nextBid,
    });

    await tx
      .update(auctions)
      .set({
        currentBid: nextBid,
        highestBidderTeamId: chosen.id,
        highestBidderUid: null,
        lotEndsAt: nextEndsAt,
        updatedAt: now,
      })
      .where(eq(auctions.id, auctionRow.id));

    return {
      leagueId: league.id,
      amount: nextBid,
      teamName: chosen.name,
      teamShortCode: chosen.shortCode,
    };
  });

  if (aiResult) {
    const snapshot = await getAuctionSnapshot(aiResult.leagueId);
    wsHub.broadcastToLeague(aiResult.leagueId, 'auction:bid', {
      bid: {
        amount: aiResult.amount,
        teamName: aiResult.teamName,
        teamShortCode: aiResult.teamShortCode,
        isAi: true,
      },
      snapshot,
    });
  }
}

export async function tickLiveAuctions() {
  const now = new Date();
  const expiredAuctions = await db
    .select({ id: auctions.id })
    .from(auctions)
    .where(and(eq(auctions.status, 'live'), lte(auctions.lotEndsAt, now)));

  for (const row of expiredAuctions) {
    await settleLotAtomic(row.id, false);
  }

  const liveAuctions = await db
    .select({ id: auctions.id })
    .from(auctions)
    .where(eq(auctions.status, 'live'));

  for (const row of liveAuctions) {
    await triggerAiBiddingForAuction(row.id);
  }
}

export function formatLakhsServer(lakhs: number): string {
  if (lakhs >= 100) {
    const cr = lakhs / 100;
    return `₹${Number.isInteger(cr) ? cr.toFixed(0) : cr.toFixed(2)} Cr`;
  }
  return `₹${lakhs} L`;
}
