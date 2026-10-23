// ============================================================================
// DIABETES DECISION SUPPORT SYSTEM (DiaCare DSS) - REAL ENGINE & NIGHTSCOUT SYNC
// ============================================================================

const APP_STORAGE_KEY = 'diacare_dss_data_v3'; // v3 - спокойный дизайн, полная база и алерты на высокий сахар

// Профиль и настройки по умолчанию
const DEFAULT_STATE = {
  profile: {
    weight: 70,
    height: 175,
    age: 28,
    gender: 'male',
    activityLevel: 'moderate',
    fastInsulin: 'Novorapid',
    basalInsulin: 'Lantus',
    tdd: 42,
    carbsInXe: 12,             // 12 г по дефолту, настраивается
    diaHours: 4.0,             // DIA 4 часа
    insulinPeakMinutes: 65,
    targetBgLow: 4.0,          // ммоль/л
    targetBgHigh: 7.8,         // ммоль/л
    targetBgMid: 5.5,          // ммоль/л
    isf: 2.38,
    icr: 11.9,
    schedules: {
      morning: { icr: 9.0, isf: 2.0, name: 'Утро (06:00 - 11:00)' },
      lunch:   { icr: 12.0, isf: 2.4, name: 'Обед (11:00 - 17:00)' },
      dinner:  { icr: 11.0, isf: 2.3, name: 'Ужин (17:00 - 23:00)' },
      night:   { icr: 14.0, isf: 2.8, name: 'Ночь (23:00 - 06:00)' }
    },
    stressFactor: 1.0,
    exerciseFactor: 1.0
  },
  settings: {
    nightscoutUrl: '',
    nightscoutToken: '',
    autoSyncNightscout: true,
    lastSyncTime: null,
    syncStatus: 'disconnected', // 'connected', 'syncing', 'error', 'disconnected'
    syncError: ''
  },
  cgmEntries: [],
  treatments: [],
  customFoods: [] // Пользовательские добавленные продукты
};

// ============================================================================
// СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// ============================================================================

let appState = loadState();
let chartInstance = null;
let syncTimer = null;
let isGuestMode = false;
let currentFoodCategory = 'all';

function loadState() {
  try {
    localStorage.removeItem('diacare_dss_data_v1');
    localStorage.removeItem('diacare_dss_data_v2');
    const raw = localStorage.getItem(APP_STORAGE_KEY);
    if (!raw) {
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      profile: { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) },
      customFoods: parsed.customFoods || []
    };
  } catch (e) {
    console.error('Ошибка загрузки локального состояния:', e);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState() {
  try {
    localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(appState));
  } catch (e) {
    console.error('Ошибка сохранения состояния:', e);
  }
}

// Получить объединенную базу (встроенная база DEFAULT_FOOD_DATABASE + пользовательские)
function getAllFoods() {
  const base = (typeof DEFAULT_FOOD_DATABASE !== 'undefined') ? DEFAULT_FOOD_DATABASE : [];
  return [...appState.customFoods, ...base];
}

// ============================================================================
// МОДУЛЬ СИНХРОНИЗАЦИИ С XDRIP+ / NIGHTSCOUT
// ============================================================================

function normalizeNightscoutUrl(rawUrl) {
  if (!rawUrl) return '';
  let url = rawUrl.trim().replace(/\/+$/, '');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  url = url.replace(/\/api\/v1\/(entries|treatments|status|sgv)(\.json)?$/i, '');
  url = url.replace(/\/api\/v1\/?$/i, '');
  return url;
}

async function fetchWithCorsFallback(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, mode: 'cors' });
    if (res.ok) return await res.json();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Доступ запрещен (HTTP ${res.status}). Проверьте API Secret / Токен.`);
    }
    throw new Error(`Ошибка сервера (HTTP ${res.status})`);
  } catch (err) {
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.name === 'TypeError') {
      console.warn('CORS блокировка браузера. Пробуем резервный CORS-прокси...');
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
      const proxyRes = await fetch(proxyUrl);
      if (proxyRes.ok) return await proxyRes.json();
      const proxyUrl2 = `https://corsproxy.io/?${encodeURIComponent(url)}`;
      const proxyRes2 = await fetch(proxyUrl2);
      if (proxyRes2.ok) return await proxyRes2.json();
    }
    throw err;
  }
}

async function syncNightscoutData(manualTrigger = false) {
  const baseUrl = normalizeNightscoutUrl(appState.settings.nightscoutUrl);
  if (!baseUrl) {
    appState.settings.syncStatus = 'disconnected';
    appState.settings.syncError = 'Укажите URL Nightscout / xDrip';
    updateSyncUI();
    if (manualTrigger) showToast('Введите адрес вашего Nightscout или xDrip', 'warn');
    return false;
  }

  appState.settings.syncStatus = 'syncing';
  updateSyncUI();

  const token = (appState.settings.nightscoutToken || '').trim();
  let queryParams = '?count=150';
  if (token) queryParams += `&token=${encodeURIComponent(token)}`;

  const candidateUrls = [
    `${baseUrl}/api/v1/entries/sgv.json${queryParams}`,
    `${baseUrl}/api/v1/entries.json${queryParams}`,
    `${baseUrl}/sgv.json${queryParams}`,
    `${baseUrl}/entries/sgv.json${queryParams}`
  ];

  const headers = { 'Accept': 'application/json' };
  if (token) headers['api-secret'] = token;

  let rawEntries = null;
  let lastError = null;

  for (const url of candidateUrls) {
    try {
      const data = await fetchWithCorsFallback(url, headers);
      if (Array.isArray(data) && data.length > 0) {
        rawEntries = data;
        break;
      }
    } catch (e) {
      lastError = e;
    }
  }

  try {
    if (!rawEntries) {
      throw lastError || new Error('Не удалось получить измерения сахара по указанному адресу');
    }

    const formattedEntries = [];
    rawEntries.forEach(item => {
      if (!item.sgv && item.sgv !== 0) return;
      const ts = item.date || (item.dateString ? new Date(item.dateString).getTime() : Date.now());
      let sgvMmol = item.sgv;
      if (item.sgv > 33.0) {
        sgvMmol = Number((item.sgv / 18.0182).toFixed(1));
      } else {
        sgvMmol = Number(item.sgv.toFixed(1));
      }

      formattedEntries.push({
        timestamp: ts,
        sgv: sgvMmol,
        direction: item.direction || 'Flat',
        trendRate: item.delta ? Number((item.delta / 18.0182).toFixed(2)) : 0
      });
    });

    if (formattedEntries.length === 0) {
      throw new Error('Данные получены, но в них нет записей поля sgv');
    }

    formattedEntries.sort((a, b) => a.timestamp - b.timestamp);

    if (formattedEntries.length >= 2) {
      const last = formattedEntries[formattedEntries.length - 1];
      const prev = formattedEntries[formattedEntries.length - 2];
      const timeDiffMinutes = (last.timestamp - prev.timestamp) / (60 * 1000);
      if (timeDiffMinutes > 0 && timeDiffMinutes <= 15) {
        last.trendRate = Number(((last.sgv - prev.sgv) / (timeDiffMinutes / 5)).toFixed(2));
      }
    }

    appState.cgmEntries = formattedEntries;
    appState.settings.lastSyncTime = Date.now();
    appState.settings.syncStatus = 'connected';
    appState.settings.syncError = '';

    await syncNightscoutTreatments(baseUrl, token);

    saveState();
    updateDashboardUI();
    updateSyncUI();

    if (manualTrigger) {
      const latest = formattedEntries[formattedEntries.length - 1];
      showToast(`Синхронизировано! Загружено ${formattedEntries.length} точек. Сахар: ${latest.sgv} ммоль/л`);
    }
    return true;

  } catch (err) {
    console.error('Ошибка синхронизации с Nightscout:', err);
    appState.settings.syncStatus = 'error';
    appState.settings.syncError = err.message || 'Ошибка подключения';
    updateSyncUI();
    if (manualTrigger) showToast(`Ошибка: ${appState.settings.syncError}`, 'warn');
    return false;
  }
}

