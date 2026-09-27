'use strict';

const { ANALYSIS_CONFIG } = require('../constants/realtimeAnalysis');
const { detectOffRole } = require('./roleAnalyzer');

function calculateSpyScore({ analysis, currentRole, championId, private: isPrivate = false }) {
  const offRole = detectOffRole(analysis, currentRole);
  const pending = (reason) => ({ score: null, level: 'UNKNOWN', confidence: 0,
    reasons: [], components: {}, unavailableReason: reason, offRole });
  if (isPrivate) return pending('PRIVATE');
  if (analysis?.status !== 'ok') return pending('FETCH_FAILED');
  if (analysis.sampleSize < ANALYSIS_CONFIG.minSample) return pending('INSUFFICIENT_SAMPLE');
  if (!Number.isInteger(championId) || championId <= 0) return pending('UNKNOWN_CHAMPION');
  if (offRole.status === 'DEFERRED') return pending(offRole.reason);
  if (!Number.isFinite(analysis.winRate) || analysis.winRate < 0 || analysis.winRate > 1 ||
      !Number.isInteger(analysis.currentChampionGames) || analysis.currentChampionGames < 0 ||
      analysis.currentChampionGames > analysis.sampleSize || !Number.isInteger(analysis.lossStreak) ||
      analysis.lossStreak < 0 || analysis.lossStreak > analysis.sampleSize) return pending('INCOMPLETE_DATA');

  const n = analysis.currentChampionGames;
  const roleGames = analysis.roleCounts[currentRole.role];
  const wr = analysis.winRate;
  const components = {
    offRole: offRole.points,
    championExperience: n >= 5 ? 0 : n >= 3 ? 5 : n === 2 ? 10 : n === 1 ? 15 : 20,
    recentWinRate: wr > 0.5 ? 0 : wr > 0.45 ? 5 : wr > 0.4 ? 10 : wr > 0.3 ? 15 : 20,
    lossStreak: analysis.lossStreak < 2 ? 0 : analysis.lossStreak === 2 ? 3 : analysis.lossStreak === 3 ? 6 : 10,
    roleExperience: roleGames >= 5 ? 0 : roleGames >= 3 ? 5 : roleGames >= 1 ? 10 : 15,
  };
  const reasons = [];
  if (components.offRole) reasons.push(offRole.status === 'SUSPECTED' ? 'OFF_ROLE' : 'SECONDARY_ROLE');
  if (components.championExperience) reasons.push('LOW_CURRENT_CHAMP_EXPERIENCE');
  if (components.lossStreak) reasons.push('LOSS_STREAK');
  if (components.recentWinRate) reasons.push('LOW_RECENT_WINRATE');
  if (components.roleExperience) reasons.push('LOW_CURRENT_ROLE_EXPERIENCE');
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  return {
    score, level: score < 25 ? 'LOW' : score < 50 ? 'CAUTION' : score < 70 ? 'ELEVATED' : 'HIGH',
    confidence: Math.min(currentRole.confidence, analysis.sampleSize / 20, analysis.roleSample / 20),
    reasons, components, offRole,
  };
}

module.exports = { calculateSpyScore };
