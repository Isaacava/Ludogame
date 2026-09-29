'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'config.json');

const DEFAULTS = {
  rules: {
    playerCounts: [2, 3, 4],
    safeZonesEnabled: false,
    blockadesEnabled: false,
    extraTurnValues: [6],
    doubleValueGrantsExtraTurn: true,
    captureSendsCapturerHome: false,
    exactRollToFinish: true
  },
  monetization: {
    adsEnabled: true,
    adPlacements: { homepageTop: true, homepageSticky: true, waitingRoom: true, inGameSticky: true, winScreen: true },
    maxAdsPerPage: 3
  },
  season: { resetDayOfMonth: 1, rewardTopN: 10, rewardType: 'cash' },
  bot: {
    welcomeMessage: '👋 Welcome to CodePlay!\n\nWhat should we call you?',
    gameMenuHeader: 'Which game do you want to play?',
    whatsappNumber: '+1234567890'
  },
  maintenance: { siteEnabled: true, maintenanceMessage: 'CodePlay is down for maintenance — back soon!' }
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k]) out[k] = deepMerge(base[k], patch[k]);
    else out[k] = patch[k];
  }
  return out;
}

class ConfigStore {
  constructor(filePath = FILE) { this.filePath = filePath; this.config = this._load(); }
  _load() {
    try { return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
    catch { return { ...DEFAULTS }; }
  }
  _persist() { fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2)); }
  getAll() { return this.config; }
  get(section) { return this.config[section]; }
  patchSection(section, patch) {
    if (!DEFAULTS[section]) throw new Error(`unknown config section: ${section}`);
    this.config[section] = deepMerge(this.config[section], patch);
    this._persist();
    return this.config[section];
  }
  resetSection(section) {
    if (!DEFAULTS[section]) throw new Error(`unknown config section: ${section}`);
    this.config[section] = { ...DEFAULTS[section] };
    this._persist();
    return this.config[section];
  }
}
module.exports = { ConfigStore, DEFAULTS, deepMerge };
