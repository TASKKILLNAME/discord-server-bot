const imageService = require('./imageService');
const { formatPermil, formatPercentPermil, formatKda, formatTenths } = require('./liveBriefingAnalysis');

// ============================================
// 🖼️ /전적 실시간 카드 이미지 (PS 스타일 라인별 맞대결)
// 모든 문자열은 HTML escape, 이미지는 Data Dragon URL만 쓴다.
// ============================================

const CARD_WIDTH = 1100;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function img(src, cls, alt = '') {
  if (!src || !/^https:\/\/ddragon\.leagueoflegends\.com\//.test(src)) return `<span class="${cls} ph"></span>`;
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}">`;
}

function pct(permil) {
  return permil === null || permil === undefined ? '-' : `${formatPermil(permil)}%`;
}

function tierClass(badge) {
  const head = String(badge || '').replace(/\d/g, '');
  return { I: 'iron', B: 'bronze', S: 'silver', G: 'gold', P: 'plat', E: 'emer', D: 'dia', M: 'master', 'M+': 'master', GM: 'gm', C: 'chall', U: 'unranked' }[head] || 'unknown';
}

function spyClass(permil) {
  if (permil === null || permil === undefined) return 'na';
  if (permil >= 400) return 'hot';
  if (permil >= 200) return 'warm';
  return 'cool';
}

function sideHtml(p, mirror) {
  if (!p) return `<div class="side ${mirror ? 'mirror' : ''} empty">참가자 정보 없음</div>`;
  const s = p.stats;
  const name = p.hidden ? '비공개 참가자' : p.bot ? '봇' : p.name || '이름 정보 없음';
  const tierSub = p.rank?.status === 'ranked'
    ? `${esc(p.rank.lp)} LP${p.season ? ` · ${pct(p.season.winPermil)} ${esc(p.season.games)}게임` : ''}`
    : p.rank?.status === 'unranked' ? '랭크 기록 없음'
      : p.rank?.status === 'error' ? '랭크 조회 실패'
        : p.hidden || p.bot ? '-' : '랭크 미조회';

  let champLine1 = '<span class="muted">전적 없음</span>';
  let champLine2 = '';
  if (s && s.collected > 0) {
    const c = s.champion;
    champLine1 = c.games > 0
      ? `<b class="${c.winPermil >= 500 ? 'good' : 'bad'}">${pct(c.winPermil)}</b> ${esc(formatKda(c.kda))} KDA`
      : `<span class="muted">이 챔피언 0게임</span>`;
    champLine2 = `${esc(p.championName)} ${esc(c.games)}게임 <span class="muted">/ 최근 ${esc(s.collected)}</span>`;
  } else if (p.historyStatus === 'error') {
    champLine1 = '<span class="muted">전적 조회 실패</span>';
  } else if (p.historyStatus === 'skipped') {
    champLine1 = '<span class="muted">전적 미수집</span>';
  }

  const wl = p.recent.length
    ? `<div class="wl">${p.recent.filter((g) => g.win).length}W${p.recent.filter((g) => !g.win).length}L</div>`
    : '<div class="wl muted">-</div>';
  const recent = p.recent.map((g) => `<span class="rc ${g.win ? 'w' : 'l'}">${img(g.icon, 'ri')}</span>`).join('');
  const mains = p.mains.length
    ? `<span class="lbl">주챔</span>${p.mains.map((m) => img(m.icon, 'mi', m.name)).join('')}`
    : '';
  const tags = p.tags.map((t) => `<span class="tag ${t.tone}">${esc(t.text)}</span>`).join('');
  const overall = s && s.collected > 0
    ? `최근 ${esc(s.collected)}게임 ${pct(s.winPermil)} · ${esc(formatKda(s.kda))}`
    : '';

  return `
  <div class="side ${mirror ? 'mirror' : ''} ${p.isTarget ? 'target' : ''}">
    <div class="line1">
      <div class="who">
        <div class="nm">${p.isTarget ? '<span class="me">★</span>' : ''}${esc(name)}</div>
        <div class="sub">${tierSub}</div>
        <div class="sub2">${overall}</div>
      </div>
      <span class="badge ${tierClass(p.tierBadge)}">${esc(p.tierBadge)}</span>
      <div class="cs">
        <div>${champLine1}</div>
        <div class="muted small">${champLine2}</div>
      </div>
      <div class="loadout">
        <div class="col">${img(p.spells[0]?.icon, 'si')}${img(p.spells[1]?.icon, 'si')}</div>
        <div class="col">${img(p.keystone?.icon, 'ru')}${img(p.subStyle?.icon, 'ru sub')}</div>
      </div>
      <div class="champ">${img(p.championIcon, 'ci', p.championName)}${wl}</div>
    </div>
    <div class="line2">
      <div class="recent">${recent}</div>
      <div class="mains">${mains}</div>
    </div>
    <div class="line3">${tags}${p.roleText && p.roleText.endsWith('?') ? '<span class="tag muted-tag">포지션 추정 불확실</span>' : ''}</div>
  </div>`;
}

