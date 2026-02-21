const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================
// ⚙️ 설정
// ============================================
const RIOT_API_KEY = () => process.env.RIOT_API_KEY;

const PLATFORM_URL = 'https://kr.api.riotgames.com';
const REGIONAL_URL = 'https://asia.api.riotgames.com';

const CHAMPIONS_CACHE = path.join(__dirname, '../../data/champions.json');
const SPELLS_CACHE = path.join(__dirname, '../../data/spells.json');

let championsData = null;
let spellsData = null;

// ============================================
// 🚦 레이트 리밋 관리
// ============================================
let requestQueue = Promise.resolve();
const MIN_INTERVAL = 60; // 60ms (~16 req/sec, 20 한도 내)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function riotApiRequest(url, retries = 2) {
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue.then(async () => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const response = await axios.get(url, {
            headers: { 'X-Riot-Token': RIOT_API_KEY() },
            timeout: 15000,
          });
          await sleep(MIN_INTERVAL);
          resolve(response.data);
          return;
        } catch (err) {
          if (err.response?.status === 429) {
            const retryAfter = parseInt(err.response.headers['retry-after'] || '5', 10);
            console.error(`⏳ Riot API 레이트 리밋. ${retryAfter}초 후 재시도...`);
            await sleep(retryAfter * 1000);
            continue;
          }
          if (err.response?.status === 404) {
            resolve(null); // 404는 "없음" 의미
            return;
          }
          if (attempt === retries) {
            reject(err);
            return;
          }
          await sleep(1000);
        }
      }
    });
  });
}

// ============================================
// 🔍 기본 API 호출 함수
// ============================================

/**
 * Riot ID로 PUUID 조회
 */
async function getAccountByRiotId(gameName, tagLine) {
  const url = `${REGIONAL_URL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const data = await riotApiRequest(url);
  if (!data) {
    const err = new Error('소환사를 찾을 수 없습니다. 게임이름#태그를 확인해주세요.');
    err.userMessage = err.message;
    throw err;
  }
  return data;
}

/**
 * 실시간 게임 조회 (Spectator V5)
 */
async function getLiveGame(puuid) {
  const url = `${PLATFORM_URL}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
  return await riotApiRequest(url); // null이면 게임 중 아님
}

/**
 * 소환사 정보 조회
 */
async function getSummonerByPuuid(puuid) {
  const url = `${PLATFORM_URL}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
  return await riotApiRequest(url);
}

/**
 * 랭크 정보 조회 (PUUID 기반)
 */
async function getRankByPuuid(puuid) {
  const url = `${PLATFORM_URL}/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
  const data = await riotApiRequest(url);
  return data || [];
}

/**
 * 최근 매치 ID 목록
 */
async function getRecentMatchIds(puuid, count = 5) {
  const url = `${REGIONAL_URL}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=0&count=${count}`;
  const data = await riotApiRequest(url);
  return data || [];
}

/**
 * 매치 상세 정보
 */
async function getMatchDetail(matchId) {
  const url = `${REGIONAL_URL}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  return await riotApiRequest(url);
}

/**
 * 매치 타임라인 조회 (Match-v5 Timeline)
 */
async function getMatchTimeline(matchId) {
  const url = `${REGIONAL_URL}/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`;
  return await riotApiRequest(url);
}

// ============================================
// 📦 정적 데이터 (Data Dragon)
// ============================================

async function initStaticData() {
  if (championsData && spellsData) return;

  try {
    // 캐시 확인 (24시간 이내면 재사용)
    if (fs.existsSync(CHAMPIONS_CACHE) && fs.existsSync(SPELLS_CACHE)) {
      const champFile = JSON.parse(fs.readFileSync(CHAMPIONS_CACHE, 'utf-8'));
      const spellFile = JSON.parse(fs.readFileSync(SPELLS_CACHE, 'utf-8'));
      const cacheAge = Date.now() - new Date(champFile.updatedAt).getTime();

      if (cacheAge < 24 * 60 * 60 * 1000) {
        championsData = champFile.champions;
        spellsData = spellFile.spells;
        console.log('📦 챔피언/스펠 데이터 캐시 로드 완료');
        return;
      }
    }
  } catch (err) {
    // 캐시 로드 실패 시 새로 다운로드
  }

  try {
    // 최신 버전 조회
    const versions = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 10000 });
    const version = versions.data[0];
    console.log(`📦 Data Dragon 버전: ${version}`);

    // 챔피언 데이터
    const champRes = await axios.get(
      `https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`,
      { timeout: 10000 }
    );
    const champions = {};
    for (const [, champ] of Object.entries(champRes.data.data)) {
      champions[champ.key] = {
        id: champ.id,
        name: champ.name,
        image: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champ.image.full}`,
      };
    }

    // 스펠 데이터
    const spellRes = await axios.get(
      `https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/summoner.json`,
      { timeout: 10000 }
    );
    const spells = {};
    for (const [, spell] of Object.entries(spellRes.data.data)) {
      spells[spell.key] = {
        id: spell.id,
        name: spell.name,
      };
    }

    // 캐시 저장
    const dir = path.dirname(CHAMPIONS_CACHE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(CHAMPIONS_CACHE, JSON.stringify({ version, updatedAt: new Date().toISOString(), champions }, null, 2));
    fs.writeFileSync(SPELLS_CACHE, JSON.stringify({ version, updatedAt: new Date().toISOString(), spells }, null, 2));

    championsData = champions;
    spellsData = spells;
    console.log(`✅ 챔피언 ${Object.keys(champions).length}개, 스펠 ${Object.keys(spells).length}개 로드 완료`);
  } catch (err) {
    console.error('❌ Data Dragon 로드 실패:', err.message);
    // 빈 데이터로 초기화
    if (!championsData) championsData = {};
    if (!spellsData) spellsData = {};
  }
}

