const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { BoundedTtlCache } = require('../utils/boundedTtlCache');

// ============================================
// 📚 챔피언 자료 — 세 계층을 섞지 않는다
//   A. 공식 정적 정보 (Data Dragon): 스킬 설명, allytips/enemytips, info 성향 수치
//   B. 관리 자료 (assets/lol-briefing/*.json): reviewStatus가 'verified'인 항목만 사용
//   C. 자료 없음: 호출자가 '검증된 상대법 자료 없음'으로 표시
// ============================================

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const LANGUAGE = 'ko_KR';
const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'assets', 'lol-briefing');

// 스킬 설명(ko_KR)에 이 표현이 있으면 '하드 CC 보유'로 본다. 설명 키워드 기반 휴리스틱이며
// 근거로 스킬 이름을 함께 표시한다. (둔화·침묵 등은 하드 CC로 세지 않는다)
// 자기 자신이 밀려나는 설명("뒤로 밀려납니다")을 잡지 않도록 밀어내기·띄우기는 능동형만 쓴다.
const HARD_CC_KEYWORDS = Object.freeze([
  '기절', '속박', '공중으로 띄', '공중에 띄', '띄워올', '띄워 올', '에어본', '도발', '제압',
  '매혹', '홀립', '홀린', '공포', '변이', '수면', '잠에 빠', '잠들', '끌어당', '밀쳐', '밀어냅', '뒤로 밀어',
]);
// 대상이 챔피언이 아니거나 CC가 아닌 문장
const HARD_CC_EXCLUDED_SENTENCE = /미니언|챔피언이 아닌/;
const HARD_CC_FALSE_PHRASES = Object.freeze(['공포 감지']);

// 미치환 변수 ({{ e1 }}, @Effect1Amount@, {0} 등)가 남은 문장은 노출하지 않는다
const UNRESOLVED_PATTERN = /\{\{|\}\}|@[A-Za-z][A-Za-z0-9]*@|\{\d+\}|\$\{/;

const TRAIT_KEYS = Object.freeze(['engage', 'protect', 'frontline', 'poke']);
const MATCHUP_ROLES = Object.freeze(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM_DUO']);

let httpGet = async (url) => (await axios.get(url, { timeout: 8000 })).data;
let now = () => Date.now();

const profileCache = new BoundedTtlCache(24 * 60 * 60 * 1000, 400);
const inflight = new Map();

// ============================================
// A. Data Dragon
// ============================================
function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 표시 가능한 공식 문장만 남긴다. 미치환 변수가 있거나 비었으면 null */
function cleanOfficialText(text, maxLength = 220) {
  const cleaned = stripHtml(text);
  if (!cleaned || UNRESOLVED_PATTERN.test(cleaned)) return null;
  return cleaned.length > maxLength ? null : cleaned;
}

function detectHardCc(spells, passive = null) {
  const slots = ['Q', 'W', 'E', 'R'];
  const candidates = (spells || []).slice(0, 4).map((spell, i) => ({ slot: slots[i], spell }));
  if (passive) candidates.push({ slot: '패시브', spell: passive });
  const found = [];
  for (const { slot, spell } of candidates) {
    const description = stripHtml(spell?.description);
    if (!description || UNRESOLVED_PATTERN.test(description)) continue;
    let keyword = null;
    for (const sentence of description.split(/(?<=[.!?])\s+/)) {
      if (HARD_CC_EXCLUDED_SENTENCE.test(sentence)) continue;
      const text = HARD_CC_FALSE_PHRASES.reduce((s, phrase) => s.split(phrase).join(' '), sentence);
      keyword = HARD_CC_KEYWORDS.find((kw) => text.includes(kw)) || null;
      if (keyword) break;
    }
    if (keyword) found.push({ slot, name: stripHtml(spell.name), keyword });
  }
  return found;
}

/** info.attack/info.magic 공식 성향 수치(0~10) 차이가 3 이상일 때만 한쪽으로 본다 */
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
    allytips: (raw.allytips || []).map((t) => cleanOfficialText(t)).filter(Boolean),
    enemytips: (raw.enemytips || []).map((t) => cleanOfficialText(t)).filter(Boolean),
    hardCc: detectHardCc(raw.spells, raw.passive),
    damageLean: damageLeanFrom(raw.info),
    source: { type: 'data-dragon', version, language: LANGUAGE, fetchedAt },
  };
}