function spyCell(p) {
  const rate = p?.stats?.spy?.ratePermil;
  if (!p || rate === null || rate === undefined) {
    return '<div class="spy na"><div class="num">-</div><div class="cap">표본 부족</div></div>';
  }
  return `<div class="spy ${spyClass(rate)}"><div class="num">${formatPercentPermil(rate)}<small>%</small></div><div class="cap">${esc(p.stats.spy.spies)}/${esc(p.stats.spy.samples)}판</div></div>`;
}

function damageBar(d) {
  const known = d.physical + d.magic + d.mixed;
  if (known === 0) return '<div class="dmg"><div class="bar"></div><div class="dl muted">성향 정보 없음</div></div>';
  const w = (n) => `${Math.round((n * 100) / known)}%`;
  return `<div class="dmg">
    <div class="bar"><span class="ad" style="width:${w(d.physical)}"></span><span class="mx" style="width:${w(d.mixed)}"></span><span class="ap" style="width:${w(d.magic)}"></span></div>
    <div class="dl"><span class="adt">물리 ${d.physical}</span><span class="mxt">혼합 ${d.mixed}</span><span class="apt">마법 ${d.magic}</span></div>
  </div>`;
}

function teamHead(team, view, mirror) {
  const avg = team.avgTier ? `평균티어 <b>${esc(team.avgTier.label)}</b> <span class="muted">(${team.avgTier.counted}/${team.avgTier.total}명)</span>` : '평균티어 <b>-</b>';
  const spy = team.spy.permil === null
    ? '<div class="spybox na"><div class="big">-</div><div class="cap">첩자 표본 부족</div></div>'
    : `<div class="spybox ${spyClass(team.spy.permil)}"><div class="big">${formatPercentPermil(team.spy.permil)}<small>%</small></div><div class="cap">첩자 존재 · 예상 ${formatTenths(team.spy.expectedTenths)}명</div></div>`;
  const bans = team.bans.length ? `${team.bans.map((b) => img(b.icon, 'bi', b.name)).join('')}<span class="lbl">BAN</span>` : '';
  const meta = mirror
    ? ''
    : `<div class="meta"><span class="live">LIVE</span>${view.elapsedMinutes !== null ? `<b class="el">${esc(view.elapsedMinutes)}분 경과</b>` : ''}<b>${esc(view.queueLabel)}</b>${view.mapLabel ? ` <span class="muted">| ${esc(view.mapLabel)}</span>` : ''}</div>`;
  return `
  <div class="thead ${team.teamId === 100 ? 'blue' : 'red'} ${mirror ? 'mirror' : ''}">
    ${meta}
    <div class="trow">
      <div class="bans">${bans}</div>
      <div class="tn">
        <div class="tname">${esc(team.name)}${team.isAlly ? ' <span class="ally">우리 팀</span>' : ''}</div>
        <div class="avg">${avg}</div>
      </div>
      ${spy}
    </div>
    ${damageBar(team.damage)}
  </div>`;
}