async function syncNightscoutTreatments(baseUrl, token) {
  try {
    let query = '?count=50';
    if (token) query += `&token=${encodeURIComponent(token)}`;
    const url = `${baseUrl}/api/v1/treatments.json${query}`;
    const headers = { 'Accept': 'application/json' };
    if (token) headers['api-secret'] = token;

    const data = await fetchWithCorsFallback(url, headers);
    if (!Array.isArray(data)) return;

    data.forEach(t => {
      const ts = t.created_at ? new Date(t.created_at).getTime() : (t.timestamp || 0);
      if (!ts) return;

      const insulin = parseFloat(t.insulin || t.bolus || 0);
      const carbs = parseFloat(t.carbs || 0);
      if (insulin <= 0 && carbs <= 0) return;

      const exists = appState.treatments.some(local => 
        Math.abs(local.timestamp - ts) < 60000 && local.insulinUnits === insulin && local.carbsGrams === carbs
      );

      if (!exists) {
        appState.treatments.push({
          id: 'ns_' + (t._id || ts),
          timestamp: ts,
          insulinUnits: insulin,
          insulinType: insulin > 0 ? 'bolus' : 'none',
          carbsGrams: carbs,
          fpu: 0,
          foodItems: carbs > 0 ? [{ name: t.notes || 'Прием пищи из xDrip', weight: 100, carbs: carbs }] : [],
          bgAtInjection: t.glucose ? (t.glucose > 33 ? Number((t.glucose / 18.0182).toFixed(1)) : t.glucose) : null,
          pauseMinutes: 0,
          notes: t.notes || 'xDrip / Nightscout'
        });
      }
    });

    appState.treatments.sort((a, b) => b.timestamp - a.timestamp);
  } catch (e) {
    console.warn('Не удалось загрузить treatments из Nightscout:', e);
  }
}

