const {
  AttachmentBuilder,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  escapeMarkdown,
} = require('discord.js');
const { formatPermil, formatPercentPermil, formatKda, formatTenths } = require('./liveBriefingAnalysis');

// ============================================
// 💬 /전적 실시간 Discord 메시지 (Components V2)
// 기존 블루/레드 팀 컨테이너 구조 + 카드 이미지 + 플레이어별 요약
// ============================================

const NO_MENTIONS = Object.freeze({ parse: [] });
const CARD_FILE_NAME = 'live-game.png';
const TEXT_LIMIT = 3900; // Components V2 메시지 전체 텍스트 4000자 제한 (여유 100)
const COLORS = { header: 0x1a78ae, blue: 0x4287f5, red: 0xed4245, loading: 0xffa500, error: 0xff0000 };

/** 사용자 입력·외부 문자열: 제어문자 제거, Markdown 이스케이프, 멘션 무력화, 길이 제한 */
function safeText(value, max = 60) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  return escapeMarkdown(clipped).replace(/@/g, '@​');
}

function pct(permil) {
  return permil === null || permil === undefined ? '-' : `${formatPermil(permil)}%`;
}

function rankLine(p) {
  switch (p.rank?.status) {
    case 'ranked':
      return `${p.tierName} ${p.rank.lp}LP${p.season ? ` · 시즌 ${pct(p.season.winPermil)} (${p.season.games}판)` : ''}`;
    case 'unranked':
      return '랭크 기록 없음';
    case 'error':
      return '랭크 조회 실패';
    case 'hidden':
      return '비공개 참가자';
    case 'bot':
      return '봇';
    default:
      return '랭크 미조회(시간 제한)';
  }
}

function recordLine(p, settings) {
  const s = p.stats;
  if (p.historyStatus === 'hidden' || p.historyStatus === 'bot') return null;
  if (p.historyStatus === 'unsupported') return '이 모드는 전적 비교 대상 아님';
  if (p.historyStatus === 'error') return '최근 전적 조회 실패';
  if (!s) return '최근 전적 미수집(시간 제한)';
  if (s.collected === 0) {
    return s.idsFound === 0 ? `최근 ${settings.lookbackDays}일 같은 큐 경기 없음` : '분석 가능한 경기 없음';
  }
  const champ = s.champion.games > 0
    ? `${safeText(p.championName, 20)} ${s.champion.games}판 ${pct(s.champion.winPermil)}`
    : `${safeText(p.championName, 20)} 0판`;
  const small = s.smallSample ? ' · 표본 적음' : '';
  return `최근 ${s.collected}판 ${s.wins}승 ${s.losses}패 (${pct(s.winPermil)}) · KDA ${formatKda(s.kda)} · ${champ}${small}`;
}

function extraLine(p) {
  const parts = [];
  if (p.mains.length) parts.push(`주챔 ${p.mains.map((m) => safeText(m.name, 12)).join('·')}`);
  const spy = p.stats?.spy;
  if (spy?.ratePermil !== null && spy?.ratePermil !== undefined) {
    parts.push(`🕵️ 첩자 ${formatPercentPermil(spy.ratePermil)}% (${spy.spies}/${spy.samples}판)`);
  } else if (p.stats) {
    parts.push('🕵️ 첩자 표본 부족');
  }
  return parts.length ? parts.join(' · ') : null;
}

function playerBlock(p, settings, { compact = false } = {}) {
  const name = p.hidden ? '비공개 참가자' : p.bot ? '봇' : p.name ? safeText(p.name, 32) : '이름 정보 없음';
  const role = p.roleText ? `${p.roleText} · ` : '';
  const lines = [`**${role}${safeText(p.championName, 20)}** \`${p.tierBadge}\` ${name}${p.isTarget ? ' ⭐' : ''}`];
  lines.push(`┗ ${rankLine(p)}`);
  const record = recordLine(p, settings);
  if (record) lines.push(`┗ ${record}`);
  if (!compact) {
    const extra = extraLine(p);
    if (extra) lines.push(`┗ ${extra}`);
  }
  if (p.tags.length) lines.push(`┗ ${p.tags.map((t) => `\`${t.text}\``).join(' ')}`);
  return lines.join('\n');
}

function teamHeader(team) {
  const icon = team.teamId === 100 ? '🔵' : '🔴';
  const parts = [];
  parts.push(team.avgTier ? `평균 ${team.avgTier.label} (${team.avgTier.counted}/${team.avgTier.total}명)` : '평균 티어 -');
  if (team.spy.permil !== null) {
    parts.push(`🕵️ 첩자 존재 ${formatPercentPermil(team.spy.permil)}% (예상 ${formatTenths(team.spy.expectedTenths)}명)`);
  } else {
    parts.push('🕵️ 첩자 표본 부족');
  }
  if (team.bans.length) parts.push(`밴 ${team.bans.map((b) => safeText(b.name, 12)).join(', ')}`);
  return `## ${icon} ${team.name}${team.isAlly ? ' · 우리 팀' : ''}\n${parts.join(' · ')}`;
}

function teamPlayers(view, teamId) {
  // 라인 순서(행 순서)대로
  const side = view.teams[0].teamId === teamId ? 'left' : 'right';
  return view.rows.map((r) => r[side]).filter(Boolean);
}

