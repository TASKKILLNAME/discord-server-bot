const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  escapeMarkdown,
} = require('discord.js');
const {
  ROLES,
  ROLE_LABELS,
  ROLE_LEVEL_LABELS,
  BRIEFING_CONFIG,
  queueName,
  summarizeTeamComposition,
  formatPermil,
  formatTenths,
  formatKda,
  formatStreak,
} = require('./liveBriefingAnalysis');
const { buildBriefing } = require('./liveBriefingService');
const { viewCustomId, roleCustomId } = require('./liveBriefingSessions');

// ============================================
// 🖼️ /전적 실시간 브리핑 화면 (Embed + 버튼·선택 메뉴)
// ============================================

// Discord Embed 제한 (공식 문서 기준)
const EMBED_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  total: 6000,
});

const NO_MENTIONS = Object.freeze({ parse: [] });
const COLORS = { home: 0x1a78ae, loading: 0xffa500, error: 0xff0000, blue: 0x4287f5, red: 0xed4245 };

const TIER_KO = {
  IRON: '아이언', BRONZE: '브론즈', SILVER: '실버', GOLD: '골드', PLATINUM: '플래티넘',
  EMERALD: '에메랄드', DIAMOND: '다이아몬드', MASTER: '마스터', GRANDMASTER: '그랜드마스터', CHALLENGER: '챌린저',
};
const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const REASON_KO = {
  auth: '권한 오류', rateLimited: '요청 한도', upstream: 'Riot 서버 오류', timeout: '시간 초과',
  network: '연결 실패', notFound: '데이터 없음', invalid: '형식 오류', unknown: '알 수 없는 오류',
};
const QUEUE_TYPE_KO = { RANKED_SOLO_5x5: '솔로랭크', RANKED_FLEX_SR: '자유랭크' };

// ============================================
// 🧼 안전한 문자열
// ============================================

/** 사용자 입력·외부 문자열: 제어문자 제거, Markdown 이스케이프, 멘션 무력화, 길이 제한 */
function safeText(value, max = 200) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  return escapeMarkdown(clipped).replace(/@/g, '@​');
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Embed 데이터를 Discord 제한 안으로 맞춘다. 전체 합이 6000자를 넘으면 뒤쪽 필드부터 줄인다.
 */
function fitEmbedData(data) {
  const out = {
    ...data,
    title: data.title ? truncate(data.title, EMBED_LIMITS.title) : undefined,
    description: data.description ? truncate(data.description, EMBED_LIMITS.description) : undefined,
    footer: data.footer ? { text: truncate(data.footer.text, EMBED_LIMITS.footer) } : undefined,
    fields: (data.fields || [])
      .slice(0, EMBED_LIMITS.fields)
      .map((f) => ({
        name: truncate(f.name || '​', EMBED_LIMITS.fieldName),
        value: truncate(f.value || '-', EMBED_LIMITS.fieldValue),
        inline: Boolean(f.inline),
      })),
  };
  const total = () =>
    (out.title || '').length +
    (out.description || '').length +
    (out.footer?.text || '').length +
    out.fields.reduce((s, f) => s + f.name.length + f.value.length, 0);
  while (total() > EMBED_LIMITS.total && out.fields.length > 0) {
    const last = out.fields[out.fields.length - 1];
    const over = total() - EMBED_LIMITS.total;
    if (last.value.length - over >= 20) last.value = truncate(last.value, last.value.length - over);
    else out.fields.pop();
  }
  if (total() > EMBED_LIMITS.total && out.description) {
    out.description = truncate(out.description, Math.max(1, out.description.length - (total() - EMBED_LIMITS.total)));
  }
  return out;
}

function embedLength(embed) {
  const d = embed.data || embed;
  return (d.title || '').length + (d.description || '').length + (d.footer?.text || '').length +
    (d.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);
}

function toEmbed(data) {
  const fitted = fitEmbedData(data);
  const embed = new EmbedBuilder().setColor(fitted.color ?? COLORS.home);
  if (fitted.title) embed.setTitle(fitted.title);
  if (fitted.description) embed.setDescription(fitted.description);
  if (fitted.fields.length > 0) embed.addFields(fitted.fields);
  if (fitted.footer) embed.setFooter(fitted.footer);
  if (fitted.timestamp) embed.setTimestamp(new Date(fitted.timestamp));
  return embed;
}

// ============================================
// 🔤 포맷
// ============================================
function accountLabel(account) {
  return safeText(`${account.gameName}#${account.tagLine}`, 60);
}