function updateSyncUI() {
  const badge = document.getElementById('syncStatusBadge');
  const errorText = document.getElementById('syncErrorText');
  const lastSyncLabel = document.getElementById('lastSyncLabel');
  const mainStatusDot = document.getElementById('mainSyncDot');
  const status = appState.settings.syncStatus;

  if (mainStatusDot) {
    if (status === 'connected') {
      mainStatusDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
      mainStatusDot.title = 'xDrip / Nightscout онлайн';
    } else if (status === 'syncing') {
      mainStatusDot.className = 'w-2 h-2 rounded-full bg-teal-400 animate-pulse';
    } else if (status === 'error') {
      mainStatusDot.className = 'w-2 h-2 rounded-full bg-rose-400';
      mainStatusDot.title = appState.settings.syncError || 'Ошибка связи';
    } else {
      mainStatusDot.className = 'w-2 h-2 rounded-full bg-slate-500';
    }
  }

  if (badge) {
    if (status === 'connected') {
      badge.textContent = 'Подключено';
      badge.className = 'text-[11px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/20';
    } else if (status === 'syncing') {
      badge.textContent = 'Синхронизация...';
      badge.className = 'text-[11px] font-medium px-2 py-0.5 rounded-md bg-teal-500/15 text-teal-300 border border-teal-500/20 animate-pulse';
    } else if (status === 'error') {
      badge.textContent = 'Ошибка связи';
      badge.className = 'text-[11px] font-medium px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/20';
    } else {
      badge.textContent = 'Не подключено';
      badge.className = 'text-[11px] font-medium px-2 py-0.5 rounded-md bg-slate-800 text-slate-400';
    }
  }

  if (errorText) {
    if (status === 'error' && appState.settings.syncError) {
      errorText.textContent = appState.settings.syncError;
      errorText.classList.remove('hidden');
    } else {
      errorText.classList.add('hidden');
    }
  }

  if (lastSyncLabel && appState.settings.lastSyncTime) {
    const d = new Date(appState.settings.lastSyncTime);
    lastSyncLabel.textContent = `Синхр: ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
}

function saveNightscoutSettingsAndConnect() {
  const dashUrl = document.getElementById('dashNsUrl')?.value.trim() || '';
  const settingsUrl = document.getElementById('settingsNsUrl')?.value.trim() || '';
  const dashToken = document.getElementById('dashNsToken')?.value.trim() || '';
  const settingsToken = document.getElementById('settingsNsToken')?.value.trim() || '';

  const url = dashUrl || settingsUrl;
  const token = dashToken || settingsToken;

  if (!url) {
    showToast('Пожалуйста, вставьте ссылку на Nightscout / xDrip', 'warn');
    return;
  }

  appState.settings.nightscoutUrl = url;
  appState.settings.nightscoutToken = token;

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  setVal('dashNsUrl', url);
  setVal('settingsNsUrl', url);
  setVal('dashNsToken', token);
  setVal('settingsNsToken', token);

  saveState();
  syncNightscoutData(true);
}

// ============================================================================
// ДИАБЕТОЛОГИЧЕСКИЙ МАТЕМАТИЧЕСКИЙ ДВИЖОК
// ============================================================================

const DiabEngine = {
  getCurrentRatios(profile) {
    const hour = new Date().getHours();
    let currentSchedule = profile.schedules.lunch;
    if (hour >= 6 && hour < 11) currentSchedule = profile.schedules.morning;
    else if (hour >= 11 && hour < 17) currentSchedule = profile.schedules.lunch;
    else if (hour >= 17 && hour < 23) currentSchedule = profile.schedules.dinner;
    else currentSchedule = profile.schedules.night;

    const baseIcr = currentSchedule.icr || profile.icr;
    const baseIsf = currentSchedule.isf || profile.isf;

    const activeIcr = (baseIcr / profile.stressFactor) * profile.exerciseFactor;
    const activeIsf = (baseIsf / profile.stressFactor) * profile.exerciseFactor;

    return {
      icr: Number(activeIcr.toFixed(1)),
      isf: Number(activeIsf.toFixed(2)),
      scheduleName: currentSchedule.name
    };
  },

  calculateDoseIOB(doseUnits, minutesPassed, diaHours = 4.0, peakMinutes = 65) {
    const diaMinutes = diaHours * 60;
    if (minutesPassed <= 0) return doseUnits;
    if (minutesPassed >= diaMinutes) return 0;

    const tau = (peakMinutes * (1 - peakMinutes / diaMinutes)) / (1 - (2 * peakMinutes) / diaMinutes);
    const a = (2 * tau) / diaMinutes;
    const S = 1 / (1 - a + (1 + a) * Math.exp(-diaMinutes / tau));

    const activityRemaining = 1 - S * (
      1 - a - (minutesPassed / diaMinutes - a) * Math.exp(-minutesPassed / tau)
    );

    return Math.max(0, Math.min(doseUnits, doseUnits * activityRemaining));
  },

  getTotalActiveIOB(treatments, diaHours = 4.0, peakMinutes = 65) {
    const now = Date.now();
    let totalIob = 0;
    treatments.forEach(t => {
      if (!t.insulinUnits || t.insulinUnits <= 0) return;
      const minutesPassed = (now - t.timestamp) / (60 * 1000);
      if (minutesPassed < diaHours * 60) {
        totalIob += this.calculateDoseIOB(t.insulinUnits, minutesPassed, diaHours, peakMinutes);
      }
    });
    return Number(totalIob.toFixed(2));
  },

  getTotalActiveCOB(treatments) {
    const now = Date.now();
    let totalCob = 0;
    treatments.forEach(t => {
      if (!t.carbsGrams || t.carbsGrams <= 0) return;
      const minutesPassed = (now - t.timestamp) / (60 * 1000);
      const carbAbsorptionTime = 210;
      if (minutesPassed < carbAbsorptionTime) {
        const remainingFraction = Math.max(0, 1 - (minutesPassed / carbAbsorptionTime));
        totalCob += t.carbsGrams * remainingFraction;
      }
    });
    return Number(totalCob.toFixed(1));
  },

  calculateFPU(proteinsGrams, fatsGrams) {
    const kcalFromPF = (proteinsGrams * 4) + (fatsGrams * 9);
    return Number((kcalFromPF / 100).toFixed(1));
  },

  calculatePreBolusPause(currentBg, trendDirection, averageGI = 50, isf = 2.4, targetBg = 5.5) {
    if (currentBg < 4.5) return 0;

    let basePause = 10;
    const bgDelta = currentBg - targetBg;
    if (bgDelta > 0) {
      basePause += Math.round((bgDelta / isf) * 4);
    }

    switch (trendDirection) {
      case 'DoubleUp': basePause += 12; break;
      case 'SingleUp': basePause += 8; break;
      case 'FortyFiveUp': basePause += 4; break;
      case 'Flat': break;
      case 'FortyFiveDown': basePause -= 5; break;
      case 'SingleDown': basePause -= 10; break;
      case 'DoubleDown': basePause -= 15; break;
    }

    if (averageGI >= 70) basePause += 5;
    else if (averageGI <= 40) basePause -= 5;

    return Math.max(0, Math.min(45, basePause));
  },

  calculateFullBolus({ carbs, proteins, fats, currentBg, profile, averageGI = 50 }) {
    const ratios = this.getCurrentRatios(profile);
    const { icr, isf } = ratios;
    const currentIob = this.getTotalActiveIOB(appState.treatments, profile.diaHours, profile.insulinPeakMinutes);

    const foodBolus = carbs / icr;

    let correctionBolus = 0;
    if (currentBg > profile.targetBgHigh) {
      correctionBolus = (currentBg - profile.targetBgMid) / isf;
    } else if (currentBg < profile.targetBgLow) {
      correctionBolus = (currentBg - profile.targetBgMid) / isf;
    }

    const effectiveCorrection = Math.max(-foodBolus, correctionBolus - currentIob);
    const rawTotal = foodBolus + effectiveCorrection;
    const immediateBolus = Math.max(0, Number(rawTotal.toFixed(1)));

    const fpu = this.calculateFPU(proteins, fats);
    let extendedBolus = 0;
    let extendDurationHours = 0;

    if (fpu >= 1.0) {
      extendedBolus = Number(((fpu * 10) / icr).toFixed(1));
      if (fpu < 2.0) extendDurationHours = 3;
      else if (fpu < 3.0) extendDurationHours = 4;
      else extendDurationHours = 5;
    }

    const xe = Number((carbs / profile.carbsInXe).toFixed(1));

    const latestEntry = appState.cgmEntries[appState.cgmEntries.length - 1];
    const trend = latestEntry ? latestEntry.direction : 'Flat';
    const pauseMinutes = this.calculatePreBolusPause(currentBg, trend, averageGI, isf, profile.targetBgMid);

    return {
      immediateBolus,
      extendedBolus,
      extendDurationHours,
      foodBolus: Number(foodBolus.toFixed(1)),
      correctionBolus: Number(correctionBolus.toFixed(1)),
      iobDeducted: Number(Math.min(currentIob, correctionBolus).toFixed(1)),
      fpu,
      xe,
      pauseMinutes,
      ratios
    };
  },

  predictTrajectory(cgmEntries, treatments, profile, horizonMinutes = 90) {
    if (!cgmEntries || cgmEntries.length === 0) return [];
    const latest = cgmEntries[cgmEntries.length - 1];
    const startBg = latest.sgv;
    const startTime = latest.timestamp;
    const stepMin = 5;
    const steps = Math.floor(horizonMinutes / stepMin);

    let velocityPer5Min = 0;
    if (cgmEntries.length >= 3) {
      const prev = cgmEntries[cgmEntries.length - 3];
      velocityPer5Min = (latest.sgv - prev.sgv) / 2;
    } else if (latest.trendRate) {
      velocityPer5Min = latest.trendRate;
    }

    const ratios = this.getCurrentRatios(profile);
    const { isf, icr } = ratios;
    const csf = isf / icr;

    const projectedPoints = [];
    let currentSimBg = startBg;
    let remainingVelocity = velocityPer5Min;

    for (let step = 1; step <= steps; step++) {
      const simTime = startTime + step * stepMin * 60 * 1000;
      remainingVelocity *= 0.88;
      const deltaBg = remainingVelocity;

      let insulinImpactThisStep = 0;
      treatments.forEach(t => {
        if (!t.insulinUnits) return;
        const minutesPassedAtStep = (simTime - t.timestamp) / (60 * 1000);
        if (minutesPassedAtStep > 0 && minutesPassedAtStep < profile.diaHours * 60) {
          const iobBefore = DiabEngine.calculateDoseIOB(t.insulinUnits, minutesPassedAtStep - stepMin, profile.diaHours, profile.insulinPeakMinutes);
          const iobAfter = DiabEngine.calculateDoseIOB(t.insulinUnits, minutesPassedAtStep, profile.diaHours, profile.insulinPeakMinutes);
          const insulinConsumed = Math.max(0, iobBefore - iobAfter);
          insulinImpactThisStep += insulinConsumed * isf;
        }
      });

      let carbImpactThisStep = 0;
      treatments.forEach(t => {
        if (!t.carbsGrams) return;
        const minutesPassedAtStep = (simTime - t.timestamp) / (60 * 1000);
        if (minutesPassedAtStep > 0 && minutesPassedAtStep < 180) {
          const carbsPerStep = (t.carbsGrams / (180 / stepMin)) * Math.exp(-minutesPassedAtStep / 120);
          carbImpactThisStep += carbsPerStep * csf;
        }
      });

      currentSimBg += deltaBg + carbImpactThisStep - insulinImpactThisStep;
      currentSimBg = Math.max(1.8, Math.min(24.0, currentSimBg));

      projectedPoints.push({
        timestamp: simTime,
        sgv: Number(currentSimBg.toFixed(1)),
        isProjected: true
      });
    }

    return projectedPoints;
  },

  // Комплексный анализ гликемического статуса: советы и на ГИПО, и на ГИПЕРгликемию
  analyzeGlycemicStatus(cgmEntries, projectedPoints, profile, treatments) {
    if (!cgmEntries || cgmEntries.length === 0) return null;

    const latest = cgmEntries[cgmEntries.length - 1];
    const currentBg = latest.sgv;
    const ratios = this.getCurrentRatios(profile);
    const { isf, icr } = ratios;
    const currentIob = this.getTotalActiveIOB(treatments, profile.diaHours, profile.insulinPeakMinutes);

    // 1. ПРОВЕРКА НА ГИПОГЛИКЕМИЮ (текущую или прогнозируемую)
    let minPoint = null;
    let minIndex = -1;
    for (let i = 0; i < Math.min(15, projectedPoints.length); i++) {
      const pt = projectedPoints[i];
      if (!minPoint || pt.sgv < minPoint.sgv) {
        minPoint = pt;
        minIndex = i;
      }
    }

    const projectedLow = minPoint && minPoint.sgv < profile.targetBgLow;
    const isCurrentLow = currentBg < profile.targetBgLow;

    if (isCurrentLow || projectedLow) {
      const targetVal = isCurrentLow ? currentBg : minPoint.sgv;
      const minutesToMin = isCurrentLow ? 0 : (minIndex + 1) * 5;
      const csf = isf / icr;
      const bgDeficit = profile.targetBgMid - targetVal;
      const carbsNeeded = Math.max(6, Math.round(bgDeficit / csf));

      const allFoods = getAllFoods();
      // Выбираем подходящие продукты для купирования: сок, печенье Орео, яблоко
      const defaultOption = {
        name: 'Яблочный сок / Сахар',
        description: `${Math.round(carbsNeeded / 0.11)} мл сока или ${Math.round(carbsNeeded / 4)} кубика сахара`,
        carbs: carbsNeeded
      };

      const oreo = allFoods.find(f => f.name.toLowerCase().includes('oreo'));
      const apple = allFoods.find(f => f.name.toLowerCase().includes('яблоко'));

      const userOptions = [];
      if (oreo) {
        const oreoCount = Math.max(1, Math.round(carbsNeeded / (oreo.carbs * (oreo.servingWeight / 100))));
        userOptions.push({
          name: 'Печенье Oreo',
          description: `${oreoCount} шт (~${oreoCount * 11} г, ${carbsNeeded} г угл.)`,
          carbs: carbsNeeded
        });
      }
      if (apple) {
        const appleGrams = Math.round((carbsNeeded / apple.carbs) * 100);
        userOptions.push({
          name: 'Яблоко свежее',
          description: `${appleGrams} г (~${(appleGrams / 130).toFixed(1)} шт)`,
          carbs: carbsNeeded
        });
      }

      return {
        type: 'hypo',
        currentBg,
        projectedBg: isCurrentLow ? currentBg : minPoint.sgv,
        minutesUntil: minutesToMin,
        carbsNeeded,
        defaultOption,
        userOptions
      };
    }

    // 2. ПРОВЕРКА НА ГИПЕРГЛИКЕМИЮ (текущую или прогнозируемую)
    let maxPoint = null;
    let maxIndex = -1;
    for (let i = 0; i < Math.min(15, projectedPoints.length); i++) {
      const pt = projectedPoints[i];
      if (!maxPoint || pt.sgv > maxPoint.sgv) {
        maxPoint = pt;
        maxIndex = i;
      }
    }

    const isCurrentHigh = currentBg > profile.targetBgHigh;
    const projectedHigh = maxPoint && maxPoint.sgv > (profile.targetBgHigh + 0.8);

    if (isCurrentHigh || projectedHigh) {
      const peakBg = Math.max(currentBg, maxPoint ? maxPoint.sgv : currentBg);
      const bgExcess = peakBg - profile.targetBgMid;
      const rawCorrection = bgExcess / isf;
      // Чистая рекомендуемая подколка за вычетом активного IOB
      const recommendedCorrection = Math.max(0, Number((rawCorrection - currentIob).toFixed(1)));

      return {
        type: 'hyper',
        currentBg,
        projectedBg: peakBg,
        minutesUntil: (maxIndex >= 0) ? (maxIndex + 1) * 5 : 0,
        recommendedCorrection,
        rawCorrection: Number(rawCorrection.toFixed(1)),
        currentIob,
        isSevere: peakBg >= 13.0
      };
    }

    return { type: 'normal', currentBg };
  }
};

// ============================================================================
// ОТОБРАЖЕНИЕ ГРАФИКА (CHART.JS)
// ============================================================================

function initOrUpdateChart() {
  const ctx = document.getElementById('glucoseChart');
  if (!ctx) return;

  const history = appState.cgmEntries.slice(-72);
  const projected = DiabEngine.predictTrajectory(history, appState.treatments, appState.profile, 90);

  const labels = [];
  const historyData = [];
  const projectedData = [];

  history.forEach(pt => {
    const d = new Date(pt.timestamp);
    labels.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    historyData.push(pt.sgv);
    projectedData.push(null);
  });

  if (history.length > 0 && projected.length > 0) {
    projectedData[projectedData.length - 1] = history[history.length - 1].sgv;
  }

  projected.forEach(pt => {
    const d = new Date(pt.timestamp);
    labels.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    historyData.push(null);
    projectedData.push(pt.sgv);
  });

  const targetLow = appState.profile.targetBgLow;
  const targetHigh = appState.profile.targetBgHigh;

  if (chartInstance) {
    chartInstance.data.labels = labels;
    chartInstance.data.datasets[0].data = historyData;
    chartInstance.data.datasets[1].data = projectedData;
    chartInstance.update('none');
    return;
  }

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Сахар сенсора (ммоль/л)',
          data: historyData,
          borderColor: '#34d399',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: function(context) {
            const val = context.raw;
            if (!val) return '#34d399';
            if (val < 3.9) return '#f87171'; // Мягкий коралловый
            if (val > 8.5) return '#fbbf24'; // Спокойный янтарный
            return '#34d399';                // Спокойный мятный
          },
          tension: 0.3,
          fill: false
        },
        {
          label: 'Прогноз траектории (IOB+COB)',
          data: projectedData,
          borderColor: '#818cf8',
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 1.5,
          pointBackgroundColor: '#818cf8',
          tension: 0.3,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const val = context.raw;
              return val ? ` ${val} ммоль/л` : '';
            }
          }
        }
      },
      scales: {
        y: {
          min: 2.0,
          max: 16.0,
          grid: {
            color: function(context) {
              if (context.tick.value === targetLow) return 'rgba(248, 113, 113, 0.25)';
              if (context.tick.value === targetHigh) return 'rgba(251, 191, 36, 0.25)';
              return 'rgba(255, 255, 255, 0.04)';
            }
          },
          ticks: {
            color: '#64748b',
            callback: function(value) { return value + ' ммоль/л'; }
          }
        },
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.02)' },
          ticks: { color: '#64748b', maxTicksLimit: 10 }
        }
      }
    }
  });
}

// ============================================================================
// ОБНОВЛЕНИЕ UI
// ============================================================================

function updateDashboardUI() {
  const latestEntry = appState.cgmEntries[appState.cgmEntries.length - 1];

  const currentBgElem = document.getElementById('currentBgValue');
  const trendArrowElem = document.getElementById('currentTrendArrow');
  const trendRateElem = document.getElementById('currentTrendRate');
  const currentStatusElem = document.getElementById('currentStatusBadge');
  const activeIobElem = document.getElementById('activeIobValue');
  const activeCobElem = document.getElementById('activeCobValue');
  const lastUpdatedElem = document.getElementById('lastUpdatedTime');

  if (!latestEntry) {
    if (currentBgElem) {
      currentBgElem.textContent = '--';
      currentBgElem.className = 'text-5xl md:text-6xl font-extrabold text-slate-500';
    }
    if (trendArrowElem) trendArrowElem.textContent = 'Ожидание данных';
    if (trendRateElem) trendRateElem.textContent = 'Подключите Nightscout';
    if (currentStatusElem) {
      currentStatusElem.textContent = 'Нет данных';
      currentStatusElem.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700/60';
    }
    if (lastUpdatedElem) lastUpdatedElem.textContent = '--:--';
    initOrUpdateChart();
    renderSmartAdvice(null);
    return;
  }

  if (currentBgElem) {
    currentBgElem.textContent = latestEntry.sgv.toFixed(1);
    currentBgElem.className = 'text-5xl md:text-6xl font-extrabold tracking-tight transition-colors duration-300 ';
    if (latestEntry.sgv < 3.9) currentBgElem.classList.add('text-rose-400');
    else if (latestEntry.sgv > 8.5) currentBgElem.classList.add('text-amber-300');
    else currentBgElem.classList.add('text-emerald-400');
  }

  const arrows = {
    DoubleUp: '⇈ Быстрый рост',
    SingleUp: '↑ Рост',
    FortyFiveUp: '↗ Медленный рост',
    Flat: '→ Стабильно',
    FortyFiveDown: '↘ Медленный спад',
    SingleDown: '↓ Снижение',
    DoubleDown: '⇊ Быстрое падение'
  };

  if (trendArrowElem) {
    trendArrowElem.textContent = arrows[latestEntry.direction] || '→ Стабильно';
  }

  if (trendRateElem && latestEntry.trendRate !== undefined) {
    const sign = latestEntry.trendRate > 0 ? '+' : '';
    trendRateElem.textContent = `${sign}${latestEntry.trendRate.toFixed(2)} ммоль/л за 5 мин`;
  }

  if (currentStatusElem) {
    if (latestEntry.sgv < 3.9) {
      currentStatusElem.textContent = 'Низкий сахар (Гипо)';
      currentStatusElem.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/25';
    } else if (latestEntry.sgv > 8.5) {
      currentStatusElem.textContent = 'Выше целевого (Гипер)';
      currentStatusElem.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/25';
    } else {
      currentStatusElem.textContent = 'В норме';
      currentStatusElem.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25';
    }
  }

  const iob = DiabEngine.getTotalActiveIOB(appState.treatments, appState.profile.diaHours, appState.profile.insulinPeakMinutes);
  const cob = DiabEngine.getTotalActiveCOB(appState.treatments);

  if (activeIobElem) activeIobElem.textContent = `${iob} ед`;
  if (activeCobElem) activeCobElem.textContent = `${cob} г`;

  if (lastUpdatedElem) {
    const d = new Date(latestEntry.timestamp);
    lastUpdatedElem.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  initOrUpdateChart();

  const history = appState.cgmEntries.slice(-30);
  const projected = DiabEngine.predictTrajectory(history, appState.treatments, appState.profile, 90);
  const statusAdvice = DiabEngine.analyzeGlycemicStatus(appState.cgmEntries, projected, appState.profile, appState.treatments);

  renderSmartAdvice(statusAdvice);
  updateNutritionDailySummary();
  updateRecentTreatmentsList();
}

// Баннер рекомендаций: как при ГИПО, так и при ГИПЕРгликемии
function renderSmartAdvice(statusAdvice) {
  const container = document.getElementById('smartAdviceContainer');
  if (!container) return;

  if (!statusAdvice || statusAdvice.type === 'normal') {
    container.innerHTML = `
      <div class="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400 font-bold text-base">✓</div>
          <div>
            <h4 class="text-xs font-semibold text-slate-200">Гликемический профиль стабилен</h4>
            <p class="text-[11px] text-slate-400">Резких колебаний и выхода за целевые пределы не прогнозируется.</p>
          </div>
        </div>
        <span class="text-[11px] px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg border border-slate-700/50">В норме</span>
      </div>
    `;
    return;
  }

  // --- СЛУЧАЙ 1: ГИПОГЛИКЕМИЯ (СПАД САХАРА) ---
  if (statusAdvice.type === 'hypo') {
    let userOptionsHtml = '';
    statusAdvice.userOptions.forEach((opt, idx) => {
      userOptionsHtml += `
        <button onclick="quickConsumeCarbs('${opt.name}', ${opt.carbs})" class="text-left p-2.5 rounded-xl bg-slate-800/70 hover:bg-slate-700/60 border border-slate-700/60 transition group">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-slate-200 group-hover:text-amber-200">${opt.name}</span>
            <span class="text-[10px] px-1.5 py-0.2 bg-amber-500/15 text-amber-300 rounded">Вариант ${idx + 1}</span>
          </div>
          <p class="text-[11px] text-amber-200/90 mt-0.5 font-mono">${opt.description}</p>
        </button>
      `;
    });

    container.innerHTML = `
      <div class="p-4 md:p-5 rounded-2xl bg-gradient-to-r from-rose-950/30 via-slate-900 to-slate-900 border border-rose-500/30 shadow-lg">
        <div class="flex items-start justify-between">
          <div class="flex items-center space-x-3">
            <div class="w-9 h-9 rounded-xl bg-rose-500/15 text-rose-300 flex items-center justify-center font-bold text-lg">⚠️</div>
            <div>
              <h4 class="text-xs font-bold text-rose-200">
                ${statusAdvice.minutesUntil > 0 
                  ? `Прогнозируется снижение до ${statusAdvice.projectedBg} ммоль/л через ~${statusAdvice.minutesUntil} мин!` 
                  : `Текущий сахар ниже целевого: ${statusAdvice.currentBg} ммоль/л`}
              </h4>
              <p class="text-[11px] text-slate-300 mt-0.5">Примите <span class="font-bold text-amber-300">${statusAdvice.carbsNeeded} г быстрых углеводов</span> для купирования гипогликемии.</p>
            </div>
          </div>
          <span class="text-[10px] font-bold px-2 py-0.5 bg-rose-500/15 text-rose-300 border border-rose-500/25 rounded-md">Низкий сахар</span>
        </div>

        <div class="mt-3.5 pt-3 border-t border-slate-800/80">
          <p class="text-[11px] font-medium text-slate-400 mb-2">Рекомендуемые варианты перекуса с рассчитанной граммовкой:</p>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
            <button onclick="quickConsumeCarbs('${statusAdvice.defaultOption.name}', ${statusAdvice.defaultOption.carbs})" class="text-left p-2.5 rounded-xl bg-emerald-950/20 hover:bg-emerald-900/30 border border-emerald-500/30 transition group">
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-emerald-200">${statusAdvice.defaultOption.name}</span>
                <span class="text-[10px] px-1.5 py-0.2 bg-emerald-500/15 text-emerald-300 rounded font-bold">Быстро</span>
              </div>
              <p class="text-[11px] text-emerald-300/90 mt-0.5 font-mono">${statusAdvice.defaultOption.description}</p>
            </button>
            ${userOptionsHtml}
          </div>
        </div>
      </div>
    `;
    return;
  }

  // --- СЛУЧАЙ 2: ГИПЕРГЛИКЕМИЯ (ВЫСОКИЙ САХАР) ---
  if (statusAdvice.type === 'hyper') {
    const isSevere = statusAdvice.isSevere;
    container.innerHTML = `
      <div class="p-4 md:p-5 rounded-2xl bg-gradient-to-r from-amber-950/25 via-slate-900 to-slate-900 border border-amber-500/30 shadow-lg">
        <div class="flex items-start justify-between">
          <div class="flex items-center space-x-3">
            <div class="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-300 flex items-center justify-center font-bold text-lg">📈</div>
            <div>
              <h4 class="text-xs font-bold text-amber-200">
                ${statusAdvice.minutesUntil > 0
                  ? `Прогнозируется рост до ${statusAdvice.projectedBg} ммоль/л через ~${statusAdvice.minutesUntil} мин`
                  : `Повышенный уровень сахара: ${statusAdvice.currentBg} ммоль/л`}
              </h4>
              <p class="text-[11px] text-slate-300 mt-0.5">
                ${statusAdvice.recommendedCorrection > 0
                  ? `Рекомендуемая доза коррекции: <span class="font-bold text-amber-300">${statusAdvice.recommendedCorrection} ед</span> быстрого инсулина (с учетом активного IOB ${statusAdvice.currentIob} ед).`
                  : `Дополнительная подколка не требуется — активного инсулина в организме (IOB ${statusAdvice.currentIob} ед) достаточно для компенсации.`}
              </p>
            </div>
          </div>
          <span class="text-[10px] font-bold px-2 py-0.5 ${isSevere ? 'bg-rose-500/15 text-rose-300 border-rose-500/25' : 'bg-amber-500/15 text-amber-300 border-amber-500/25'} border rounded-md">
            ${isSevere ? 'Высокая гипер' : 'Выше цели'}
          </span>
        </div>

        <div class="mt-3.5 pt-3 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
          <!-- Действие 1: Подколка в 1 клик -->
          <div class="p-2.5 rounded-xl bg-slate-800/50 border border-slate-700/60 flex flex-col justify-between">
            <div>
              <span class="text-slate-300 font-medium block">Корректирующий болюс</span>
              <span class="text-[11px] text-slate-400 block mt-0.5">По правилу ISF = ${appState.profile.isf}</span>
            </div>
            ${statusAdvice.recommendedCorrection > 0 ? `
              <button onclick="commitCorrectionDose(${statusAdvice.recommendedCorrection})" class="mt-2 w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition">
                Ввести подколку ${statusAdvice.recommendedCorrection} ед
              </button>
            ` : `
              <span class="mt-2 text-[11px] text-emerald-400 font-medium">IOB покрывает снижение</span>
            `}
          </div>

          <!-- Действие 2: Водный баланс -->
          <div class="p-2.5 rounded-xl bg-slate-800/50 border border-slate-700/60">
            <span class="text-slate-300 font-medium flex items-center space-x-1">
              <span>💧</span>
              <span>Водный режим</span>
            </span>
            <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">
              Выпейте 1–2 стакана чистой воды без газа (ускоряет естественный вывод избытка сахара почками).
            </p>
          </div>

          <!-- Действие 3: Пауза / Кетоны -->
          <div class="p-2.5 rounded-xl bg-slate-800/50 border border-slate-700/60">
            <span class="text-slate-300 font-medium flex items-center space-x-1">
              <span>🍽️</span>
              <span>Рекомендация по еде</span>
            </span>
            <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">
              ${isSevere 
                ? 'Сахар выше 13 ммоль/л: проверьте кетоны в моче/крови, избегайте нагрузок!' 
                : 'Отложите углеводную пищу до снижения уровня глюкозы в целевой диапазон.'}
            </p>
          </div>
        </div>
      </div>
    `;
  }
}

// Запись подколки на высокий сахар
function commitCorrectionDose(units) {
  const latest = appState.cgmEntries[appState.cgmEntries.length - 1];
  const now = Date.now();
  appState.treatments.unshift({
    id: 'corr_' + now,
    timestamp: now,
    insulinUnits: units,
    insulinType: 'correction',
    carbsGrams: 0,
    fpu: 0,
    foodItems: [],
    bgAtInjection: latest ? latest.sgv : null,
    pauseMinutes: 0,
    notes: 'Подколка на коррекцию сахара'
  });

  saveState();
  updateDashboardUI();
  showToast(`Зафиксирована коррекция: ${units} ед инсулина`);
}

function quickConsumeCarbs(foodName, carbs) {
  const now = Date.now();
  const latest = appState.cgmEntries[appState.cgmEntries.length - 1];
  appState.treatments.unshift({
    id: 'hypo_fix_' + now,
    timestamp: now,
    insulinUnits: 0,
    insulinType: 'none',
    carbsGrams: carbs,
    fpu: 0,
    foodItems: [{ name: foodName, weight: 100, carbs: carbs }],
    bgAtInjection: latest ? latest.sgv : null,
    pauseMinutes: 0,
    notes: 'Купирование гипо (по совету системы)'
  });

  saveState();
  updateDashboardUI();
  showToast(`Записан перекус: ${foodName} (${carbs} г углеводов)`);
}

// ============================================================================
// ПОДСЧЕТ И СРАВНЕНИЕ КБЖУ (СЕГОДНЯ VS ВЧЕРА)
// ============================================================================

function getDayNutritionSummary(targetDate) {
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  let carbs = 0, proteins = 0, fats = 0, kcal = 0, xe = 0, insulinTotal = 0;

  appState.treatments.forEach(t => {
    if (t.timestamp >= startOfDay.getTime() && t.timestamp <= endOfDay.getTime()) {
      carbs += t.carbsGrams || 0;
      insulinTotal += t.insulinUnits || 0;

      if (t.foodItems && Array.isArray(t.foodItems)) {
        t.foodItems.forEach(item => {
          proteins += item.proteins || 0;
          fats += item.fats || 0;
          kcal += item.kcal || (item.carbs * 4);
        });
      }
    }
  });

  xe = carbs / appState.profile.carbsInXe;

  return {
    carbs: Math.round(carbs),
    proteins: Math.round(proteins),
    fats: Math.round(fats),
    kcal: Math.round(kcal || (carbs * 4 + proteins * 4 + fats * 9)),
    xe: Number(xe.toFixed(1)),
    insulinTotal: Number(insulinTotal.toFixed(1))
  };
}

function updateNutritionDailySummary() {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const statsToday = getDayNutritionSummary(today);
  const statsYesterday = getDayNutritionSummary(yesterday);

  const tKcal = document.getElementById('todayKcal');
  const tCarbs = document.getElementById('todayCarbs');
  const tXe = document.getElementById('todayXe');
  const tProt = document.getElementById('todayProt');
  const tFats = document.getElementById('todayFats');

  const yKcal = document.getElementById('yestKcal');
  const yCarbs = document.getElementById('yestCarbs');
  const yXe = document.getElementById('yestXe');
  const yProt = document.getElementById('yestProt');
  const yFats = document.getElementById('yestFats');

  if (tKcal) tKcal.textContent = statsToday.kcal;
  if (tCarbs) tCarbs.textContent = `${statsToday.carbs} г`;
  if (tXe) tXe.textContent = `${statsToday.xe} ХЕ`;
  if (tProt) tProt.textContent = `${statsToday.proteins} г`;
  if (tFats) tFats.textContent = `${statsToday.fats} г`;

  if (yKcal) yKcal.textContent = statsYesterday.kcal;
  if (yCarbs) yCarbs.textContent = `${statsYesterday.carbs} г`;
  if (yXe) yXe.textContent = `${statsYesterday.xe} ХЕ`;
  if (yProt) yProt.textContent = `${statsYesterday.proteins} г`;
  if (yFats) yFats.textContent = `${statsYesterday.fats} г`;
}

function updateRecentTreatmentsList() {
  const container = document.getElementById('recentTreatmentsList');
  if (!container) return;

  if (appState.treatments.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500 py-3 text-center">Записей инъекций и еды пока нет</p>';
    return;
  }

  let html = '';
  appState.treatments.slice(0, 8).forEach(t => {
    const d = new Date(t.timestamp);
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const itemsDesc = t.foodItems && t.foodItems.length > 0 
      ? t.foodItems.map(i => i.name).join(', ') 
      : t.notes || 'Инъекция';

    html += `
      <div class="p-3 rounded-xl bg-slate-900/50 border border-slate-800/80 flex items-center justify-between text-xs">
        <div class="flex items-center space-x-3">
          <span class="font-mono text-slate-400 font-bold">${timeStr}</span>
          <div>
            <div class="font-medium text-slate-200">${itemsDesc}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">
              ${t.carbsGrams ? `${t.carbsGrams} г угл. (${(t.carbsGrams / appState.profile.carbsInXe).toFixed(1)} ХЕ)` : ''}
              ${t.fpu ? ` • ${t.fpu} БЖЕ` : ''}
              ${t.pauseMinutes ? ` • Пауза ${t.pauseMinutes} мин` : ''}
            </div>
          </div>
        </div>
        <div class="text-right">
          ${t.insulinUnits > 0 ? `<span class="px-2 py-0.5 rounded-lg bg-indigo-500/15 text-indigo-300 font-medium">${t.insulinUnits} ед</span>` : '<span class="text-slate-500">без инс.</span>'}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ============================================================================
// ПОИСК И КАТАЛОГ ПРОДУКТОВ (ОТКРЫТАЯ БОЛЬШАЯ БАЗА)
// ============================================================================

let currentMealCart = [];

function setFoodCategory(category) {
  currentFoodCategory = category;
  const pills = document.querySelectorAll('.category-pill');
  pills.forEach(p => {
    if (p.getAttribute('data-cat') === category) {
      p.className = 'category-pill px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-700 text-slate-100 border border-slate-600';
    } else {
      p.className = 'category-pill px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-400 hover:text-slate-200 border border-slate-800';
    }
  });

  const searchInput = document.getElementById('foodSearchInput');
  renderFoodDatabaseList(searchInput ? searchInput.value : '');
}

function renderFoodDatabaseList(searchQuery = '') {
  const container = document.getElementById('foodCatalogList');
  if (!container) return;

  const allFoods = getAllFoods();
  const q = searchQuery.toLowerCase().trim();

  let filtered = allFoods;

  // Фильтр по категории
  if (currentFoodCategory !== 'all') {
    filtered = filtered.filter(f => f.category === currentFoodCategory);
  }

  // Фильтр по поисковому запросу
  if (q) {
    filtered = filtered.filter(f => {
      const nameMatch = f.name.toLowerCase().includes(q);
      const brandMatch = f.brand && f.brand.toLowerCase().includes(q);
      return nameMatch || brandMatch;
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="text-center py-6 text-slate-500 text-xs">
        <p>Продукт "${searchQuery}" не найден.</p>
        <button onclick="openAddCustomFoodModal('${searchQuery}')" class="mt-2 text-indigo-400 hover:underline">
          + Добавить "${searchQuery}" в личную базу
        </button>
      </div>
    `;
    return;
  }

  let html = '';
  filtered.slice(0, 40).forEach(f => {
    const defaultServing = f.servingWeight || 100;
    const servingName = f.servingName ? `(${f.servingName})` : '';

    html += `
      <div class="p-2.5 bg-slate-900/60 hover:bg-slate-800/70 border border-slate-800/80 rounded-xl flex items-center justify-between text-xs transition">
        <div class="flex-1 pr-2">
          <div class="flex items-center space-x-1.5">
            <span class="font-medium text-slate-200">${f.name}</span>
            ${f.brand ? `<span class="text-[10px] text-slate-500 font-mono">${f.brand}</span>` : ''}
          </div>
          <div class="text-[11px] text-slate-400 font-mono mt-0.5">
            Угл: <span class="text-amber-300 font-bold">${f.carbs}г</span> • Бел: ${f.proteins}г • Жир: ${f.fats}г • ${f.kcal} ккал / 100г
          </div>
        </div>
        <div class="flex items-center space-x-1.5">
          <button onclick="addFoodToCart('${f.id}', ${defaultServing})" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/80 rounded-lg text-xs font-medium transition" title="Добавить порцию">
            + ${defaultServing}г
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Добавление продукта в корзину
function addFoodToCart(foodId, customWeight = 100) {
  const allFoods = getAllFoods();
  const food = allFoods.find(f => f.id === foodId);
  if (!food) return;

  const existing = currentMealCart.find(i => i.id === foodId);
  if (existing) {
    existing.weight += customWeight;
  } else {
    currentMealCart.push({
      id: food.id,
      name: food.name,
      carbs100: food.carbs,
      proteins100: food.proteins,
      fats100: food.fats,
      kcal100: food.kcal,
      gi: food.gi || 50,
      weight: customWeight
    });
  }

  renderMealCart();
  calculateMealBolus();
}

function removeCartItem(idx) {
  currentMealCart.splice(idx, 1);
  renderMealCart();
  calculateMealBolus();
}

function updateCartItemWeight(idx, newWeight) {
  const w = parseFloat(newWeight) || 0;
  if (w <= 0) {
    removeCartItem(idx);
    return;
  }
  currentMealCart[idx].weight = w;
  renderMealCart();
  calculateMealBolus();
}

function renderMealCart() {
  const container = document.getElementById('mealCartItems');
  if (!container) return;

  if (currentMealCart.length === 0) {
    container.innerHTML = `
      <div class="text-center py-6 text-slate-500 text-xs">
        Блюдо пока не выбрано. Найдите продукты в каталоге справа или воспользуйтесь быстрым поиском.
      </div>
    `;
    return;
  }

  let html = '';
  currentMealCart.forEach((item, idx) => {
    const itemCarbs = ((item.carbs100 * item.weight) / 100).toFixed(1);
    const itemXe = (itemCarbs / appState.profile.carbsInXe).toFixed(1);

    html += `
      <div class="p-3 bg-slate-900/60 border border-slate-800/80 rounded-xl flex items-center justify-between text-xs">
        <div class="flex-1 pr-2">
          <div class="font-medium text-slate-200">${item.name}</div>
          <div class="text-slate-400 text-[11px] mt-0.5 font-mono">
            ${itemCarbs} г угл. (${itemXe} ХЕ) • Б: ${((item.proteins100 * item.weight)/100).toFixed(1)} г, Ж: ${((item.fats100 * item.weight)/100).toFixed(1)} г
          </div>
        </div>
        <div class="flex items-center space-x-2">
          <input type="number" min="1" max="1000" step="5" value="${item.weight}" 
                 onchange="updateCartItemWeight(${idx}, this.value)"
                 class="w-16 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 text-center font-mono text-xs">
          <span class="text-slate-400 text-xs">г</span>
          <button onclick="removeCartItem(${idx})" class="p-1 text-slate-500 hover:text-rose-400 transition">✕</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function calculateMealBolus() {
  let totalCarbs = 0;
  let totalProteins = 0;
  let totalFats = 0;
  let weightedGiSum = 0;

  currentMealCart.forEach(item => {
    const carbs = (item.carbs100 * item.weight) / 100;
    const proteins = (item.proteins100 * item.weight) / 100;
    const fats = (item.fats100 * item.weight) / 100;

    totalCarbs += carbs;
    totalProteins += proteins;
    totalFats += fats;
    weightedGiSum += item.gi * carbs;
  });

  const avgGi = totalCarbs > 0 ? Math.round(weightedGiSum / totalCarbs) : 50;
  const latestEntry = appState.cgmEntries[appState.cgmEntries.length - 1];
  const currentBg = latestEntry ? latestEntry.sgv : 6.0;

  const result = DiabEngine.calculateFullBolus({
    carbs: totalCarbs,
    proteins: totalProteins,
    fats: totalFats,
    currentBg: currentBg,
    profile: appState.profile,
    averageGI: avgGi
  });

  const immediateElem = document.getElementById('calcImmediateBolus');
  const extendedElem = document.getElementById('calcExtendedBolus');
  const pauseElem = document.getElementById('calcRecommendedPause');
  const carbsElem = document.getElementById('calcTotalCarbs');
  const xeElem = document.getElementById('calcTotalXe');
  const fpuElem = document.getElementById('calcTotalFpu');

  if (immediateElem) immediateElem.textContent = `${result.immediateBolus} ед`;
  if (extendedElem) {
    if (result.extendedBolus > 0) {
      extendedElem.textContent = `+ ${result.extendedBolus} ед растянуть на ${result.extendDurationHours} ч (на жиры и белки)`;
      extendedElem.classList.remove('hidden');
    } else {
      extendedElem.classList.add('hidden');
    }
  }

  if (pauseElem) pauseElem.textContent = `${result.pauseMinutes} мин`;
  if (carbsElem) carbsElem.textContent = `${Math.round(totalCarbs)} г`;
  if (xeElem) xeElem.textContent = `${result.xe} ХЕ`;
  if (fpuElem) fpuElem.textContent = `${result.fpu} БЖЕ`;

  return result;
}

function commitCurrentMeal() {
  if (currentMealCart.length === 0) {
    alert('Пожалуйста, добавьте хотя бы один продукт в расчет.');
    return;
  }

  const result = calculateMealBolus();
  const latestEntry = appState.cgmEntries[appState.cgmEntries.length - 1];
  const now = Date.now();

  const newTreatment = {
    id: 't_' + now,
    timestamp: now,
    insulinUnits: result.immediateBolus,
    extendedInsulinUnits: result.extendedBolus,
    extendedHours: result.extendDurationHours,
    insulinType: 'bolus',
    carbsGrams: Math.round(parseFloat(document.getElementById('calcTotalCarbs').textContent) || 0),
    fpu: result.fpu,
    foodItems: currentMealCart.map(i => ({
      name: i.name,
      weight: i.weight,
      carbs: Number(((i.carbs100 * i.weight)/100).toFixed(1)),
      proteins: Number(((i.proteins100 * i.weight)/100).toFixed(1)),
      fats: Number(((i.fats100 * i.weight)/100).toFixed(1))
    })),
    bgAtInjection: latestEntry ? latestEntry.sgv : 6.0,
    pauseMinutes: result.pauseMinutes,
    notes: 'Расчет калькулятора'
  };

  appState.treatments.unshift(newTreatment);
  saveState();

  currentMealCart = [];
  renderMealCart();
  calculateMealBolus();

  updateDashboardUI();
  showToast(`Записан болюс ${result.immediateBolus} ед. Пауза перед едой: ${result.pauseMinutes} мин.`);
  switchTab('dashboardTab');
}

// Добавление собственного продукта в базу
function openAddCustomFoodModal(presetName = '') {
  const name = prompt('Название продукта:', presetName);
  if (!name || !name.trim()) return;

  const carbsStr = prompt('Углеводы на 100 г:', '25');
  if (carbsStr === null) return;
  const carbs = parseFloat(carbsStr) || 0;

  const proteinsStr = prompt('Белки на 100 г (опционально):', '5');
  const proteins = parseFloat(proteinsStr) || 0;

  const fatsStr = prompt('Жиры на 100 г (опционально):', '2');
  const fats = parseFloat(fatsStr) || 0;

  const customItem = {
    id: 'custom_' + Date.now(),
    name: name.trim(),
    category: 'custom',
    carbs: carbs,
    proteins: proteins,
    fats: fats,
    kcal: Math.round(carbs * 4 + proteins * 4 + fats * 9),
    gi: 50,
    servingWeight: 100,
    brand: 'Мой продукт'
  };

  appState.customFoods.unshift(customItem);
  saveState();
  renderFoodDatabaseList();
  addFoodToCart(customItem.id, 100);
  showToast(`Продукт "${customItem.name}" добавлен в базу!`);
}

// ============================================================================
// РОДИТЕЛЬСКИЙ / ГОСТЕВОЙ ДОСТУП (READ-ONLY)
// ============================================================================

function checkUrlForGuestMode() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'guest' || urlParams.get('guest') === 'true') {
    enableGuestMode();
  }
}

function enableGuestMode() {
  isGuestMode = true;
  document.body.classList.add('guest-mode-active');
  const banner = document.getElementById('guestModeBanner');
  if (banner) banner.classList.remove('hidden');

  const editElements = document.querySelectorAll('.patient-only-control');
  editElements.forEach(el => el.classList.add('hidden'));

  showToast('Активирован гостевой режим родителя (только просмотр)');
}

function generateGuestShareLink() {
  const currentUrl = new URL(window.location.href);
  currentUrl.searchParams.set('mode', 'guest');
  navigator.clipboard.writeText(currentUrl.toString());
  showToast('Ссылка скопирована! Отправьте её родителю для безопасного просмотра.');
}

function injectManualBgEntry(bgVal) {
  const sgv = parseFloat(bgVal);
  if (isNaN(sgv) || sgv < 1.5 || sgv > 30.0) {
    showToast('Введите корректное значение сахара (от 1.5 до 30 ммоль/л)', 'warn');
    return;
  }

  const now = Date.now();
  appState.cgmEntries.push({
    timestamp: now,
    sgv: Number(sgv.toFixed(1)),
    direction: 'Flat',
    trendRate: 0
  });

  if (appState.cgmEntries.length > 288) appState.cgmEntries.shift();

  saveState();
  updateDashboardUI();
  showToast(`Записан замер сахара: ${sgv} ммоль/л`);
  const input = document.getElementById('manualBgInput');
  if (input) input.value = '';
}

// ============================================================================
// НАВИГАЦИЯ И ИНИЦИАЛИЗАЦИЯ
// ============================================================================

function switchTab(tabId) {
  const tabs = ['dashboardTab', 'calculatorTab', 'nutritionTab', 'profileTab', 'settingsTab'];
  tabs.forEach(t => {
    const el = document.getElementById(t);
    const navBtn = document.getElementById('btn_' + t);
    if (el) el.classList.add('hidden');
    if (navBtn) {
      navBtn.classList.remove('text-slate-100', 'bg-slate-800');
      navBtn.classList.add('text-slate-400');
    }
  });

  const activeEl = document.getElementById(tabId);
  const activeBtn = document.getElementById('btn_' + tabId);
  if (activeEl) activeEl.classList.remove('hidden');
  if (activeBtn) {
    activeBtn.classList.add('text-slate-100', 'bg-slate-800');
    activeBtn.classList.remove('text-slate-400');
  }

  if (tabId === 'dashboardTab') {
    setTimeout(initOrUpdateChart, 50);
  } else if (tabId === 'nutritionTab') {
    updateNutritionDailySummary();
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastNotification');
  if (!container) return;
  container.textContent = message;
  container.className = 'fixed bottom-20 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl shadow-lg z-50 text-xs font-medium backdrop-blur-md transition-all duration-300 ' +
    (type === 'warn' ? 'bg-amber-800/90 text-amber-100 border border-amber-600/50' : 'bg-slate-800/95 text-slate-100 border border-slate-700');
  container.classList.remove('opacity-0', 'pointer-events-none');
  setTimeout(() => {
    container.classList.add('opacity-0', 'pointer-events-none');
  }, 3500);
}

function bindFormValues() {
  const p = appState.profile;
  const s = appState.settings;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

  setVal('profWeight', p.weight);
  setVal('profHeight', p.height);
  setVal('profAge', p.age);
  setVal('profGender', p.gender);
  setVal('profTdd', p.tdd);
  setVal('profCarbsInXe', p.carbsInXe);
  setVal('profFastInsulin', p.fastInsulin);
  setVal('profBasalInsulin', p.basalInsulin);
  setVal('profDia', p.diaHours);
  setVal('profTargetLow', p.targetBgLow);
  setVal('profTargetHigh', p.targetBgHigh);
  setVal('profTargetMid', p.targetBgMid);
  setVal('profIcrMorning', p.schedules.morning.icr);
  setVal('profIcrLunch', p.schedules.lunch.icr);
  setVal('profIcrDinner', p.schedules.dinner.icr);
  setVal('profIcrNight', p.schedules.night.icr);

  setVal('dashNsUrl', s.nightscoutUrl);
  setVal('dashNsToken', s.nightscoutToken);
  setVal('settingsNsUrl', s.nightscoutUrl);
  setVal('settingsNsToken', s.nightscoutToken);
}

function saveProfileFromForm() {
  const getVal = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) || fallback : fallback;
  };

  const p = appState.profile;
  p.weight = getVal('profWeight', 70);
  p.height = getVal('profHeight', 175);
  p.age = getVal('profAge', 28);
  p.gender = document.getElementById('profGender')?.value || 'male';
  p.tdd = getVal('profTdd', 40);
  p.carbsInXe = getVal('profCarbsInXe', 12);
  p.fastInsulin = document.getElementById('profFastInsulin')?.value || 'Novorapid';
  p.basalInsulin = document.getElementById('profBasalInsulin')?.value || 'Lantus';
  p.diaHours = getVal('profDia', 4.0);
  p.targetBgLow = getVal('profTargetLow', 4.0);
  p.targetBgHigh = getVal('profTargetHigh', 7.8);
  p.targetBgMid = getVal('profTargetMid', 5.5);

  p.isf = Number((100 / p.tdd).toFixed(2));
  p.icr = Number((500 / p.tdd).toFixed(1));

  p.schedules.morning.icr = getVal('profIcrMorning', 9.0);
  p.schedules.lunch.icr = getVal('profIcrLunch', 12.0);
  p.schedules.dinner.icr = getVal('profIcrDinner', 11.0);
  p.schedules.night.icr = getVal('profIcrNight', 14.0);

  saveState();
  updateDashboardUI();
  showToast('Профиль сохранен. Коэффициенты обновлены!');
}

window.addEventListener('DOMContentLoaded', () => {
  checkUrlForGuestMode();
  bindFormValues();
  renderFoodDatabaseList();
  updateDashboardUI();
  updateSyncUI();

  if (appState.settings.nightscoutUrl) {
    syncNightscoutData(false);
  }

  syncTimer = setInterval(() => {
    if (appState.settings.nightscoutUrl) {
      syncNightscoutData(false);
    }
  }, 30000);
});
