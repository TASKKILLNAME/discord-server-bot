const axios = require('axios');
const { BoundedTtlCache } = require('../utils/boundedTtlCache');

// ============================================
// 📚 Data Dragon 정적 정보 (챔피언 성향 수치 · 룬 이름/아이콘)
// 버전·언어를 키로 캐시하고, 실패는 캐시하지 않는다.
// ============================================

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const LANGUAGE = 'ko_KR';

let httpGet = async (url) => (await axios.get(url, { timeout: 8000 })).data;
let now = () => Date.now();

const profileCache = new BoundedTtlCache(24 * 60 * 60 * 1000, 400);
const runeCache = new BoundedTtlCache(24 * 60 * 60 * 1000, 10);
const inflight = new Map();

/** info.attack/info.magic 공식 성향 수치(0~10) 차이가 3 이상일 때만 한쪽으로 본다 (실제 피해 비율 아님) */
function damageLeanFrom(info) {
  if (!info || !Number.isFinite(info.attack) || !Number.isFinite(info.magic)) return null;
  if (info.attack - info.magic >= 3) return 'physical';
  if (info.magic - info.attack >= 3) return 'magic';
  return 'mixed';
}

function buildProfile(raw, version, fetchedAt) {
  return {
    id: raw.id,
    name: raw.name,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    damageLean: damageLeanFrom(raw.info),
    source: { type: 'data-dragon', version, language: LANGUAGE, fetchedAt },
  };
}

/**
 * 챔피언 1명의 공식 프로필. 실패하면 null (다른 챔피언·화면 전체에 영향 없음).
 */
async function getChampionProfile(version, dataId) {
  if (!version || !dataId || !/^[A-Za-z0-9]+$/.test(dataId)) return null;
  const key = `${version}:${LANGUAGE}:${dataId}`;
  const cached = profileCache.get(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    try {
      const url = `${DDRAGON}/cdn/${encodeURIComponent(version)}/data/${LANGUAGE}/champion/${dataId}.json`;
      const data = await httpGet(url);
      const raw = data?.data?.[dataId];
      if (!raw) return null;
      const profile = buildProfile(raw, version, new Date(now()).toISOString());
      profileCache.set(key, profile);
      return profile;
    } catch (err) {
      console.error(`챔피언 정적 정보 로드 실패 (${dataId}): ${err.message}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/** 룬 ID → { name, icon(URL) } (Data Dragon runesReforged). 실패하면 빈 Map */
async function getRunes(version) {
  if (!version) return new Map();
  const cached = runeCache.get(version);
  if (cached) return cached;
  try {
    const data = await httpGet(`${DDRAGON}/cdn/${encodeURIComponent(version)}/data/${LANGUAGE}/runesReforged.json`);
    const runes = new Map();
    const add = (item) => {
      if (!item || !Number.isFinite(item.id)) return;
      runes.set(item.id, { name: item.name, icon: item.icon ? `${DDRAGON}/cdn/img/${item.icon}` : null });
    };
    for (const style of Array.isArray(data) ? data : []) {
      add(style);
      for (const slot of style.slots || []) for (const rune of slot.runes || []) add(rune);
    }
    runeCache.set(version, runes);
    return runes;
  } catch (err) {
    console.error(`룬 정적 정보 로드 실패: ${err.message}`);
    return new Map();
  }
}

module.exports = {
  DDRAGON,
  damageLeanFrom,
  buildProfile,
  getChampionProfile,
  getRunes,
  __testing: {
    setHttpGet(fn) {
      httpGet = fn;
    },
    setNow(fn) {
      now = fn;
    },
    reset() {
      httpGet = async (url) => (await axios.get(url, { timeout: 8000 })).data;
      now = () => Date.now();
      profileCache.clear();
      runeCache.clear();
      inflight.clear();
    },
  },
};