function playerName(p) {
  if (p.hidden) return '비공개 참가자';
  if (p.bot) return '봇';
  return p.displayName ? safeText(p.displayName, 40) : '이름 정보 없음';
}

function formatRank(rank) {
  switch (rank?.status) {
    case 'ranked': {
      const tier = TIER_KO[rank.tier] || safeText(rank.tier, 20);
      const division = APEX_TIERS.has(rank.tier) ? '' : ` ${safeText(rank.division, 4)}`;
      return `${tier}${division} ${rank.lp}LP`;
    }
    case 'unranked':
      return `${QUEUE_TYPE_KO[rank.queueType] || '랭크'} 기록 없음`;
    case 'error':
      return `랭크 조회 실패(${REASON_KO[rank.reason] || '오류'})`;
    case 'hidden':
      return '비공개 참가자';
    case 'bot':
      return '봇';
    default:
      return '랭크 미조회(시간 제한)';
  }
}

function formatRoleOf(perspective, p) {
  const r = perspective.roles?.get(p.slot);
  if (!r || r.level === 'unsupported') return '포지션 분석 안 함';
  if (!r.role) return '포지션 불확실';
  return `${ROLE_LABELS[r.role]}(${ROLE_LEVEL_LABELS[r.level]})`;
}

/** 전적 한 줄. '최근 20전' 같은 표현 대신 실제 수집한 경기 수를 쓴다 */
function formatRecord(p, settings) {
  const h = p.history || {};
  if (h.status === 'hidden') return '비공개 참가자 — 챔피언 정보만 사용';
  if (h.status === 'bot') return '봇 — 전적 없음';
  if (h.status === 'unsupported') return '이 모드는 동일 큐 전적 비교 대상이 아님';
  if (h.status === 'error') return `전적 조회 실패(${REASON_KO[h.reason] || '오류'})`;
  if (h.status !== 'ok' || !p.stats) return '전적 미조회(시간 제한)';

  const s = p.stats;
  const gaps = [];
  if (s.pending) gaps.push(`미수집 ${s.pending}`);
  if (s.failed) gaps.push(`실패 ${s.failed}`);
  if (s.excludedTotal) gaps.push(`제외 ${s.excludedTotal}`);
  const gapText = gaps.length ? ` (${gaps.join(' · ')})` : '';

  if (s.collected === 0) {
    if (s.idsFound === 0) return `동일 큐 최근 ${settings.lookbackDays}일 완료 경기 없음`;
    return `분석 가능한 경기 없음${gapText}`;
  }
  const avg = s.avg;
  return [
    `최근 수집 ${s.collected}경기 ${s.wins}승 ${s.losses}패 (관측 승률 ${formatPermil(s.winPermil)}%)${gapText}`,
    `평균 ${formatTenths(avg.killsTenths)}/${formatTenths(avg.deathsTenths)}/${formatTenths(avg.assistsTenths)} · 합산 KDA ${formatKda(s.kda)}${s.smallSample ? ' · 표본 적음' : ''}`,
  ].join('\n');
}

function formatChampionSample(p) {
  const s = p.stats;
  if (!s || s.collected === 0) return null;
  const champ = safeText(p.championName, 30);
  const c = s.champion;
  if (c.games === 0) return `최근 수집 ${s.collected}경기 중 ${champ} 경기 없음`;
  const small = c.games < BRIEFING_CONFIG.smallSampleThreshold ? ' · 표본 적음' : '';
  return `최근 수집 ${s.collected}경기 중 ${champ} ${c.games}경기 ${c.wins}승 ${c.losses}패 · KDA ${formatKda(c.kda)}${small}`;
}

function formatMastery(p) {
  const m = p.mastery;
  if (!m) return null;
  if (m.status === 'ok') return `숙련도 ${m.level}레벨 ${m.points.toLocaleString('ko-KR')}점 (플레이 경험 보조 정보)`;
  if (m.status === 'none') return '이 챔피언 숙련도 기록 없음';
  if (m.status === 'error') return `숙련도 조회 실패(${REASON_KO[m.reason] || '오류'})`;
  return null;
}

function formatResults(p) {
  const s = p.stats;
  if (!s || s.results.length === 0) return null;
  const icon = { W: '🟦', L: '🟥', R: '⬜', '?': '▫️' };
  const streak = formatStreak(s.streak);
  return `최근 결과 ${s.results.slice(0, 10).map((r) => icon[r]).join('')}${streak ? ` · ${streak}` : ''}`;
}

