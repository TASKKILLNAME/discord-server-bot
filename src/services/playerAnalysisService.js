'use strict';

const { ROLES, ANALYSIS_CONFIG } = require('../constants/realtimeAnalysis');

function normalizeRole(value) {
  const role = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', MID: 'MID',
    BOTTOM: 'ADC', ADC: 'ADC', UTILITY: 'SUPPORT', SUPPORT: 'SUPPORT' }[value];
  return ROLES.includes(role) ? role : null;
}

function emptyRoles() {
  return Object.fromEntries(ROLES.map((role) => [role, 0]));
}

function analyzeRecentGames(games, currentChampionId) {
  const recent = [...games].sort((a, b) => b.endedAt - a.endedAt || a.matchId.localeCompare(b.matchId))
    .slice(0, ANALYSIS_CONFIG.sampleSize);
  const roleCounts = emptyRoles();
  const currentChampionRoles = emptyRoles();
  const champions = new Map();
  let wins = 0;
  let roleSample = 0;
  let currentChampionGames = 0;
  for (const game of recent) {
    wins += Number(game.win);
    const role = normalizeRole(game.teamPosition);
    if (role) { roleCounts[role]++; roleSample++; }
    if (game.championId === currentChampionId) {
      currentChampionGames++;
      if (role) currentChampionRoles[role]++;
    }
    const champion = champions.get(game.championId) || {
      championId: game.championId, name: game.championName, games: 0, wins: 0,
      latest: game.endedAt,
    };
    champion.games++;
    champion.wins += Number(game.win);
    champions.set(game.championId, champion);
  }
  const orderedRoles = ROLES.filter((role) => roleCounts[role] > 0)
    .sort((a, b) => roleCounts[b] - roleCounts[a]);
  // A tie is not evidence for a single main position.
  const primaryRole = orderedRoles.length && roleCounts[orderedRoles[0]] !== roleCounts[orderedRoles[1]]
    ? orderedRoles[0] : null;
  let lossStreak = 0;
  for (const game of recent) {
    if (game.win) break;
    lossStreak++;
  }
  return {
    status: 'ok', sampleSize: recent.length, wins, losses: recent.length - wins,
    winRate: recent.length ? wins / recent.length : null,
    roleCounts, roleSample, primaryRole,
    primaryRoleRate: primaryRole ? roleCounts[primaryRole] / roleSample : null,
    currentChampionGames, currentChampionRoles,
    mainChampions: [...champions.values()]
      .sort((a, b) => b.games - a.games || b.latest - a.latest || a.championId - b.championId)
      .slice(0, 2)
      .map((c) => ({ ...c, losses: c.games - c.wins, winRate: c.wins / c.games })),
    lossStreak, streakAtLeast: recent.length > 0 && lossStreak === recent.length,
  };
}

function validateMatchData(detail, matchId) {
  const info = detail?.info;
  if (!info || !Array.isArray(info.participants) ||
      (detail.metadata?.matchId && detail.metadata.matchId !== matchId) ||
      !Number.isFinite(info.gameDuration) || !Number.isFinite(info.gameEndTimestamp) || info.gameEndTimestamp <= 0) {
    throw new Error('Invalid match data');
  }
  return info;
}

function extractRecentGame(detail, puuid, matchId, getChampionName) {
  const info = validateMatchData(detail, matchId);
  if (info.queueId !== ANALYSIS_CONFIG.queueId || info.gameDuration < ANALYSIS_CONFIG.minGameDurationSec) return null;
  const players = info.participants.filter((p) => p.puuid === puuid);
  if (players.length !== 1 || typeof players[0].win !== 'boolean' ||
      !Number.isInteger(players[0].championId) || players[0].championId <= 0) {
    throw new Error('Invalid participant data');
  }
  const player = players[0];
  return {
    matchId, endedAt: info.gameEndTimestamp, win: player.win,
    championId: player.championId, championName: getChampionName(player.championId),
    teamPosition: player.teamPosition,
  };
}

module.exports = { normalizeRole, analyzeRecentGames, extractRecentGame, validateMatchData };