function footnote(view) {
  const c = view.completeness;
  const parts = [
    `동일 큐 최근 ${view.settings.lookbackDays}일 · 참가자별 최대 ${view.settings.maxGames}게임 중 ${c.collectedGames}게임 집계${c.pendingGames ? ` (${c.pendingGames}게임 미수집)` : ''}`,
    '포지션은 과거 기록 기반 추정 · 주챔은 숙련도 상위 · 첩자 %는 최근 경기 부진 판정률(재미용, 실제 의도와 무관)',
    `Data Dragon ${view.version || '-'}`,
  ];
  return parts.map(esc).join(' &nbsp;|&nbsp; ');
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b111a;font-family:'Noto Sans CJK KR','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#cfd6e3;width:${CARD_WIDTH}px}
.card{padding:14px;background:#0b111a}
.muted{color:#7d8797}.small{font-size:11px}.good{color:#1fb87a}.bad{color:#e85d5d}
.top{display:flex;gap:10px;margin-bottom:10px}
.thead{flex:1;border-radius:12px;padding:10px 14px;background:linear-gradient(90deg,#16263d,#132033)}
.thead.red{background:linear-gradient(270deg,#3a1a22,#261820)}
.meta{font-size:13px;margin-bottom:4px;display:flex;gap:8px;align-items:center}
.live{background:#e5484d;color:#fff;font-weight:800;font-size:11px;padding:1px 6px;border-radius:3px}
.el{color:#e5484d}
.trow{display:flex;align-items:center;gap:10px}
.thead.mirror .trow{flex-direction:row-reverse}
.thead.mirror{text-align:right}
.bans{flex:1;display:flex;gap:3px;align-items:center}
.thead.mirror .bans{flex-direction:row-reverse}
.bi{width:26px;height:26px;border-radius:50%;filter:grayscale(.6)}
.lbl{font-size:10px;color:#7d8797;margin:0 4px}
.tn .tname{font-size:20px;font-weight:800;color:#4f9cf0}
.thead.red .tname{color:#ef6461}
.ally{font-size:11px;background:#2b3b52;color:#bcd3f5;padding:1px 6px;border-radius:8px;vertical-align:middle}
.thead.red .ally{background:#52303a;color:#f5c6ca}
.avg{font-size:12px;color:#9aa4b4}.avg b{color:#e6ebf3}
.spybox{min-width:96px;text-align:center;border-radius:8px;padding:4px 8px;background:#1f2a3b}
.spybox .big{font-size:30px;font-weight:800;line-height:1}
.spybox .big small{font-size:15px}
.spybox .cap{font-size:10px;color:#aab3c2;margin-top:2px}
.spybox.hot{background:#5a1f26}.spybox.hot .big{color:#ff7b7b}
.spybox.warm{background:#4a3a1b}.spybox.warm .big{color:#ffc15e}
.spybox.cool{background:#173a33}.spybox.cool .big{color:#5fe0b0}
.spybox.na .big{color:#7d8797}
.dmg{margin-top:8px}
.bar{height:5px;border-radius:3px;background:#2a3444;display:flex;overflow:hidden}
.bar .ad{background:#e0913a}.bar .mx{background:#9aa4b4}.bar .ap{background:#8a63e6}
.dl{display:flex;justify-content:space-between;font-size:11px;margin-top:3px}
.adt{color:#e0913a}.mxt{color:#9aa4b4}.apt{color:#a58af0}
.colhead{display:grid;grid-template-columns:52px 1fr 128px 1fr;font-size:11px;color:#7d8797;text-align:center;margin:0 0 4px}
.row{display:grid;grid-template-columns:52px 1fr 128px 1fr;background:#141c28;border-radius:10px;margin-bottom:6px;min-height:112px;align-items:stretch}
.role{display:flex;align-items:center;justify-content:center;font-weight:700;color:#8f9bb0;font-size:13px;border-right:1px solid #1f2937;writing-mode:horizontal-tb}
.side{padding:8px 10px;display:flex;flex-direction:column;gap:5px;min-width:0}
.side.target{background:linear-gradient(90deg,rgba(79,156,240,.12),transparent);border-radius:10px}
.side.mirror.target{background:linear-gradient(270deg,rgba(239,100,97,.12),transparent)}
.side.empty{justify-content:center;align-items:center;color:#7d8797;font-size:12px}
.line1{display:flex;align-items:center;gap:8px}
.side.mirror .line1,.side.mirror .line2,.side.mirror .line3{flex-direction:row-reverse}
.who{flex:1;min-width:0}
.side.mirror .who{text-align:right}
.nm{font-size:14px;font-weight:700;color:#eef2f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.me{color:#ffcc4d;margin-right:3px}
.sub,.sub2{font-size:11px;color:#98a2b3;white-space:nowrap}
.badge{font-size:11px;font-weight:800;padding:3px 6px;border-radius:5px;min-width:30px;text-align:center;color:#fff;background:#4b5563}
.badge.iron{background:#5c5552}.badge.bronze{background:#8c5a3c}.badge.silver{background:#7d8a96}.badge.gold{background:#b8912f}
.badge.plat{background:#2e9e8f}.badge.emer{background:#1f9d57}.badge.dia{background:#3d6fd6}.badge.master{background:#9b46c9}
.badge.gm{background:#c93f3f}.badge.chall{background:#d9a520;color:#1b1b1b}.badge.unranked{background:#3b4452;color:#b7c0cc}
.cs{text-align:right;font-size:12px;min-width:108px}
.side.mirror .cs{text-align:left}
.loadout{display:flex;gap:2px}
.col{display:flex;flex-direction:column;gap:2px}
.si,.ru{width:20px;height:20px;border-radius:4px;background:#0f1520}
.ru{border-radius:50%}.ru.sub{width:16px;height:16px;margin:2px}
.ph{display:inline-block;background:#222b38}
.champ{display:flex;flex-direction:column;align-items:center;gap:1px}
.ci{width:46px;height:46px;border-radius:8px}
.wl{font-size:11px;font-weight:700;color:#1fb87a}
.line2{display:flex;align-items:center;justify-content:space-between;gap:6px}
.recent{display:flex;gap:2px}
.rc{display:flex;flex-direction:column}
.rc::after{content:'';height:2px;margin-top:1px;border-radius:1px}
.rc.w::after{background:#1fb87a}.rc.l::after{background:#e85d5d}
.ri{width:20px;height:20px;border-radius:3px}
.mains{display:flex;align-items:center;gap:2px}
.mi{width:20px;height:20px;border-radius:50%;border:1px solid #334155}
.line3{display:flex;gap:4px;flex-wrap:wrap;min-height:4px}
.tag{font-size:11px;font-weight:700;padding:1px 7px;border-radius:9px}
.tag.bad{background:#4a1c22;color:#ff8c8c}.tag.good{background:#153a2a;color:#63e3a5}
.tag.muted-tag{background:#262f3d;color:#98a2b3;font-weight:500}
.mid{display:flex;align-items:center;justify-content:space-around;border-left:1px solid #1f2937;border-right:1px solid #1f2937;background:#101722}
.spy{text-align:center}
.spy .num{font-size:24px;font-weight:800;line-height:1}
.spy .num small{font-size:12px}
.spy .cap{font-size:10px;color:#7d8797;margin-top:3px}
.spy.hot .num{color:#ff7b7b}.spy.warm .num{color:#ffc15e}.spy.cool .num{color:#5fe0b0}.spy.na .num{color:#5b6576}
.foot{font-size:10.5px;color:#6b7585;margin-top:6px;text-align:center}
`;

/** 카드 HTML (순수 함수) */
function buildLiveGameCardHtml(view) {
  const [left, right] = view.teams;
  const rows = view.rows
    .map((row) => `
    <div class="row">
      <div class="role">${esc(row.roleLabel || '-')}</div>
      ${sideHtml(row.left, false)}
      <div class="mid">${spyCell(row.left)}${spyCell(row.right)}</div>
      ${sideHtml(row.right, true)}
    </div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="card">
  <div class="top">${teamHead(left, view, false)}${right ? teamHead(right, view, true) : ''}</div>
  <div class="colhead"><span>포지션</span><span>${esc(left.name)}</span><span>첩자일 확률</span><span>${esc(right?.name || '')}</span></div>
  ${rows}
  <div class="foot">${footnote(view)}</div>
  </div></body></html>`;
}

/** 카드 PNG Buffer. 실패하면 예외 (호출자가 텍스트 화면으로 대체) */
async function renderLiveGameCard(view, { timeoutMs = 12000 } = {}) {
  return imageService.renderHtmlToPng(buildLiveGameCardHtml(view), { width: CARD_WIDTH, timeoutMs });
}

module.exports = { CARD_WIDTH, buildLiveGameCardHtml, renderLiveGameCard, esc };