function sourceTag(item, matchups) {
  if (item.source === 'verified-matchup') {
    const m = matchups.find((x) => x.id === item.matchupId);
    const patch = m?.lastVerifiedPatch ? `패치 ${safeText(m.lastVerifiedPatch, 10)}` : '적용 패치 미확인';
    return `검수 상대법 · ${patch}`;
  }
  return { 'official-tip': '공식 일반 팁', composition: '조합 · 스킬 설명 기준', record: '수집 전적' }[item.source] || '근거';
}

function itemText(item, explanation) {
  const aiText = explanation?.status === 'ai' ? explanation.texts?.get(item.id) : null;
  return safeText(aiText || item.text, 300);
}

function explanationLabel(explanation, roleOverride) {
  if (roleOverride) return '설명: 템플릿 문장 (포지션 직접 지정 화면)';
  if (!explanation) return '설명: 템플릿 문장';
  if (explanation.status === 'pending') return '설명: AI 문장 다듬는 중 (템플릿 먼저 표시)';
  if (explanation.status === 'ai') return '설명: AI가 검증된 사실을 다듬음';
  if (explanation.status === 'template') return '설명: 템플릿 문장 (AI 결과 검증 실패·시간 초과)';
  return '설명: 템플릿 문장';
}

function completenessText(c, explanation, roleOverride) {
  const roleText = {
    estimated: '내 라인 추정',
    user: '내 라인 사용자 지정',
    uncertain: '내 라인 불확실',
    unsupported: '라인 분석 대상 모드 아님',
    none: '조회 대상 연결 실패',
  }[c.role];
  const lines = [
    `전적 ${c.historyOk}/${c.lookups}명 조회 · 랭크 ${c.rankOk}/${c.lookups}명 · ${roleText}`,
  ];
  const detail = [`경기 기록 ${c.collectedGames}건 집계`];
  if (c.pendingGames) detail.push(`${c.pendingGames}건 미수집`);
  if (c.failedGames) detail.push(`${c.failedGames}건 실패`);
  if (c.excludedGames) detail.push(`${c.excludedGames}건 제외(다시하기 등)`);
  lines.push(detail.join(' · '));
  if (c.hidden) lines.push(`비공개·봇 참가자 ${c.hidden}명은 챔피언 정보만 사용`);
  if (c.historyUnsupported) lines.push('이 모드는 전적 비교를 하지 않음');
  lines.push(`공식 챔피언 정보 ${c.profilesLoaded}/${c.players}명 · ${explanationLabel(explanation, roleOverride)}`);
  if (c.deadlineHit || c.budgetHit) {
    lines.push(`⏱️ ${c.deadlineHit ? '시간 제한' : '요청 예산'}으로 일부 상세 수집을 마치지 못함`);
  }
  return lines.join('\n');
}

function footerText(model) {
  const version = model.staticData?.version ? safeText(model.staticData.version, 20) : '미확인';
  return `동일 큐 최근 ${model.settings.lookbackDays}일 · 참가자별 최대 ${model.settings.maxGames}경기 · Data Dragon ${version} (클라이언트 패치와 다를 수 있음) · 게임 시작 정보 기반`;
}

function teamName(teamId) {
  return teamId === 100 ? '블루 팀' : teamId === 200 ? '레드 팀' : `팀 ${teamId}`;
}

// ============================================
// 📄 보기별 화면
// ============================================
function headerDescription(model, perspective) {
  const lines = [];
  const time = `<t:${Math.floor(model.analyzedAt / 1000)}:T>`;
  if (perspective.mode === 'personal') {
    const t = perspective.target;
    lines.push(`**${safeText(t.championName, 30)}** · 우리 팀 ${teamName(t.teamId)} · ${queueName(model.game.queueId)}`);
  } else {
    lines.push(`${queueName(model.game.queueId)}`);
    lines.push('⚠️ 조회한 계정을 이 게임의 참가자와 연결하지 못해 사용자 맞춤 분석을 생략하고 일반 정보만 표시합니다.');
  }
  lines.push(`분석 기준 ${time} · 현재 킬·골드·아이템은 반영하지 않음`);
  return lines.join('\n');
}