/**
 * 챔피언 1명의 공식 프로필. 실패하면 null (다른 챔피언·브리핑 전체에 영향 없음).
 * 실패 결과는 캐시하지 않는다.
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

const runeCache = new BoundedTtlCache(24 * 60 * 60 * 1000, 10);

/** 룬 ID → 이름 (Data Dragon runesReforged). 실패하면 빈 Map */
async function getRuneNames(version) {
  if (!version) return new Map();
  const cached = runeCache.get(version);
  if (cached) return cached;
  try {
    const data = await httpGet(`${DDRAGON}/cdn/${encodeURIComponent(version)}/data/${LANGUAGE}/runesReforged.json`);
    const names = new Map();
    for (const style of Array.isArray(data) ? data : []) {
      names.set(style.id, style.name);
      for (const slot of style.slots || []) {
        for (const rune of slot.runes || []) names.set(rune.id, rune.name);
      }
    }
    runeCache.set(version, names);
    return names;
  } catch (err) {
    console.error(`룬 정적 정보 로드 실패: ${err.message}`);
    return new Map();
  }
}

// ============================================
// B. 관리 자료 (검수 상태 분리)
// ============================================
function hasDigits(text) {
  return /\d/.test(text);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSource(source) {
  return source && isNonEmptyString(source.type) && isNonEmptyString(source.ref);
}

/** 검수 완료 항목의 필수 조건. 통과 못 하면 사유 문자열 */
function verifiedProblems(entry, texts) {
  const problems = [];
  if (!validateSource(entry.source)) problems.push('출처 없음');
  if (!isNonEmptyString(entry.checkedAt)) problems.push('확인일 없음');
  if (!isNonEmptyString(entry.reviewedBy)) problems.push('검수자 없음');
  if (texts.some(hasDigits) && !validateSource(entry.numericClaimsSource)) {
    problems.push('수치 포함 문장의 별도 근거 없음');
  }
  return problems;
}

function loadJson(file) {
  const full = path.join(KNOWLEDGE_DIR, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function parseMatchups(json) {
  const verified = [];
  const stats = { verified: 0, draft: 0, rejected: [] };
  for (const entry of json?.entries || []) {
    const id = entry?.id || '(id 없음)';
    const texts = [...(entry?.cautions || []), ...(entry?.options || [])];
    if (
      !isNonEmptyString(entry?.id) ||
      !isNonEmptyString(entry?.myChampion) ||
      !isNonEmptyString(entry?.opponentChampion) ||
      !MATCHUP_ROLES.includes(entry?.role) ||
      !Array.isArray(entry?.cautions) ||
      !Array.isArray(entry?.options) ||
      !texts.every(isNonEmptyString)
    ) {
      stats.rejected.push(`${id}: 형식 오류`);
      continue;
    }
    if (entry.reviewStatus !== 'verified') {
      stats.draft++;
      continue;
    }
    const problems = verifiedProblems(entry, texts);
    if (problems.length > 0) {
      stats.rejected.push(`${id}: ${problems.join(', ')}`);
      continue;
    }
    stats.verified++;
    verified.push({
      id: entry.id,
      myChampion: entry.myChampion,
      opponentChampion: entry.opponentChampion,
      role: entry.role,
      queues: Array.isArray(entry.queues) ? entry.queues : null,
      lastVerifiedPatch: isNonEmptyString(entry.lastVerifiedPatch) ? entry.lastVerifiedPatch : null,
      cautions: entry.cautions.slice(0, 3),
      options: entry.options.slice(0, 2),
      source: entry.source,
      checkedAt: entry.checkedAt,
    });
  }
  return { verified, stats };
}

function parseTraits(json) {
  const verified = {};
  const stats = { verified: 0, draft: 0, rejected: [] };
  for (const [champion, traits] of Object.entries(json?.traits || {})) {
    for (const [key, trait] of Object.entries(traits || {})) {
      const id = `${champion}.${key}`;
      if (!TRAIT_KEYS.includes(key) || typeof trait?.value !== 'boolean' || !isNonEmptyString(trait?.evidence)) {
        stats.rejected.push(`${id}: 형식 오류`);
        continue;
      }
      if (trait.reviewStatus !== 'verified') {
        stats.draft++;
        continue;
      }
      const problems = verifiedProblems(trait, [trait.evidence]);
      if (problems.length > 0) {
        stats.rejected.push(`${id}: ${problems.join(', ')}`);
        continue;
      }
      stats.verified++;
      verified[champion] = verified[champion] || {};
      verified[champion][key] = { value: trait.value, evidence: trait.evidence, source: trait.source, checkedAt: trait.checkedAt };
    }
  }
  return { verified, stats };
}

let curated = null;

function loadCuratedKnowledge({ force = false } = {}) {
  if (curated && !force) return curated;
  try {
    const matchups = parseMatchups(loadJson('matchups.json'));
    const traits = parseTraits(loadJson('champion-traits.json'));
    curated = { matchups: matchups.verified, traits: traits.verified, stats: { matchups: matchups.stats, traits: traits.stats } };
    const rejected = [...matchups.stats.rejected, ...traits.stats.rejected];
    if (rejected.length > 0) console.warn(`상대법·특성 자료 ${rejected.length}건 제외: ${rejected.slice(0, 5).join(' / ')}`);
  } catch (err) {
    console.error(`상대법·특성 자료 로드 실패: ${err.message}`);
    curated = {
      matchups: [],
      traits: {},
      stats: { matchups: { verified: 0, draft: 0, rejected: ['파일 읽기 실패'] }, traits: { verified: 0, draft: 0, rejected: ['파일 읽기 실패'] } },
    };
  }
  return curated;
}

/**
 * 검수된 상대법 중 이번 입력에 해당하는 것.
 * 챔피언 전용 항목을 먼저, 범용('*') 항목은 전용 항목이 없을 때만 쓴다.
 */
function findMatchups(data, { laneType, role, allyIds, opponentIds, queueId }) {
  const wantRole = laneType === 'bottom' ? 'BOTTOM_DUO' : role;
  const applicable = data.matchups.filter(
    (m) => m.role === wantRole && (!m.queues || m.queues.includes(queueId)) && allyIds.includes(m.myChampion)
  );
  const specific = applicable.filter((m) => opponentIds.includes(m.opponentChampion));
  if (specific.length > 0) return specific;
  return opponentIds.length > 0 ? applicable.filter((m) => m.opponentChampion === '*') : [];
}

/**
 * 브리핑 1회에 쓸 자료 묶음. profiles: Map(championId → 프로필|null)
 */
function createKnowledge(profiles, version) {
  const data = loadCuratedKnowledge();
  return {
    version,
    profileFor: (championId) => profiles.get(championId) || null,
    verifiedTraitsFor: (dataId) => data.traits[dataId] || {},
    findMatchups: (query) => findMatchups(data, query),
    curatedStats: data.stats,
  };
}

module.exports = {
  HARD_CC_KEYWORDS,
  stripHtml,
  cleanOfficialText,
  detectHardCc,
  damageLeanFrom,
  buildProfile,
  getChampionProfile,
  getRuneNames,
  parseMatchups,
  parseTraits,
  loadCuratedKnowledge,
  findMatchups,
  createKnowledge,
  __testing: {
    setHttpGet(fn) {
      httpGet = fn;
    },
    setNow(fn) {
      now = fn;
    },
    setCurated(value) {
      curated = value;
    },
    reset() {
      httpGet = async (url) => (await axios.get(url, { timeout: 8000 })).data;
      now = () => Date.now();
      profileCache.clear();
      runeCache.clear();
      inflight.clear();
      curated = null;
    },
  },
};
