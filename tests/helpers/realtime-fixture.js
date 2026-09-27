'use strict';

function createFixture() {
  const calls = { accounts: [], live: [], rank: [], ids: [], match: [] };
  const names = { 201: '브라움', 266: '아트록스', 58: '레넥톤', 64: '리 신', 103: '아리', 222: '징크스', 902: '밀리오', 117: '룰루', 20: '누누와 윌럼프' };
  const roles = { 브라움: ['SUPPORT'], 아트록스: ['TOP'], '리 신': ['JUNGLE'], 아리: ['MID'], 징크스: ['ADC'], 밀리오: ['SUPPORT'] };
  const participants = [201, 266, 64, 103, 222].map((championId, i) => ({
    puuid: `ally-${i}`, riotId: i === 0 ? '흰수염#KR1' : `player${i}#KR1`,
    teamId: 100, championId, spell1Id: i === 2 ? 11 : 4, spell2Id: 12,
  }));
  participants.push(...participants.map((p, i) => ({ ...p, puuid: `enemy-${i}`, riotId: `enemy${i}#KR1`, teamId: 200 })));
  const live = { gameId: 123, mapId: 11, gameQueueConfigId: 420, participants };
  const state = { live, rankError: null, historyError: null, detailError: null, unranked: null, privateId: null };
  const api = {
    async initStaticData() {},
    getChampionName: (id) => names[id] || `챔피언(${id})`,
    async getAccountByRiotId(name, tag) { calls.accounts.push([name, tag]); return { puuid: 'ally-0', gameName: '흰수염', tagLine: 'KR1' }; },
    async getLiveGame(puuid) { calls.live.push(puuid); return state.live; },
    async getRankByPuuid(puuid, options) {
      calls.rank.push(puuid);
      if (!options.throwOnNotFound) throw new Error('Strict rank required');
      if (state.rankError === puuid) throw new Error('rank failure');
      return [{ queueType: 'RANKED_FLEX_SR', tier: 'CHALLENGER', rank: 'I', leaguePoints: 999 },
        ...(state.unranked === puuid ? [] : [{ queueType: 'RANKED_SOLO_5x5',
          ...({ 'ally-2': { tier: 'PLATINUM', rank: 'I', leaguePoints: 22 },
            'ally-3': { tier: 'DIAMOND', rank: 'I', leaguePoints: 75 },
            'ally-4': { tier: 'EMERALD', rank: 'I', leaguePoints: 33 } }[puuid] ||
            { tier: 'DIAMOND', rank: 'II', leaguePoints: 43 }) }])];
    },
    async getRecentMatchIds(puuid, count, options) {
      calls.ids.push([puuid, count, options.queue]);
      if (state.historyError === puuid) throw new Error('history failure');
      return Array.from({ length: puuid === 'ally-4' ? 9 : 20 }, (_, i) => `KR_${i}`);
    },
    async getMatchDetail(id) {
      calls.match.push(id);
      if (state.detailError === id) throw new Error('detail failure');
      const i = Number(id.slice(3));
      return { metadata: { matchId: id }, info: {
        queueId: 420, gameDuration: 1800, gameEndTimestamp: 2_000_000 - i * 1000,
        participants: participants.map((p, index) => ({ puuid: p.puuid,
          championId: p.puuid === 'ally-2' ? (i < 12 ? 902 : i < 17 ? 117 : 20)
            : p.puuid === 'ally-1' && i >= 12 ? 58 : p.championId,
          championName: names[p.championId],
          teamPosition: p.puuid === 'ally-2' ? (i < 17 ? 'UTILITY' : 'JUNGLE') : ['UTILITY', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM'][index % 5],
          win: p.puuid === 'ally-2' ? i >= 4 && i < 12 : p.puuid === 'ally-4' ? i < 4
            : p.puuid === 'ally-1' ? i < 7 || (i >= 12 && i < 16) : i < 12,
        })),
      } };
    },
  };
  return { api, calls, state, participants, getChampionRoles: (name) => roles[name] || [] };
}

module.exports = { createFixture };