function laneSummary(perspective) {
  const { myRole, lane } = perspective;
  const lines = [];
  if (myRole?.role) {
    lines.push(`**${ROLE_LABELS[myRole.role]}** (${ROLE_LEVEL_LABELS[myRole.level]}) — ${safeText(myRole.reasons.slice(0, 2).join(', '), 150)}`);
  } else if (myRole?.level === 'uncertain') {
    lines.push(`**포지션 확인 불가** — ${safeText(myRole.reasons.slice(0, 2).join(', '), 150)}`);
  }
  const names = (list) => list.map((p) => `${safeText(p.championName, 30)}`).join('·') || '확인 불가';
  if (lane.type === 'solo' && lane.opponents.length > 0) {
    lines.push(`상대 후보: ${lane.opponents.map((p) => `${safeText(p.championName, 30)} · ${formatRoleOf(perspective, p)}`).join(', ')}`);
  } else if (lane.type === 'bottom') {
    lines.push(`우리 바텀: ${names(lane.allyDuo)} / 상대 바텀: ${names(lane.opponents)}`);
  } else if (lane.type === 'jungle') {
    lines.push(`상대 정글: ${names(lane.opponents)}`);
  }
  if (lane.note) lines.push(lane.note);
  return lines.join('\n');
}

function homeFields(model, briefing, explanation, roleOverride) {
  const { perspective, content, completeness } = briefing;
  const fields = [];
  if (perspective.mode === 'personal') {
    fields.push({ name: '🧭 내 포지션', value: laneSummary(perspective) });

    const cautionLines = content.cautions.map((c) => `• ${itemText(c, explanation)}  \`${sourceTag(c, content.matchups)}\``);
    if (perspective.lane.type !== 'none' && content.matchups.length === 0) cautionLines.push('· 검증된 상대법 자료 없음');
    fields.push({ name: '⚠️ 이번 판 주의할 점', value: cautionLines.join('\n') || '근거가 있는 주의사항 없음' });

    const optionLines = content.options.map((o) => `• ${itemText(o, explanation)}  \`${sourceTag(o, content.matchups)}\``);
    fields.push({ name: '🗺️ 운영 선택지', value: optionLines.join('\n') || '근거가 있는 운영 선택지 없음' });

    const t = perspective.target;
    fields.push({
      name: '📋 내 전적',
      value: [formatRank(t.rank), formatRecord(t, model.settings), formatChampionSample(t), formatResults(t), formatMastery(t)]
        .filter(Boolean)
        .join('\n'),
    });
  }
  fields.push({ name: '📊 데이터 완성도', value: completenessText(completeness, explanation, roleOverride) });
  return fields;
}

function playerField(model, perspective, p, runeNames) {
  const keystone = p.runes?.keystoneId != null ? runeNames?.get(p.runes.keystoneId) : null;
  const lines = [
    playerName(p),
    formatRank(p.rank),
    formatRecord(p, model.settings),
    formatChampionSample(p),
    `스펠 ${p.spellNames.map((n) => safeText(n, 20)).join(' / ')}${keystone ? ` · 핵심 룬 ${safeText(keystone, 20)}` : ''}`,
    formatMastery(p),
  ].filter(Boolean);
  const roleText = perspective.mode === 'personal' ? formatRoleOf(perspective, p) : '';
  return { name: `${roleText ? `${roleText} · ` : ''}${safeText(p.championName, 30)}`, value: lines.join('\n') };
}

function teamFields(model, briefing, which) {
  const { perspective } = briefing;
  let players;
  if (perspective.mode === 'personal') players = which === 'allies' ? perspective.allies : perspective.enemies;
  else players = model.participants.filter((p) => (which === 'allies' ? p.teamId === 100 : p.teamId !== 100));
  if (perspective.mode === 'personal' && perspective.roleSupported) {
    const order = (p) => {
      const r = perspective.roles.get(p.slot);
      return r?.role ? ROLES.indexOf(r.role) : ROLES.length;
    };
    players = [...players].sort((a, b) => order(a) - order(b) || a.slot - b.slot);
  }
  return players.map((p) => playerField(model, perspective, p, model.runeNames));
}

