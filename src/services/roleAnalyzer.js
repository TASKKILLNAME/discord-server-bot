'use strict';

const { ROLES, ANALYSIS_CONFIG } = require('../constants/realtimeAnalysis');
const snapshot = require('../../assets/lolps-champions.json');

// Existing champion pools are a weak prior, not current patch pick-rate statistics.
function championRoles(name) {
  return ROLES.filter((role) => snapshot.champions?.[role]?.includes(name));
}

function assignTeamRoles(players, getChampionRoles = championRoles) {
  if (players.length > 5) throw new Error('A role assignment supports at most five players');
  if (!players.length) return [];
  const smite = players.map((p) => p.spell1Id === 11 || p.spell2Id === 11);
  const smiteCount = smite.filter(Boolean).length;
  const evidence = players.map((p) => {
    const roles = getChampionRoles(p.championName);
    const stats = p.analysis?.status === 'ok' ? p.analysis : null;
    const championSample = Object.values(stats?.currentChampionRoles || {}).reduce((a, b) => a + b, 0);
    return { roles, stats, championSample };
  });
  const scores = players.map((_, i) => ROLES.map((role) => {
    const { roles, stats, championSample } = evidence[i];
    let score = roles.includes(role) ? (roles.length === 1 ? 5 : 3) : 0;
    if (championSample) score += 6 * Math.min(championSample / 5, 1) * stats.currentChampionRoles[role] / championSample;
    if (stats?.roleSample) score += 1.5 * stats.roleCounts[role] / stats.roleSample;
    if (smite[i]) score += role === 'JUNGLE' ? 20 : -20;
    else if (smiteCount && role === 'JUNGLE') score -= 12;
    return score;
  }));
  const assignments = [];
  function visit(chosen, remaining, score) {
    if (chosen.length === players.length) { assignments.push({ chosen, score }); return; }
    for (const role of remaining) {
      visit([...chosen, role], remaining.filter((r) => r !== role), score + scores[chosen.length][ROLES.indexOf(role)]);
    }
  }
  visit([], ROLES, 0);
  assignments.sort((a, b) => b.score - a.score); // Stable tie break: ROLES order.
  const best = assignments[0];
  return players.map((p, i) => {
    const role = best.chosen[i];
    const alternative = assignments.find((a) => a.chosen[i] !== role);
    const margin = alternative ? Math.max(0, best.score - alternative.score) : 0;
    const { roles, stats, championSample } = evidence[i];
    let strength = roles.includes(role) ? (roles.length === 1 ? 0.9 : 0.78) : 0.55;
    if (championSample >= 3 && stats.currentChampionRoles[role] / championSample >= 0.6) strength = 0.94;
    if (smite[i] && role === 'JUNGLE') strength = smiteCount === 1 ? 0.98 : 0.6;
    const confidence = Math.round(Math.min(strength, 0.5 + Math.min(margin / 6, 1) * 0.48) * 100) / 100;
    return { ...p, currentRole: { role, confidence, source: 'team-inference' } };
  });
}

function detectOffRole(analysis, currentRole) {
  const base = { status: 'DEFERRED', points: null, currentRoleRate: null };
  if (!analysis || analysis.status !== 'ok') return { ...base, reason: 'UNAVAILABLE' };
  if (analysis.sampleSize < ANALYSIS_CONFIG.minSample || analysis.roleSample < ANALYSIS_CONFIG.minSample) {
    return { ...base, reason: 'INSUFFICIENT_ROLE_SAMPLE' };
  }
  if (!ROLES.includes(currentRole?.role) || currentRole.confidence < ANALYSIS_CONFIG.minRoleConfidence) {
    return { ...base, reason: 'UNCERTAIN_CURRENT_ROLE' };
  }
  const currentRoleRate = analysis.roleCounts[currentRole.role] / analysis.roleSample;
  if (!analysis.primaryRole) return { ...base, currentRoleRate, reason: 'NO_PRIMARY_ROLE' };
  if (analysis.primaryRole === currentRole.role) return { status: 'NORMAL', points: 0, currentRoleRate };
  if (analysis.primaryRoleRate >= 0.5 && currentRoleRate <= 0.25) {
    return { status: 'SUSPECTED', points: 35, currentRoleRate };
  }
  return { status: 'SECONDARY', points: currentRoleRate >= 0.4 ? 10 : 20, currentRoleRate };
}

module.exports = { assignTeamRoles, detectOffRole, championRoles };
