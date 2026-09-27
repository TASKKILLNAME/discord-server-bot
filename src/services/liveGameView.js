const riotService = require('./riotService');
const { DDRAGON } = require('./championKnowledgeService');
const {
  ROLES,
  ROLE_LABELS,
  buildPerspective,
  playerTags,
  tierBadge,
  tierName,
  averageTier,
  teamSpyEstimate,
  queueName,
  mapName,
} = require('./liveBriefingAnalysis');
const { summarizeCompleteness } = require('./liveBriefingService');

// ============================================
// 🧩 /전적 실시간 화면 데이터 (카드 이미지·텍스트가 같이 쓴다)
// 외부 호출 없음. 숫자는 모두 model에서 온다.
// ============================================

const TEAM_NAMES = { 100: '블루 팀', 200: '레드 팀' };

function championIcon(version, championId) {
  const dataId = riotService.getChampionDataId(championId);
  return version && dataId ? `${DDRAGON}/cdn/${version}/img/champion/${dataId}.png` : null;
}

function spellIcon(version, spellDataId) {
  return version && spellDataId ? `${DDRAGON}/cdn/${version}/img/spell/${spellDataId}.png` : null;
}

function roleText(roleInfo) {
  if (!roleInfo || roleInfo.level === 'unsupported') return null;
  if (!roleInfo.slotRole) return '포지션 불확실';
  const label = ROLE_LABELS[roleInfo.slotRole];
  if (roleInfo.level === 'user') return `${label}(지정)`;
  return roleInfo.level === 'estimated' ? label : `${label}?`;
}

function playerView(model, perspective, player, teammates) {
  const version = model.staticData?.version || null;
  const roleInfo = perspective.roles.get(player.slot);
  const s = player.stats;
  const keystone = player.runes?.keystoneId != null ? model.runes?.get(player.runes.keystoneId) : null;
  const subStyle = player.runes?.subStyleId != null ? model.runes?.get(player.runes.subStyleId) : null;
  const masteries = player.topMasteries?.status === 'ok' ? player.topMasteries.champions : [];

  return {
    slot: player.slot,
    isTarget: perspective.target?.slot === player.slot,
    hidden: player.hidden,
    bot: player.bot,
    name: player.displayName,
    championId: player.championId,
    championName: player.championName,
    championIcon: championIcon(version, player.championId),
    spells: player.spellNames.map((name, i) => ({ name, icon: spellIcon(version, player.spellDataIds?.[i]) })),
    keystone: keystone ? { name: keystone.name, icon: keystone.icon } : null,
    subStyle: subStyle ? { name: subStyle.name, icon: subStyle.icon } : null,
    role: roleInfo,
    roleText: roleText(roleInfo),
    rank: player.rank,
    tierBadge: tierBadge(player.rank),
    tierName: tierName(player.rank),
    season: player.rank?.status === 'ranked' && Number.isInteger(player.rank.wins) && Number.isInteger(player.rank.losses)
      ? {
          games: player.rank.wins + player.rank.losses,
          winPermil: player.rank.wins + player.rank.losses > 0
            ? Math.round((player.rank.wins * 1000) / (player.rank.wins + player.rank.losses))
            : null,
        }
      : null,
    historyStatus: player.history.status,
    historyReason: player.history.reason,
    stats: s,
    recent: (s?.recent || []).map((g) => ({ ...g, icon: championIcon(version, g.championId) })),
    mains: masteries.map((m) => ({
      championId: m.championId,
      name: riotService.getChampionName(m.championId),
      icon: championIcon(version, m.championId),
      points: m.points,
    })),
    tags: playerTags(player, roleInfo, teammates),
  };
}

function teamView(model, perspective, teamId, players) {
  const isAlly = perspective.mode === 'personal' && perspective.allyTeamId === teamId;
  const damage = { physical: 0, magic: 0, mixed: 0, unknown: 0 };
  for (const p of players) {
    const lean = model.profiles?.get(p.championId)?.damageLean;
    damage[lean || 'unknown']++;
  }
  const version = model.staticData?.version || null;
  return {
    teamId,
    name: TEAM_NAMES[teamId] || `팀 ${teamId}`,
    isAlly,
    avgTier: averageTier(players),
    // 우리 팀은 조회 대상 본인을 빼고 계산한다 (자기 자신이 첩자일 확률은 의미 없음)
    spy: teamSpyEstimate(players, isAlly ? perspective.target.slot : null),
    damage,
    bans: (model.game.bans || [])
      .filter((b) => b.teamId === teamId)
      .map((b) => ({ championId: b.championId, name: riotService.getChampionName(b.championId), icon: championIcon(version, b.championId) })),
  };
}

/**
 * 라인별 행: 역할 분석이 되면 탑→서폿 순서로 양 팀을 맞대고, 안 되면 참가 순서대로 맞댄다.
 */
function buildRows(teams, playersByTeam, perspective) {
  const [left, right] = teams;
  if (perspective.roleSupported) {
    return ROLES.map((role) => ({
      role,
      roleLabel: ROLE_LABELS[role],
      left: playersByTeam[left].find((p) => p.role?.slotRole === role) || null,
      right: playersByTeam[right].find((p) => p.role?.slotRole === role) || null,
    }));
  }
  const count = Math.max(playersByTeam[left].length, playersByTeam[right].length);
  return Array.from({ length: count }, (_, i) => ({
    role: null,
    roleLabel: null,
    left: playersByTeam[left][i] || null,
    right: playersByTeam[right][i] || null,
  }));
}

function buildLiveGameView(model, { roleOverride = null } = {}) {
  const perspective = buildPerspective(model, { roleOverride });
  const teamIds = [...new Set(model.participants.map((p) => p.teamId))].sort((a, b) => a - b);
  const playersByTeam = {};
  const teams = teamIds.map((teamId) => {
    const raw = model.participants.filter((p) => p.teamId === teamId);
    playersByTeam[teamId] = raw.map((p) => playerView(model, perspective, p, raw));
    return teamView(model, perspective, teamId, raw);
  });

  const started = model.game.gameStartTime;
  return {
    account: model.account,
    mode: perspective.mode,
    target: perspective.target ? playersByTeam[perspective.target.teamId].find((p) => p.isTarget) : null,
    myRole: perspective.myRole || null,
    queueLabel: queueName(model.game.queueId),
    mapLabel: mapName(model.game.mapId),
    elapsedMinutes: started ? Math.max(0, Math.floor((model.analyzedAt - started) / 60000)) : null,
    version: model.staticData?.version || null,
    settings: model.settings,
    roleSupported: perspective.roleSupported,
    teams,
    rows: buildRows(teamIds, playersByTeam, perspective),
    completeness: summarizeCompleteness(model, perspective),
    analyzedAt: model.analyzedAt,
  };
}

module.exports = { buildLiveGameView, championIcon };