function getChampionName(championId) {
  return championsData?.[String(championId)]?.name || `챔피언(${championId})`;
}

function getChampionImage(championId) {
  return championsData?.[String(championId)]?.image || null;
}

function getSpellName(spellId) {
  return spellsData?.[String(spellId)]?.name || `스펠(${spellId})`;
}

// ============================================
// 🏆 랭크 포맷팅
// ============================================
function formatRank(rankEntries) {
  if (!rankEntries || rankEntries.length === 0) return '언랭크';

  const primary = rankEntries.find((r) => r.queueType === 'RANKED_SOLO_5x5');

  if (!primary) return '언랭크';

  const wins = primary.wins || 0;
  const losses = primary.losses || 0;
  const total = wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  const tierKo = {
    IRON: '아이언', BRONZE: '브론즈', SILVER: '실버', GOLD: '골드',
    PLATINUM: '플래티넘', EMERALD: '에메랄드', DIAMOND: '다이아몬드',
    MASTER: '마스터', GRANDMASTER: '그랜드마스터', CHALLENGER: '챌린저',
  };

  const tierName = tierKo[primary.tier] || primary.tier;
  return `${tierName} ${primary.rank} ${primary.leaguePoints}LP (${winRate}% / ${total}판)`;
}

// ============================================
// 🎮 상위 함수: 실시간 게임 데이터
// ============================================
async function fetchLiveGameData(gameName, tagLine) {
  await initStaticData();

  // 1. 계정 조회
  const account = await getAccountByRiotId(gameName, tagLine);

  // 2. 실시간 게임 조회
  const liveGame = await getLiveGame(account.puuid);

  if (!liveGame) {
    return { notInGame: true, account };
  }

  // 3. 10명 참가자 데이터 수집
  const blueTeam = [];
  const redTeam = [];

  const participants = liveGame.participants || [];

  for (const p of participants) {
    let rank = '언랭크';
    try {
      // puuid가 null인 경우 (봇 등) 스킵
      if (p.puuid) {
        const rankData = await getRankByPuuid(p.puuid);
        rank = formatRank(rankData);
      }
    } catch (err) {
      // 랭크 조회 실패 시 언랭크로 표시
    }

    const playerData = {
      championName: getChampionName(p.championId),
      championImage: getChampionImage(p.championId),
      spell1: getSpellName(p.spell1Id),
      spell2: getSpellName(p.spell2Id),
      rank,
      teamId: p.teamId,
    };

    if (p.teamId === 100) {
      blueTeam.push(playerData);
    } else {
      redTeam.push(playerData);
    }
  }

  return {
    notInGame: false,
    account,
    gameMode: liveGame.gameMode || '소환사 협곡',
    gameLength: liveGame.gameLength || 0,
    blueTeam,
    redTeam,
  };
}

// ============================================
// 📊 상위 함수: 최근 전적 데이터
// ============================================
async function fetchRecentMatchData(gameName, tagLine, count = 5) {
  await initStaticData();

  // 1. 계정 조회
  const account = await getAccountByRiotId(gameName, tagLine);

  // 2. 소환사 정보 + 랭크
  const summoner = await getSummonerByPuuid(account.puuid);
  let rank = '언랭크';
  let summonerLevel = 0;

  if (summoner) {
    const rankData = await getRankByPuuid(account.puuid);
    rank = formatRank(rankData);
    summonerLevel = summoner.summonerLevel || 0;
  }

  // 3. 최근 매치 ID
  const matchIds = await getRecentMatchIds(account.puuid, count);

  if (matchIds.length === 0) {
    return {
      account,
      rank,
      summonerLevel,
      matches: [],
    };
  }

  // 4. 매치 상세 조회
  const matches = [];
  for (const matchId of matchIds) {
    try {
      const detail = await getMatchDetail(matchId);
      if (!detail) continue;

      const participant = detail.info.participants.find(
        (p) => p.puuid === account.puuid
      );
      if (!participant) continue;

      const duration = detail.info.gameDuration;
      const durationMin = Math.floor(duration / 60);

      matches.push({
        champion: getChampionName(participant.championId),
        win: participant.win,
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        kda:
          participant.deaths === 0
            ? 'Perfect'
            : ((participant.kills + participant.assists) / participant.deaths).toFixed(1),
        cs: participant.totalMinionsKilled + participant.neutralMinionsKilled,
        csPerMin: (
          (participant.totalMinionsKilled + participant.neutralMinionsKilled) /
          (duration / 60)
        ).toFixed(1),
        damage: participant.totalDamageDealtToChampions,
        visionScore: participant.visionScore,
        gameMode: detail.info.gameMode,
        duration: `${durationMin}분`,
        teamPosition: participant.teamPosition || '?',
        spell1: getSpellName(participant.summoner1Id),
        spell2: getSpellName(participant.summoner2Id),
      });
    } catch (err) {
      console.error(`매치 상세 조회 실패 (${matchId}):`, err.message);
    }
  }

  return {
    account,
    rank,
    summonerLevel,
    matches,
  };
}

module.exports = {
  initStaticData,
  getAccountByRiotId,
  getLiveGame,
  getSummonerByPuuid,
  getRankByPuuid,
  getRecentMatchIds,
  getMatchDetail,
  getMatchTimeline,
  getChampionName,
  getSpellName,
  formatRank,
  fetchLiveGameData,
  fetchRecentMatchData,
};
