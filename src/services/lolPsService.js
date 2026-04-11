const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * lol.ps 챔피언 라인별 데이터 서비스
 *
 * 우선순위:
 *   1) data/lolps-champions.json (로컬 스냅샷) ← 기본 동작, 드롭릿에서 사용
 *   2) 그래도 없으면 lol.ps 라이브 fetch (로컬 개발용 폴백)
 *
 * lol.ps는 미국 DigitalOcean 같은 일부 지역에서 차단되므로,
 * 패치마다 한국에서 `node scripts/refresh-lolps.js`를 돌려
 * data/lolps-champions.json을 갱신하고 git에 커밋한다.
 */

const ENDPOINT = 'https://lol.ps/statistics/__data.json';
// assets/는 named volume이 마운트되는 data/와 달리 이미지에 그대로 들어가므로
// 컨테이너 안에서 항상 접근 가능하다.
const SNAPSHOT_PATH = path.join(__dirname, '..', '..', 'assets', 'lolps-champions.json');

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
let allPool = null; // 모든 라인의 챔피언 합집합 (꽝 당첨 시 뽑기 풀)
let cacheLoadedAt = null;
let cacheSource = null;

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
 * 로컬 스냅샷 JSON에서 캐시 로드
 */
function loadFromSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed?.champions) return null;
  return {
    champions: parsed.champions,
    updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : null,
  };
}

/**
 * lol.ps에서 라이브 fetch (폴백용)
 */
async function fetchAndParse() {
  const { data } = await axios.get(ENDPOINT, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

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
  const seen = {
    TOP: new Set(),
    JUNGLE: new Set(),
    MID: new Set(),
    ADC: new Set(),
    SUPPORT: new Set(),
  };

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
 * 모든 라인의 챔피언을 합쳐서 중복 제거한 전체 풀 빌드
 */
function buildAllPool() {
  if (!cache) return null;
  const set = new Set();
  for (const pool of Object.values(cache)) {
    for (const name of pool) set.add(name);
  }
  return Array.from(set);
}

/**
 * 봇 시작 시 1회 호출. 캐시를 채운다.
 * 1순위: 로컬 스냅샷
 * 2순위: 라이브 fetch (스냅샷이 없거나 망가졌을 때)
 */
async function init() {
  // 1) 로컬 스냅샷 시도
  try {
    const snap = loadFromSnapshot();
    if (snap) {
      cache = snap.champions;
      allPool = buildAllPool();
      cacheLoadedAt = snap.updatedAt || new Date();
      cacheSource = 'snapshot';
      const counts = Object.entries(cache)
        .map(([k, v]) => `${k}=${v.length}`)
        .join(', ');
      console.log(`🎲 lol.ps 챔피언 스냅샷 로드 완료 (${counts}, 전체=${allPool.length})`);
      return;
    }
  } catch (err) {
    console.error('⚠️ lol.ps 스냅샷 로드 실패, 라이브 fetch 시도:', err.message);
  }

  // 2) 라이브 fetch 폴백
  try {
    cache = await fetchAndParse();
    allPool = buildAllPool();
    cacheLoadedAt = new Date();
    cacheSource = 'live';
    const counts = Object.entries(cache)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(', ');
    console.log(`🎲 lol.ps 챔피언 라이브 로드 완료 (${counts}, 전체=${allPool.length})`);
  } catch (err) {
    console.error('❌ lol.ps 챔피언 캐시 로드 실패:', err.message);
    cache = null;
    allPool = null;
  }
}

/**
 * 라인 키워드(한글 또는 내부 키)를 내부 키로 정규화
 */
function normalizeLane(input) {
  if (!input) return null;
  const upper = String(input).toUpperCase();
  if (
    LANE_ID_TO_KEY[0] === upper ||
    LANE_ID_TO_KEY[1] === upper ||
    LANE_ID_TO_KEY[2] === upper ||
    LANE_ID_TO_KEY[3] === upper ||
    LANE_ID_TO_KEY[4] === upper
  ) {
    return upper;
  }
  return LANE_KO_TO_KEY[input] || null;
}

/**
 * 지정한 라인에서 랜덤 챔피언을 count명 뽑는다 (중복 없음).
 *
 * 각 뽑기마다 "꽝" 슬롯 1개가 라인 풀에 섞여 있다고 가정한다.
 * 즉, 라인 풀 크기가 N이면 꽝이 나올 확률은 1/(N+1).
 * 꽝이 나오면 해당 1픽은 전체 챔피언 풀에서 뽑는다 (라인 무시).
 *
 * @param {string} laneInput - '탑'|'정글'|'미드'|'바텀'|'서폿' 또는 내부 키
 * @param {number} count - 뽑을 챔피언 수 (기본 1)
 * @returns {Array<{ name: string, jackpot: boolean }>}
 */
function getRandomChampions(laneInput, count = 1) {
  if (!cache || !allPool) {
    throw new Error('챔피언 캐시가 아직 로드되지 않았습니다. 봇 재시작 후 다시 시도해주세요.');
  }
  const lane = normalizeLane(laneInput);
  if (!lane) {
    throw new Error(`알 수 없는 라인: ${laneInput}`);
  }
  const lanePool = cache[lane];
  if (!lanePool || lanePool.length === 0) {
    throw new Error(`${lane} 라인 챔피언 데이터가 없습니다.`);
  }

  const n = Math.min(Math.max(1, count), lanePool.length);
  const picks = [];
  const used = new Set();

  for (let i = 0; i < n; i++) {
    // 라인 풀에 꽝 슬롯 1개가 포함되어 있다고 가정 → 꽝 확률 = 1 / (풀 + 1)
    const jackpot = Math.random() < 1 / (lanePool.length + 1);
    const source = jackpot ? allPool : lanePool;
    const remaining = source.filter((name) => !used.has(name));
    if (remaining.length === 0) break;
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    picks.push({ name: pick, jackpot });
    used.add(pick);
  }

  return picks;
}

function getCacheInfo() {
  if (!cache) return { loaded: false };
  return {
    loaded: true,
    loadedAt: cacheLoadedAt,
    source: cacheSource,
    counts: Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v.length])),
  };
}

module.exports = {
  init,
  getRandomChampions,
  getCacheInfo,
  LANE_KO_TO_KEY,
};
