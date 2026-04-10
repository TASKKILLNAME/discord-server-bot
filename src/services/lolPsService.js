const axios = require('axios');

/**
 * lol.ps 챔피언 라인별 데이터 서비스
 *
 * lol.ps의 SvelteKit __data.json 엔드포인트를 호출해서
 * 라인별 챔피언 목록을 메모리에 캐싱한다.
 *
 * 봇 시작 시 init()을 1회 호출하면 끝. 패치마다 갱신하려면 봇을 재시작.
 */

const ENDPOINT = 'https://lol.ps/statistics/__data.json';

// laneId → 내부 키 (lol.ps에서 확인된 매핑)
const LANE_ID_TO_KEY = {
  0: 'TOP',
  1: 'JUNGLE',
  2: 'MID',
  3: 'ADC',
  4: 'SUPPORT',
};

// 한글 라인명 → 내부 키 (슬래시 커맨드 옵션용)
const LANE_KO_TO_KEY = {
  탑: 'TOP',
  정글: 'JUNGLE',
  미드: 'MID',
  바텀: 'ADC',
  원딜: 'ADC',
  서폿: 'SUPPORT',
  서포터: 'SUPPORT',
};

// { TOP: ['가렌', ...], JUNGLE: [...], ... }
let cache = null;
let cacheLoadedAt = null;

/**
 * SvelteKit devalue 포맷의 flat array를 일반 객체로 복원
 */
function hydrate(arr) {
  const seen = new Map();
  function visit(idx) {
    if (idx === -1) return undefined;
    if (idx === -2) return null;
    if (idx === -3) return NaN;
    if (idx === -4) return Infinity;
    if (idx === -5) return -Infinity;
    if (idx === -6) return -0;
    if (seen.has(idx)) return seen.get(idx);
    const v = arr[idx];
    if (v === null || typeof v !== 'object') {
      seen.set(idx, v);
      return v;
    }
    if (Array.isArray(v)) {
      const out = [];
      seen.set(idx, out);
      for (const i of v) out.push(visit(i));
      return out;
    }
    const out = {};
    seen.set(idx, out);
    for (const [k, i] of Object.entries(v)) out[k] = visit(i);
    return out;
  }
  return visit(0);
}

/**
 * lol.ps에서 데이터를 받아 라인별 챔피언 목록으로 변환
 */
async function fetchAndParse() {
  const { data } = await axios.get(ENDPOINT, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  // nodes[3]이 tierlist를 담고 있는 노드 (확인됨)
  const tierNode = data?.nodes?.[3];
  if (!tierNode || !Array.isArray(tierNode.data)) {
    throw new Error('lol.ps 응답 구조가 예상과 다름 (nodes[3].data 없음)');
  }

  const hydrated = hydrate(tierNode.data);
  const tierlist = hydrated?.tierlist;
  if (!Array.isArray(tierlist)) {
    throw new Error('lol.ps tierlist 파싱 실패');
  }

  const result = { TOP: [], JUNGLE: [], MID: [], ADC: [], SUPPORT: [] };
  const seen = { TOP: new Set(), JUNGLE: new Set(), MID: new Set(), ADC: new Set(), SUPPORT: new Set() };

  for (const entry of tierlist) {
    const laneKey = LANE_ID_TO_KEY[entry.laneId];
    if (!laneKey) continue;
    const name = entry?.championInfo?.nameKr;
    if (!name) continue;
    if (seen[laneKey].has(name)) continue;
    seen[laneKey].add(name);
    result[laneKey].push(name);
  }

  return result;
}

/**
 * 봇 시작 시 1회 호출. 캐시를 채운다.
 */
async function init() {
  try {
    cache = await fetchAndParse();
    cacheLoadedAt = new Date();
    const counts = Object.entries(cache)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(', ');
    console.log(`🎲 lol.ps 챔피언 캐시 로드 완료 (${counts})`);
  } catch (err) {
    console.error('❌ lol.ps 챔피언 캐시 로드 실패:', err.message);
    cache = null;
  }
}

/**
 * 라인 키워드(한글 또는 내부 키)를 내부 키로 정규화
 */
function normalizeLane(input) {
  if (!input) return null;
  const upper = String(input).toUpperCase();
  if (LANE_ID_TO_KEY[0] === upper || LANE_ID_TO_KEY[1] === upper || LANE_ID_TO_KEY[2] === upper || LANE_ID_TO_KEY[3] === upper || LANE_ID_TO_KEY[4] === upper) {
    return upper;
  }
  return LANE_KO_TO_KEY[input] || null;
}

/**
 * 지정한 라인에서 랜덤 챔피언을 count명 뽑는다 (중복 없음).
 * @param {string} laneInput - '탑'|'정글'|'미드'|'바텀'|'서폿' 또는 내부 키
 * @param {number} count - 뽑을 챔피언 수 (기본 1)
 * @returns {string[]} 챔피언 한글명 배열
 */
function getRandomChampions(laneInput, count = 1) {
  if (!cache) {
    throw new Error('챔피언 캐시가 아직 로드되지 않았습니다. 봇 재시작 후 다시 시도해주세요.');
  }
  const lane = normalizeLane(laneInput);
  if (!lane) {
    throw new Error(`알 수 없는 라인: ${laneInput}`);
  }
  const pool = cache[lane];
  if (!pool || pool.length === 0) {
    throw new Error(`${lane} 라인 챔피언 데이터가 없습니다.`);
  }

  const n = Math.min(Math.max(1, count), pool.length);
  // Fisher-Yates 부분 셔플
  const arr = pool.slice();
  for (let i = arr.length - 1; i > arr.length - 1 - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(arr.length - n);
}

function getCacheInfo() {
  if (!cache) return { loaded: false };
  return {
    loaded: true,
    loadedAt: cacheLoadedAt,
    counts: Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v.length])),
  };
}

module.exports = {
  init,
  getRandomChampions,
  getCacheInfo,
  LANE_KO_TO_KEY,
};
