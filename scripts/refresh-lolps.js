/**
 * lol.ps 챔피언 라인별 데이터를 받아 data/lolps-champions.json에 저장.
 *
 * lol.ps는 일부 지역(예: 미국 DigitalOcean)에서 차단되므로,
 * 한국에서 로컬로 이 스크립트를 돌려 JSON을 갱신하고 git에 커밋한다.
 *
 * 사용법:
 *   node scripts/refresh-lolps.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENDPOINT = 'https://lol.ps/statistics/__data.json';
const OUTPUT = path.join(__dirname, '..', 'assets', 'lolps-champions.json');

const LANE_ID_TO_KEY = {
  0: 'TOP',
  1: 'JUNGLE',
  2: 'MID',
  3: 'ADC',
  4: 'SUPPORT',
};

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

async function main() {
  console.log('🌐 lol.ps fetch 중...');
  const { data } = await axios.get(ENDPOINT, {
    timeout: 30000,
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

  const out = {
    updatedAt: new Date().toISOString(),
    source: ENDPOINT,
    counts: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])),
    champions: result,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`✅ 저장 완료: ${OUTPUT}`);
  console.log(`   ${Object.entries(out.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

main().catch((e) => {
  console.error('❌ 실패:', e.message);
  process.exit(1);
});
