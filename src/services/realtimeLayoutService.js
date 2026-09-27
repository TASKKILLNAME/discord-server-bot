'use strict';

const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { ANALYSIS_CONFIG } = require('../constants/realtimeAnalysis');

const FOOTER = '첩자 %는 실제 고의 패배 확률이 아닌 재미용 위험도 지표입니다.';
const TIERS = { IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P',
  EMERALD: 'E', DIAMOND: 'D', MASTER: 'M', GRANDMASTER: 'GM', CHALLENGER: 'C' };
const DIVISIONS = { I: '1', II: '2', III: '3', IV: '4' };
const ROLE_ICONS = { TOP: '🛡️', JUNGLE: '🌲', MID: '⚔️', ADC: '🏹', SUPPORT: '💠' };
const LEVEL_ICONS = { LOW: '🟢', CAUTION: '🟡', ELEVATED: '🟠', HIGH: '🔴' };
const QUEUES = { 400: '일반', 420: '솔로랭크', 430: '일반', 440: '자유랭크', 490: '빠른 대전' };

function safeText(value, maxLength = 80) {
  return escapeMarkdown(String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/@/g, '@\u200b').slice(0, maxLength));
}

function percent(rate) { return `${Math.round(rate * 100)}%`; }

function rankText(rank) {
  if (rank.status === 'unranked') return 'Unranked';
  if (rank.status === 'error') return '조회 실패';
  if (rank.status !== 'ranked') return '티어 분석 불가';
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier);
  return `${TIERS[rank.tier] || safeText(rank.tier)}${apex ? '' : DIVISIONS[rank.division] || ''} ${rank.lp}LP`;
}

function offRoleText(player) {
  const stats = player.analysis;
  const off = player.spy.offRole;
  if (stats.status !== 'ok') return '라인 ❓ 판단 보류 · 조회 실패';
  if (off.status === 'DEFERRED') {
    const reason = off.reason === 'INSUFFICIENT_ROLE_SAMPLE' ? '포지션 표본 부족'
      : off.reason === 'NO_PRIMARY_ROLE' ? '주 포지션 불명확' : '현재 라인 불확실';
    return `라인 ❓ 판단 보류 · ${reason}`;
  }
  if (off.status === 'NORMAL') return `라인 ✅ 정상 · ${stats.primaryRole} ${percent(stats.primaryRoleRate)}`;
  const label = off.status === 'SUSPECTED' ? '⚠️ 꼬임 의심' : '↔ 비주류 포지션';
  return `라인 ${label} · 주 포지션 ${stats.primaryRole} ${percent(stats.primaryRoleRate)}`;
}

function spyText(player) {
  const { spy, analysis } = player;
  if (spy.score === null) {
    const reason = spy.unavailableReason === 'FETCH_FAILED' ? '조회 실패'
      : ['INSUFFICIENT_SAMPLE', 'INSUFFICIENT_ROLE_SAMPLE'].includes(spy.unavailableReason) ? '표본 부족'
        : '포지션·챔피언 근거 부족';
    return `🕵️ 첩자 분석 보류 · ${reason}`;
  }
  const reasons = {
    OFF_ROLE: '라인 꼬임', SECONDARY_ROLE: '비주류 포지션',
    LOW_CURRENT_CHAMP_EXPERIENCE: '최근 현챔 경험 적음',
    LOSS_STREAK: `${analysis.streakAtLeast ? '최소 ' : ''}${analysis.lossStreak}연패`,
    LOW_RECENT_WINRATE: '최근 승률 낮음', LOW_CURRENT_ROLE_EXPERIENCE: '포지션 경험 적음',
  };
  const labels = spy.reasons.slice(0, 3).map((reason) => reasons[reason]);
  return `${LEVEL_ICONS[spy.level]} 첩자 ${spy.score}%${labels.length ? `\n└ ${labels.join(' · ')}` : ''}`;
}

function buildRealtimeEmbed(scan) {
  const embed = new EmbedBuilder().setTitle(`아군 분석 — ${safeText(scan.targetName, 70)}`)
    .setColor(0x4287f5).setFooter({ text: FOOTER });
  if (scan.status === 'notInGame') return embed.setDescription('현재 게임 중이 아닙니다.');
  const queue = QUEUES[scan.queueId] || `소환사의 협곡 (queue ${scan.queueId})`;
  const description = [
    `${queue} · ${scan.teamId === 100 ? '블루팀' : '레드팀'} · 최근 솔랭 기준`,
    `⚠️ 라인 꼬임 의심 ${scan.offRoleCount}명 · 🕵️ 첩자 고위험 ${scan.highRiskCount}명`,
  ];
  if (scan.timedOut) description.push('일부 조회 시간 초과 · 확인된 정보만 표시');
  if (!scan.allies.length) description.push('표시할 아군 정보가 없습니다.');
  embed.setDescription(description.join('\n'));
  for (const p of scan.allies) {
    const role = p.currentRole.role;
    const guessed = p.currentRole.confidence < ANALYSIS_CONFIG.minRoleConfidence ? '(추정)' : '';
    const name = `${ROLE_ICONS[role]} ${role}${guessed} · ${p.private ? '비공개 참가자' : safeText(p.riotId)}`;
    if (p.private) {
      embed.addFields({ name, value: '티어 분석 불가\n라인 분석 불가\n주챔프 분석 불가\n🕵️ 첩자 분석 불가', inline: false });
      continue;
    }
    const stats = p.analysis;
    const champs = stats.status === 'ok' ? stats.mainChampions.map((c) =>
      `${safeText(c.name, 24)} ${c.games}판 ${percent(c.winRate)}`).join(' · ') || '표본 없음' : '조회 실패';
    const recent = stats.status === 'ok' ? `최근 ${stats.sampleSize}판 ${stats.wins}승 ${stats.losses}패 · ${stats.winRate === null ? '—' : percent(stats.winRate)}`
      : '최근 전적 조회 실패';
    embed.addFields({ name, value: [rankText(p.rank), offRoleText(p), `주챔프 ${champs}`, recent, spyText(p)].join('\n'), inline: false });
  }
  return embed;
}

module.exports = { buildRealtimeEmbed, rankText, safeText, FOOTER };