function headerText(view) {
  const parts = ['🔴 LIVE'];
  if (view.elapsedMinutes !== null) parts.push(`${view.elapsedMinutes}분 경과`);
  parts.push(view.queueLabel);
  if (view.mapLabel) parts.push(view.mapLabel);
  const lines = [`## 🎮 ${safeText(`${view.account.gameName}#${view.account.tagLine}`, 60)} 실시간 게임`, parts.join(' · ')];
  if (view.mode !== 'personal') lines.push('⚠️ 조회한 계정을 참가자와 연결하지 못해 팀 기준(우리 팀) 표시는 생략했습니다.');
  return lines.join('\n');
}

function footerText(view) {
  const c = view.completeness;
  const collected = `경기 ${c.collectedGames}건 집계${c.pendingGames ? ` · ${c.pendingGames}건 미수집` : ''}${c.failedGames ? ` · ${c.failedGames}건 실패` : ''}`;
  return [
    `-# 포지션: 과거 기록 기반 추정(?는 불확실) · 주챔: 숙련도 상위 · 🕵️ 첩자: 최근 경기에서 부진 기준을 넘은 비율(재미용 통계, 실제 매칭 의도와 무관)`,
    `-# 동일 큐 최근 ${view.settings.lookbackDays}일 · 참가자별 최대 ${view.settings.maxGames}판 · ${collected} · 현재 킬·골드·아이템 미반영`,
  ].join('\n');
}

function textLength(texts) {
  return texts.reduce((s, t) => s + t.length, 0);
}

/**
 * 메시지 payload. image(Buffer)가 있으면 카드 이미지를 붙인다.
 */
function renderLiveGameMessage(view, { image = null } = {}) {
  const header = headerText(view);
  const footer = footerText(view);
  const teamTexts = (compact) => view.teams.map((team) => ({
    team,
    header: teamHeader(team),
    body: teamPlayers(view, team.teamId).map((p) => playerBlock(p, view.settings, { compact })).join('\n\n'),
  }));

  let teams = teamTexts(false);
  const all = () => [header, footer, ...teams.flatMap((t) => [t.header, t.body])];
  if (textLength(all()) > TEXT_LIMIT) teams = teamTexts(true);
  if (textLength(all()) > TEXT_LIMIT) {
    // 그래도 넘으면 팀 본문을 균등하게 자른다
    const room = Math.floor((TEXT_LIMIT - header.length - footer.length - teams.reduce((s, t) => s + t.header.length, 0)) / teams.length);
    teams = teams.map((t) => ({ ...t, body: t.body.length > room ? `${t.body.slice(0, room - 1)}…` : t.body }));
  }

  const components = [];
  const headerContainer = new ContainerBuilder().setAccentColor(COLORS.header)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
  const files = [];
  if (image) {
    files.push(new AttachmentBuilder(image, { name: CARD_FILE_NAME }));
    headerContainer.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${CARD_FILE_NAME}`).setDescription('실시간 게임 라인별 비교'))
    );
  }
  components.push(headerContainer);

  for (const t of teams) {
    components.push(
      new ContainerBuilder()
        .setAccentColor(t.team.teamId === 100 ? COLORS.blue : COLORS.red)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(t.header))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(t.body || '참가자 정보 없음'))
    );
  }
  components.push(new TextDisplayBuilder().setContent(footer));

  return {
    content: '',
    embeds: [],
    components,
    files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_MENTIONS,
  };
}

/** 전적 수집 전 기본 정보 */
function renderLoading(view) {
  const lines = [];
  if (view.target) lines.push(`**${safeText(view.target.championName, 20)}** · 우리 팀 ${view.teams.find((t) => t.isAlly)?.name || '-'} · ${view.queueLabel}`);
  else lines.push(`${view.queueLabel} · 조회 대상을 참가자와 연결하지 못해 팀 기준 없이 진행합니다.`);
  lines.push('참가자 랭크·주 챔피언·최근 전적을 모으는 중입니다. 최대 약 45초 후 모은 만큼 표시합니다.');
  return {
    content: '',
    embeds: [
      new EmbedBuilder()
        .setTitle(`🔍 실시간 게임 분석 중 — ${safeText(`${view.account.gameName}#${view.account.tagLine}`, 60)}`)
        .setDescription(lines.join('\n'))
        .setColor(COLORS.loading),
    ],
    components: [],
    allowedMentions: NO_MENTIONS,
  };
}

function renderError(message) {
  return {
    content: '',
    embeds: [new EmbedBuilder().setTitle('❌ 실시간 게임 조회 실패').setDescription(safeText(message, 500)).setColor(COLORS.error)],
    components: [],
    allowedMentions: NO_MENTIONS,
  };
}

/** 메시지 안 모든 TextDisplay 글자 수 (테스트·검증용) */
function totalTextLength(payload) {
  const walk = (c) => {
    const d = c.toJSON ? c.toJSON() : c;
    let n = typeof d.content === 'string' ? d.content.length : 0;
    for (const child of d.components || []) n += walk(child);
    return n;
  };
  return payload.components.reduce((s, c) => s + walk(c), 0);
}

module.exports = {
  CARD_FILE_NAME,
  TEXT_LIMIT,
  NO_MENTIONS,
  safeText,
  playerBlock,
  renderLiveGameMessage,
  renderLoading,
  renderError,
  totalTextLength,
};