function laneFields(model, briefing) {
  const { perspective, content, knowledge } = briefing;
  if (perspective.mode !== 'personal') {
    return [{ name: '🧭 내 라인', value: '조회 대상과 참가자를 연결하지 못해 라인 분석을 하지 않습니다.' }];
  }
  const { lane, target } = perspective;
  const fields = [{ name: '🧭 포지션', value: laneSummary(perspective) }];
  const recordOf = (p) =>
    [formatRank(p.rank), formatRecord(p, model.settings), formatChampionSample(p), formatMastery(p)].filter(Boolean).join('\n');

  fields.push({ name: `나 · ${safeText(target.championName, 30)}`, value: recordOf(target) });
  const others = lane.type === 'bottom'
    ? [...lane.allyDuo.filter((p) => p !== target), ...lane.opponents]
    : lane.opponents || [];
  for (const p of others.slice(0, 4)) {
    const side = perspective.allies.includes(p) ? '우리' : '상대';
    fields.push({ name: `${side} · ${safeText(p.championName, 30)} · ${formatRoleOf(perspective, p)}`, value: recordOf(p) });
  }

  if (lane.type === 'none') return fields;

  if (content.matchups.length > 0) {
    fields.push({
      name: '📘 검수된 상대법',
      value: content.matchups
        .map((m) => {
          const patch = m.lastVerifiedPatch ? `패치 ${m.lastVerifiedPatch}` : '적용 패치 미확인';
          return `**${safeText(m.id, 60)}** (${patch} · 확인 ${safeText(m.checkedAt, 12)} · 출처 ${safeText(m.source.ref, 80)})\n${
            [...m.cautions, ...m.options].map((t) => `• ${safeText(t, 200)}`).join('\n')}`;
        })
        .join('\n\n'),
    });
  } else {
    const tips = [];
    for (const p of lane.opponents || []) {
      for (const tip of (knowledge.profileFor(p.championId)?.enemytips || []).slice(0, 2)) {
        tips.push(`• ${safeText(p.championName, 30)}: ${safeText(tip, 200)}`);
      }
    }
    fields.push({
      name: '📘 상대법',
      value: [
        '검증된 상대법 자료 없음',
        tips.length ? '아래는 상대 챔피언의 공식 일반 팁이며 이 매치업 전용 조언이 아닙니다.' : '상대 챔피언의 공식 일반 팁도 없습니다.',
        ...tips,
      ].join('\n'),
    });
  }
  return fields;
}

function compositionText(comp) {
  if (!comp) return '자료 없음';
  const lines = [];
  lines.push(
    comp.hardCc.length
      ? `하드 CC: ${comp.hardCc.map((h) => `${safeText(h.championName, 30)}(${h.skills.map((s) => `${s.slot} ${safeText(s.name, 20)}`).join(', ')})`).join(', ')}`
      : '하드 CC: 스킬 설명에서 확인된 챔피언 없음'
  );
  const d = comp.damage;
  lines.push(`피해 성향: 물리 ${d.physical} · 마법 ${d.magic} · 혼합 ${d.mixed}${d.unknown ? ` · 자료 없음 ${d.unknown}` : ''}`);
  if (!comp.conclusive) lines.push('자료가 있는 챔피언이 적어 팀 전체 결론을 유보합니다.');
  const curatedLabels = { engage: '교전 개시', protect: '아군 보호', frontline: '전열', poke: '원거리 견제' };
  const curatedLines = Object.entries(comp.curated)
    .filter(([, list]) => list.length > 0)
    .map(([key, list]) => `${curatedLabels[key]}: ${list.map((x) => safeText(x.championName, 30)).join(', ')}`);
  lines.push(curatedLines.length ? curatedLines.join('\n') : '교전 개시·보호·전열·견제: 검수된 특성 자료 없음');
  return lines.join('\n');
}

function compFields(model, briefing) {
  const { perspective, knowledge } = briefing;
  const teams = perspective.mode === 'personal'
    ? [['우리 팀', perspective.allies], ['상대 팀', perspective.enemies]]
    : [[teamName(100), model.participants.filter((p) => p.teamId === 100)], ['상대(다른) 팀', model.participants.filter((p) => p.teamId !== 100)]];
  return [
    ...teams.map(([name, players]) => ({ name: `🧩 ${name}`, value: compositionText(summarizeTeamComposition(players, knowledge)) })),
    {
      name: '기준',
      value: [
        '하드 CC: Data Dragon 스킬·패시브 설명의 키워드(기절·속박·공중에 띄움 등) 기준 휴리스틱',
        '피해 성향: Data Dragon info의 공격·마법 수치 차이 3 이상일 때만 분류하며, 실제 이번 경기 피해 비율이 아닙니다.',
        '교전 개시 등: 검수 완료된 자료만 표시합니다.',
      ].join('\n'),
    },
  ];
}

// ============================================
// 🧩 조립
// ============================================
const VIEW_LABELS = { home: '요약', lane: '내 라인', allies: '우리 팀', enemies: '상대 팀', comp: '조합' };

