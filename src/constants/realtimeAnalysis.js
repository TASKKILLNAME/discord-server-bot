'use strict';

// Product heuristics, not Riot-provided probabilities or an Autofill flag.
const ROLES = Object.freeze(['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']);
const ANALYSIS_CONFIG = Object.freeze({
  queueId: 420,
  sampleSize: 20,
  minSample: 10,
  minGameDurationSec: 300,
  minRoleConfidence: 0.75,
  deadlineMs: 60_000,
});

module.exports = { ROLES, ANALYSIS_CONFIG };