function buildComponents(sessionId, view, perspective, roleOverride, disabled = false) {
  if (!sessionId) return [];
  const personal = perspective.mode === 'personal';
  const labels = personal ? VIEW_LABELS : { ...VIEW_LABELS, allies: '블루 팀', enemies: '레드 팀' };
  const buttons = Object.keys(VIEW_LABELS).map((key) =>
    new ButtonBuilder()
      .setCustomId(viewCustomId(sessionId, key))
      .setLabel(labels[key])
      .setStyle(key === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled || (key === 'lane' && !personal))
  );
  const rows = [new ActionRowBuilder().addComponents(buttons)];
  if (personal && perspective.roleSupported) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(roleCustomId(sessionId))
      .setPlaceholder('내 포지션 직접 지정 (상대 포지션은 확정하지 않음)')
      .setDisabled(disabled)
      .addOptions([
        { label: '자동 추정', value: 'AUTO', default: !roleOverride },
        ...ROLES.map((r) => ({ label: `${ROLE_LABELS[r]}로 지정`, value: r, default: roleOverride === r })),
      ]);
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  return rows;
}

/**
 * 브리핑 메시지 payload. 외부 호출 없이 model만으로 만든다.
 */
function renderBriefing(model, { view = 'home', roleOverride = null, explanation = null, sessionId = null, disabled = false } = {}) {
  const briefing = buildBriefing(model, { roleOverride });
  const { perspective } = briefing;
  const effectiveView = view === 'lane' && perspective.mode !== 'personal' ? 'home' : view;

  let fields;
  let color = COLORS.home;
  if (effectiveView === 'lane') fields = laneFields(model, briefing);
  else if (effectiveView === 'allies') { fields = teamFields(model, briefing, 'allies'); color = COLORS.blue; }
  else if (effectiveView === 'enemies') { fields = teamFields(model, briefing, 'enemies'); color = COLORS.red; }
  else if (effectiveView === 'comp') fields = compFields(model, briefing);
  else fields = homeFields(model, briefing, explanation, roleOverride);

  const titleSuffix = effectiveView === 'home' ? '' : ` · ${perspective.mode === 'personal' ? VIEW_LABELS[effectiveView] : { ...VIEW_LABELS, allies: '블루 팀', enemies: '레드 팀' }[effectiveView]}`;
  const embed = toEmbed({
    title: `🎮 게임 시작 브리핑 — ${accountLabel(model.account)}${titleSuffix}`,
    description: headerDescription(model, perspective),
    fields,
    color,
    footer: { text: footerText(model) },
    timestamp: model.analyzedAt,
  });

  return {
    content: '',
    embeds: [embed],
    components: buildComponents(sessionId, effectiveView, perspective, roleOverride, disabled),
    allowedMentions: NO_MENTIONS,
    briefing,
  };
}

/** 전적 수집 전 기본 정보 (조회 대상·팀·모드) */
function renderLoading(model) {
  const target = model.participants.find((p) => p.puuid && p.puuid === model.targetPuuid);
  const lines = [];
  if (target) {
    lines.push(`**${safeText(target.championName, 30)}** · 우리 팀 ${teamName(target.teamId)} · ${queueName(model.game.queueId)}`);
  } else {
    lines.push(`${queueName(model.game.queueId)} · 조회 대상을 참가자와 연결하지 못해 일반 정보로 진행합니다.`);
  }
  lines.push('참가자 랭크와 동일 큐 전적을 모으는 중입니다. 최대 약 45초 후 모은 만큼 결과를 표시합니다.');
  return {
    content: '',
    embeds: [toEmbed({ title: `🔍 게임 시작 브리핑 준비 중 — ${accountLabel(model.account)}`, description: lines.join('\n'), color: COLORS.loading })],
    components: [],
    allowedMentions: NO_MENTIONS,
  };
}

function renderError(message) {
  return {
    content: '',
    embeds: [toEmbed({ title: '❌ 실시간 게임 조회 실패', description: safeText(message, 500), color: COLORS.error })],
    components: [],
    allowedMentions: NO_MENTIONS,
  };
}

module.exports = {
  EMBED_LIMITS,
  NO_MENTIONS,
  safeText,
  fitEmbedData,
  embedLength,
  formatRank,
  formatRecord,
  formatChampionSample,
  renderBriefing,
  renderLoading,
  renderError,
  buildComponents,
};
