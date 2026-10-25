/**
 * ==========================================================
 * VIP GOD TIER V25 — FIX "NHẢY TÀI ↔ XỈU"
 * ==========================================================
 * Bug V24: Nhảy đột ngột Tài → Xỉu do:
 *   1. Balance guard kích hoạt khi model ĐANG ĐÚNG
 *   2. Detrend quá mạnh phá dự đoán đúng
 *   3. recentPreds lưu cả guard → dao động
 *
 * Fix V25:
 *   1. Guard chỉ kích hoạt khi model ĐANG SAI (winrate < 40%)
 *   2. Detrend nhẹ hơn + chỉ áp dụng khi thật sự cần
 *   3. Smooth dự đoán — không nhảy nếu chưa đủ mạnh
 *   4. Track "confidence trend" — nếu confidence giảm mạnh → giữ dự đoán cũ
 *   5. Bỏ guard force khi model đang winrate > 50%
 *   6. Thêm "sticky prediction" — giữ dự đoán cũ nếu edge mới quá yếu
 * ==========================================================
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ==========================================================
// CONFIG
// ==========================================================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API: {
    tx: 'https://wtx.tele68.com/v1/tx/sessions',
    md5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions'
  },
  MIN_PHIEN: 20,
  MAX_STORE: 300,
  TIMEOUT: 15000,
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  FILE: {
    tx: path.join(__dirname, 'v25_tx.json'),
    md5: path.join(__dirname, 'v25_md5.json')
  },
  MODEL: {
    maxOrder: 7,
    minSamplesPerOrder: 5,
    laplaceAlpha: 1,
    cusumThreshold: 5
  },
  // ★ FIX V25: Bias control nhẹ hơn, thông minh hơn
  BIAS_CONTROL: {
    DETREND_STRENGTH: 0.3,       // Giảm từ 0.7 → 0.3 (nhẹ hơn)
    MIN_EDGE_TO_PREDICT: 0.06,   // 6% edge (thấp hơn V24 8% để không bỏ lỡ tín hiệu tốt)
    // Guard chỉ kích hoạt khi model THẬT SỰ bias
    GUARD_MIN_STREAK: 7,         // 7 phiên cùng phía (tăng từ 5)
    GUARD_ONLY_IF_SLOW: true,    // Chỉ guard khi winrate < 45%
    GUARD_MIN_WINRATE: 0.45,
    // Sticky: giữ dự đoán cũ nếu edge mới quá yếu
    STICKY_EDGE_THRESHOLD: 0.04, // Edge < 4% → giữ dự đoán cũ
    STICKY_MAX_AGE: 3,           // Tối đa 3 phiên sticky
    // Smooth: không nhảy nếu chênh lệch confidence < threshold
    SMOOTH_THRESHOLD: 10         // 10% chênh lệch confidence
  }
};

// ==========================================================
// LOG
// ==========================================================
const C = { r: '\x1b[0m', red: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', gray: '\x1b[90m', m: '\x1b[35m' };
function log(lv, msg) {
  const ts = new Date().toISOString();
  const col = { INFO: C.c, WARN: C.y, ERROR: C.red, DEBUG: C.gray, WIN: C.g, LOSE: C.red, MODEL: C.m }[lv] || C.r;
  console.log(`${C.gray}[${ts}]${C.r} ${col}[${lv}]${C.r} ${msg}`);
}

// ==========================================================
// PERSISTENCE
// ==========================================================
function defMem() {
  return {
    lastPhien: null, lastPred: null, lastConf: null,
    history: [], totalWin: 0, totalLose: 0,
    modelPerf: {
      vom: { w: 0, l: 0 },
      ppm: { w: 0, l: 0 }
    },
    predDistribution: { T: 0, X: 0 },
    recentPreds: [],
    // ★ FIX: Track prediction history chi tiết
    predHistory: [],       // { phien, pred, conf, edge, guardApplied }
    stickyInfo: { pred: null, age: 0, since: null },
    biasWarning: false
  };
}

function loadMem(type) {
  try {
    if (fs.existsSync(CONFIG.FILE[type])) {
      return { ...defMem(), ...JSON.parse(fs.readFileSync(CONFIG.FILE[type], 'utf8')) };
    }
  } catch (e) { log('ERROR', e.message); }
  return defMem();
}
function saveMem(type) {
  try { fs.writeFileSync(CONFIG.FILE[type], JSON.stringify(memory[type], null, 2)); }
  catch (e) { log('ERROR', e.message); }
}

const memory = { tx: loadMem('tx'), md5: loadMem('md5') };

// ==========================================================
// TIỆN ÍCH
// ==========================================================
const toSeq = (list) => list.map(x => x.resultTruyenThong === 'TAI' ? 'T' : 'X').reverse();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ==========================================================
// VOM
// ==========================================================
function vomPredict(history, maxOrder = CONFIG.MODEL.maxOrder) {
  if (!history || history.length < 3) return { probT: 0.5, order: 0, samples: 0 };

  for (let order = maxOrder; order >= 1; order--) {
    if (history.length <= order) continue;

    const context = history.slice(-order).join('');
    let countT = 0, countX = 0;

    for (let i = 0; i < history.length - order; i++) {
      if (history.slice(i, i + order).join('') === context) {
        if (history[i + order] === 'T') countT++;
        else countX++;
      }
    }

    const total = countT + countX;
    if (total >= CONFIG.MODEL.minSamplesPerOrder) {
      const alpha = CONFIG.MODEL.laplaceAlpha;
      const probT = (countT + alpha) / (total + 2 * alpha);
      return { probT, order, samples: total, context };
    }
  }

  return { probT: 0.5, order: 0, samples: 0 };
}

// ==========================================================
// PPM
// ==========================================================
function ppmPredict(history, maxOrder = CONFIG.MODEL.maxOrder) {
  if (!history || history.length < 3) return { probT: 0.5, matchedOrder: 0, samples: 0 };

  const tables = {};
  for (let order = 1; order <= maxOrder; order++) tables[order] = {};

  for (let i = 0; i < history.length - 1; i++) {
    for (let order = 1; order <= maxOrder; order++) {
      if (i < order) continue;
      const ctx = history.slice(i - order, i).join('');
      const next = history[i];
      if (!tables[order][ctx]) tables[order][ctx] = { T: 0, X: 0 };
      if (next === 'T') tables[order][ctx].T++;
      else tables[order][ctx].X++;
    }
  }

  let escapeProb = 1.0;
  for (let order = maxOrder; order >= 1; order--) {
    if (history.length < order) continue;
    const ctx = history.slice(-order).join('');
    const t = tables[order][ctx];
    if (!t) continue;

    const total = t.T + t.X;
    if (total === 0) continue;

    const unique = (t.T > 0 ? 1 : 0) + (t.X > 0 ? 1 : 0);
    const pT = (t.T / (total + unique)) * escapeProb;
    const pX = (t.X / (total + unique)) * escapeProb;

    if (total >= 3) {
      const probT = pT / (pT + pX + 1e-9);
      return { probT: clamp(probT, 0.01, 0.99), matchedOrder: order, samples: total };
    }

    escapeProb *= (unique / (total + unique));
  }

  const cT = history.filter(x => x === 'T').length;
  return { probT: (cT + 1) / (history.length + 2), matchedOrder: 0, samples: 0 };
}

// ==========================================================
// CUSUM
// ==========================================================
function cusumDetect(history) {
  if (!history || history.length < 10) return { changeDetected: false, strength: 0 };
  const values = history.map(x => x === 'T' ? 1 : 0);
  const target = 0.5;
  const threshold = CONFIG.MODEL.cusumThreshold;

  let sHi = 0, sLo = 0, maxS = 0;
  for (const v of values) {
    sHi = Math.max(0, sHi + (v - target - 0.1));
    sLo = Math.max(0, sLo + (target - v - 0.1));
    maxS = Math.max(maxS, sHi, sLo);
  }
  return {
    changeDetected: maxS > threshold,
    strength: clamp(maxS / (threshold * 2), 0, 1),
    sHi, sLo
  };
}

// ==========================================================
// ★ FIX 1: DETREND NHẸ HƠN
// ==========================================================
/**
 * V24: detrend strength = 0.7 → phá dự đoán đúng
 * V25: detrend strength = 0.3 → nhẹ hơn
 *      + chỉ áp dụng nếu bias thật sự mạnh (> 15%)
 */
function detrend(probT, history) {
  if (!history || history.length < 10) return probT;

  const cT = history.filter(x => x === 'T').length;
  const histBias = cT / history.length - 0.5;

  // ★ FIX: Chỉ detrend khi bias thật sự lớn
  if (Math.abs(histBias) < 0.15) return probT;

  const strength = CONFIG.BIAS_CONTROL.DETREND_STRENGTH;
  const adjusted = probT - histBias * strength;

  return clamp(adjusted, 0.01, 0.99);
}

// ==========================================================
// ENSEMBLE
// ==========================================================
function ensemblePredict(history, perf) {
  const vom = vomPredict(history);
  const ppm = ppmPredict(history);
  const cusum = cusumDetect(history);

  const calcWeight = (model) => {
    const total = model.w + model.l;
    if (total < 5) return 1.0;
    const wr = model.w / total;
    return clamp(0.5 + (wr - 0.5) * 2, 0.1, 1.5);
  };

  const wVom = calcWeight(perf.vom);
  const wPpm = calcWeight(perf.ppm);
  const totalW = wVom + wPpm;

  let probT = (vom.probT * wVom + ppm.probT * wPpm) / totalW;
  const probTRaw = probT;

  probT = detrend(probT, history);

  let uncertaintyBoost = 0;
  if (cusum.changeDetected) uncertaintyBoost = cusum.strength * 0.3;
  probT = probT * (1 - uncertaintyBoost) + 0.5 * uncertaintyBoost;

  const samplesFactor = Math.min(1, (vom.samples + ppm.samples) / 20);
  const stabilityFactor = 1 - uncertaintyBoost;
  const confidence = samplesFactor * stabilityFactor;

  return {
    probT, probTRaw, confidence,
    vom, ppm, cusum,
    weights: { vom: wVom, ppm: wPpm },
    totalSamples: vom.samples + ppm.samples
  };
}

// ==========================================================
// ★ FIX 2: BALANCE GUARD THÔNG MINH
// ==========================================================
/**
 * Guard chỉ kích hoạt khi:
 *   - 7 phiên cùng phía (không phải 5)
 *   - VÀ model đang winrate < 45% (model đang sai mới cần can thiệp)
 *   - VÀ không phải đang sticky
 *
 * → Không phá dự đoán đúng nữa
 */
function smartBalanceGuard(recentPreds, modelPerf) {
  const minStreak = CONFIG.BIAS_CONTROL.GUARD_MIN_STREAK;

  if (!recentPreds || recentPreds.length < minStreak) {
    return { force: null, reason: '', check: 'not-enough-preds' };
  }

  const lastN = recentPreds.slice(-minStreak);
  const allT = lastN.every(p => p === 'TÀI');
  const allX = lastN.every(p => p === 'XỈU');

  if (!allT && !allX) {
    return { force: null, reason: '', check: 'mixed' };
  }

  // ★ FIX: Chỉ guard nếu model đang thua nhiều
  const totalW = modelPerf.vom.w + modelPerf.ppm.w;
  const totalL = modelPerf.vom.l + modelPerf.ppm.l;
  const total = totalW + totalL;
  const wr = total > 0 ? totalW / total : 0.5;

  if (CONFIG.BIAS_CONTROL.GUARD_ONLY_IF_SLOW && wr > CONFIG.BIAS_CONTROL.GUARD_MIN_WINRATE) {
    return {
      force: null,
      reason: `Model winrate ${(wr * 100).toFixed(1)}% > 45% — không cần guard`,
      check: 'model-winning'
    };
  }

  if (allT) {
    return {
      force: 'XỈU',
      reason: `⚠️ ${minStreak} phiên toàn TÀI + winrate ${(wr * 100).toFixed(0)}% → force XỈU`,
      check: 'forced'
    };
  }
  return {
    force: 'TÀI',
    reason: `⚠️ ${minStreak} phiên toàn XỈU + winrate ${(wr * 100).toFixed(0)}% → force TÀI`,
    check: 'forced'
  };
}

// ==========================================================
// ★ FIX 3: STICKY PREDICTION
// ==========================================================
/**
 * Nếu dự đoán mới ngược với dự đoán cũ, NHƯNG edge mới quá yếu
 * → giữ dự đoán cũ (sticky).
 *
 * Ví dụ:
 *   - Phiên trước dự đoán TÀI (edge 10%)
 *   - Phiên này model ra edge 3% (yếu) cho XỈU
 *   → Giữ TÀI, không nhảy
 *
 * Chỉ nhảy khi edge mới đủ mạnh (>= STICKY_EDGE_THRESHOLD).
 */
function applySticky(newPred, newEdge, newConf, stickyInfo) {
  if (!stickyInfo.pred || stickyInfo.age >= CONFIG.BIAS_CONTROL.STICKY_MAX_AGE) {
    // Sticky hết hạn → dùng dự đoán mới
    return {
      pred: newPred,
      stickyApplied: false,
      reason: '',
      newSticky: { pred: newPred, age: 0, since: Date.now() }
    };
  }

  // Nếu dự đoán mới cùng hướng → reset sticky
  if (newPred === stickyInfo.pred) {
    return {
      pred: newPred,
      stickyApplied: false,
      reason: '',
      newSticky: { pred: newPred, age: 0, since: Date.now() }
    };
  }

  // Dự đoán mới ngược hướng — kiểm tra edge
  if (newEdge < CONFIG.BIAS_CONTROL.STICKY_EDGE_THRESHOLD) {
    // Edge yếu → giữ dự đoán cũ
    return {
      pred: stickyInfo.pred,
      stickyApplied: true,
      reason: `Sticky: edge mới ${(newEdge * 100).toFixed(1)}% < ${CONFIG.BIAS_CONTROL.STICKY_EDGE_THRESHOLD * 100}% → giữ ${stickyInfo.pred}`,
      newSticky: { pred: stickyInfo.pred, age: stickyInfo.age + 1, since: stickyInfo.since }
    };
  }

  // Edge đủ mạnh → nhảy
  return {
    pred: newPred,
    stickyApplied: false,
    reason: `Nhảy do edge ${(newEdge * 100).toFixed(1)}% đủ mạnh`,
    newSticky: { pred: newPred, age: 0, since: Date.now() }
  };
}

// ==========================================================
// ★ FIX 4: SMOOTH PREDICTION
// ==========================================================
/**
 * Nếu confidence thay đổi < SMOOTH_THRESHOLD (10%), không nhảy.
 * Ví dụ: phiên trước conf 65% TÀI, phiên này conf 68% XỈU
 * → chênh 3% < 10% → không nhảy (giữ TÀI)
 *
 * Nhưng nếu phiên này conf 80% XỈU (chênh 15%) → nhảy.
 */
function applySmooth(newPred, newConf, lastPred, lastConf) {
  if (!lastPred || !lastConf) {
    return { pred: newPred, smoothApplied: false, reason: '' };
  }

  if (newPred === lastPred) {
    return { pred: newPred, smoothApplied: false, reason: '' };
  }

  const confDiff = Math.abs(newConf - lastConf);
  if (confDiff < CONFIG.BIAS_CONTROL.SMOOTH_THRESHOLD) {
    return {
      pred: lastPred,
      smoothApplied: true,
      reason: `Smooth: chênh conf ${confDiff.toFixed(1)}% < ${CONFIG.BIAS_CONTROL.SMOOTH_THRESHOLD}% → giữ ${lastPred}`
    };
  }

  return { pred: newPred, smoothApplied: false, reason: '' };
}

// ==========================================================
// ★ FIX 5: MAKE PREDICTION (kết hợp tất cả fix)
// ==========================================================
function makePrediction(history, perf, mem) {
  if (!history || history.length < CONFIG.MIN_PHIEN) {
    return {
      predict: 'CHỜ', confidence: 0,
      reason: 'Chưa đủ dữ liệu', detail: null
    };
  }

  const result = ensemblePredict(history, perf);
  const edge = Math.abs(result.probT - 0.5);

  // Edge floor
  if (edge < CONFIG.BIAS_CONTROL.MIN_EDGE_TO_PREDICT) {
    // ★ FIX: Nếu đang có sticky → trả về sticky với conf thấp
    if (mem.stickyInfo.pred && mem.stickyInfo.age < CONFIG.BIAS_CONTROL.STICKY_MAX_AGE) {
      return {
        predict: mem.stickyInfo.pred,
        confidence: 50,
        reason: `Edge ${(edge * 100).toFixed(1)}% yếu → giữ sticky ${mem.stickyInfo.pred}`,
        detail: result,
        stickyApplied: true,
        smoothApplied: false
      };
    }
    return {
      predict: 'CHỜ',
      confidence: 0,
      reason: `Edge ${(edge * 100).toFixed(1)}% < ${CONFIG.BIAS_CONTROL.MIN_EDGE_TO_PREDICT * 100}% — không đoán`,
      detail: result
    };
  }

  let predict = result.probT > 0.5 ? 'TÀI' : 'XỈU';

  // Confidence
  let confidence = 50 + edge * 200;
  confidence = confidence * (0.5 + result.confidence * 0.5);
  confidence = clamp(Math.round(confidence), 0, 80);

  // ★ FIX 1: Smart balance guard
  const guard = smartBalanceGuard(mem.recentPreds, perf);
  let guardApplied = false;
  if (guard.force && guard.force !== predict && guard.check === 'forced') {
    predict = guard.force;
    guardApplied = true;
  }

  // ★ FIX 2: Sticky
  const stickyResult = applySticky(predict, edge, confidence, mem.stickyInfo);
  let stickyApplied = false;
  if (stickyResult.stickyApplied) {
    predict = stickyResult.pred;
    stickyApplied = true;
  }

  // ★ FIX 3: Smooth
  const smoothResult = applySmooth(predict, confidence, mem.lastPred, mem.lastConf);
  let smoothApplied = false;
  if (smoothResult.smoothApplied) {
    predict = smoothResult.pred;
    smoothApplied = true;
  }

  const reasons = [];
  if (result.vom.order > 0) reasons.push(`VOM b${result.vom.order} (${result.vom.samples}m)`);
  else reasons.push('VOM ít mẫu');
  if (result.ppm.matchedOrder > 0) reasons.push(`PPM b${result.ppm.matchedOrder}`);
  if (result.cusum.changeDetected) reasons.push('CUSUM gãy');
  if (guardApplied) reasons.push(guard.reason);
  if (stickyApplied) reasons.push(stickyResult.reason);
  if (smoothApplied) reasons.push(smoothResult.reason);

  return {
    predict,
    confidence,
    reason: reasons.join(' | '),
    detail: result,
    guardApplied,
    stickyApplied,
    smoothApplied,
    edge,
    newSticky: stickyResult.newSticky
  };
}

// ==========================================================
// FETCH
// ==========================================================
async function fetchData(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await axios.get(url, {
        headers: { 'User-Agent': CONFIG.UA, 'Accept': 'application/json' },
        timeout: CONFIG.TIMEOUT
      });
      if (r.status === 200 && r.data) return r.data;
    } catch (e) {
      log('ERROR', `Fetch lần ${i + 1}: ${e.message}`);
      if (i === retries - 1) return null;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

// ==========================================================
// PROCESS
// ==========================================================
async function processGame(type) {
  const data = await fetchData(CONFIG.API[type]);
  if (!data?.list?.length) throw new Error('Không lấy được dữ liệu');

  const list = data.list;
  const cur = String(list[0].id);
  const hist = toSeq(list);
  const mem = memory[type];

  // Chấm điểm phiên trước
  if (mem.lastPhien && mem.lastPred) {
    if (parseFloat(cur) > parseFloat(mem.lastPhien)) {
      const obj = list.find(x => String(x.id) === mem.lastPhien);
      if (obj) {
        const actual = obj.resultTruyenThong === 'TAI' ? 'TÀI' : 'XỈU';
        const isWin = actual === mem.lastPred;

        mem.history.push({
          phien: mem.lastPhien, duDoan: mem.lastPred, ketQua: actual,
          status: isWin ? 'WIN' : 'LOSE', conf: mem.lastConf, ts: Date.now()
        });
        if (isWin) mem.totalWin++; else mem.totalLose++;
        if (mem.history.length > CONFIG.MAX_STORE) mem.history.shift();

        if (mem.lastModelPerf) {
          for (const [model, pred] of Object.entries(mem.lastModelPerf)) {
            if (pred === null || !mem.modelPerf[model]) continue;
            const modelPred = pred > 0.5 ? 'TÀI' : 'XỈU';
            if (modelPred === actual) mem.modelPerf[model].w++;
            else mem.modelPerf[model].l++;
          }
        }

        saveMem(type);
        log(isWin ? 'WIN' : 'LOSE', `[${type}] ${mem.lastPhien}: ${mem.lastPred} vs ${actual} → ${isWin ? '✅' : '❌'} (${mem.lastConf}%)`);
      }
    }
  }

  // Dự đoán
  const pred = makePrediction(hist, mem.modelPerf, mem);
  mem.lastPhien = cur;
  mem.lastPred = pred.predict !== 'CHỜ' ? pred.predict : null;
  mem.lastConf = pred.predict !== 'CHỜ' ? pred.confidence : null;

  // Update sticky
  if (pred.newSticky) {
    mem.stickyInfo = pred.newSticky;
  }

  // Log prediction
  if (pred.predict !== 'CHỜ') {
    mem.predDistribution[pred.predict === 'TÀI' ? 'T' : 'X']++;
    mem.recentPreds.push(pred.predict);
    if (mem.recentPreds.length > 20) mem.recentPreds.shift();
    mem.predHistory.push({
      phien: cur, pred: pred.predict, conf: pred.confidence,
      edge: pred.edge, guardApplied: pred.guardApplied,
      stickyApplied: pred.stickyApplied, smoothApplied: pred.smoothApplied,
      ts: Date.now()
    });
    if (mem.predHistory.length > 100) mem.predHistory.shift();
  }

  // Bias warning
  const totalPreds = mem.predDistribution.T + mem.predDistribution.X;
  if (totalPreds > 10) {
    const tRatio = mem.predDistribution.T / totalPreds;
    if (tRatio > 0.7 || tRatio < 0.3) {
      mem.biasWarning = true;
      log('WARN', `[${type}] ⚠️ BIAS: ${(tRatio * 100).toFixed(0)}% TÀI`);
    } else {
      mem.biasWarning = false;
    }
  }

  if (pred.detail) {
    mem.lastModelPerf = {
      vom: pred.detail.vom.probT,
      ppm: pred.detail.ppm.probT
    };
  } else {
    mem.lastModelPerf = null;
  }

  // ★ FIX: Log rõ prediction flow
  const flags = [];
  if (pred.guardApplied) flags.push('GUARD');
  if (pred.stickyApplied) flags.push('STICKY');
  if (pred.smoothApplied) flags.push('SMOOTH');
  const flagStr = flags.length > 0 ? ` [${flags.join('+')}]` : '';

  log('MODEL', `[${type}] VOM: P(T)=${((pred.detail?.vom.probT || 0.5) * 100).toFixed(1)}% | PPM: P(T)=${((pred.detail?.ppm.probT || 0.5) * 100).toFixed(1)}% | Edge=${((pred.edge || 0) * 100).toFixed(1)}%`);
  log('INFO', `[${type}] Dự đoán ${parseFloat(cur) + 1}: ${pred.predict} (${pred.confidence}%)${flagStr}`);

  return {
    phienHienTai: cur,
    phienDuDoan: String(parseFloat(cur) + 1),
    duDoan: pred.predict,
    tiLe: `${pred.confidence}%`,
    liDo: pred.reason,
    flags: {
      guard: pred.guardApplied || false,
      sticky: pred.stickyApplied || false,
      smooth: pred.smoothApplied || false
    },
    edge: pred.edge ? (pred.edge * 100).toFixed(2) + '%' : null,
    chiTiet: pred.detail ? {
      vom: {
        probT: (pred.detail.vom.probT * 100).toFixed(2) + '%',
        order: pred.detail.vom.order,
        samples: pred.detail.vom.samples
      },
      ppm: {
        probT: (pred.detail.ppm.probT * 100).toFixed(2) + '%',
        matchedOrder: pred.detail.ppm.matchedOrder
      },
      probTRaw: (pred.detail.probTRaw * 100).toFixed(2) + '%',
      probTDetrended: (pred.detail.probT * 100).toFixed(2) + '%',
      cusum: {
        changeDetected: pred.detail.cusum.changeDetected,
        strength: (pred.detail.cusum.strength * 100).toFixed(1) + '%'
      }
    } : null,
    stickyInfo: mem.stickyInfo,
    predHistory: mem.predHistory.slice(-10).reverse(),
    xucXac: list[0].dices || [],
    tongDiem: list[0].point || 0,
    phanPhoiDuDoan: {
      tai: mem.predDistribution.T,
      xiu: mem.predDistribution.X,
      ratioTai: totalPreds > 0 ? `${(mem.predDistribution.T / totalPreds * 100).toFixed(1)}%` : '—',
      biasWarning: mem.biasWarning
    },
    hieuSuatModel: {
      vom: `${mem.modelPerf.vom.w}W/${mem.modelPerf.vom.l}L`,
      ppm: `${mem.modelPerf.ppm.w}W/${mem.modelPerf.ppm.l}L`
    },
    thongKe: {
      win: mem.totalWin,
      lose: mem.totalLose,
      winrate: mem.totalWin + mem.totalLose > 0
        ? ((mem.totalWin / (mem.totalWin + mem.totalLose)) * 100).toFixed(1) + '%' : '—'
    }
  };
}

// ==========================================================
// BACKTEST
// ==========================================================
async function backtest(type, limit = 800) {
  log('INFO', `Backtest V25 ${type} — limit ${limit}`);
  let all = [], page = 1;
  while (all.length < limit && page <= 15) {
    try {
      const r = await axios.get(CONFIG.API[type], {
        headers: { 'User-Agent': CONFIG.UA },
        params: { page, limit: 100 }, timeout: CONFIG.TIMEOUT
      });
      const l = r.data?.list || [];
      if (!l.length) break;
      all = all.concat(l);
      if (l.length < 100) break;
      page++;
    } catch (e) { break; }
  }
  if (!all.length) throw new Error('Không có dữ liệu');

  all.sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
  const seq = all.map(x => x.resultTruyenThong === 'TAI' ? 'T' : 'X');

  let win = 0, lose = 0, skip = 0;
  let predT = 0, predX = 0;
  let guardCount = 0, stickyCount = 0, smoothCount = 0;
  const perf = { vom: { w: 0, l: 0 }, ppm: { w: 0, l: 0 } };
  const mem = defMem();  // simulate memory
  const confBuckets = {};

  for (let i = CONFIG.MIN_PHIEN; i < seq.length; i++) {
    const h = seq.slice(0, i);
    const pred = makePrediction(h, perf, mem);

    if (pred.predict === 'CHỜ') { skip++; continue; }

    if (pred.guardApplied) guardCount++;
    if (pred.stickyApplied) stickyCount++;
    if (pred.smoothApplied) smoothCount++;

    const actual = seq[i] === 'T' ? 'TÀI' : 'XỈU';
    const isWin = pred.predict === actual;

    if (pred.predict === 'TÀI') predT++;
    else predX++;

    // Update sim memory
    mem.lastPred = pred.predict;
    mem.lastConf = pred.confidence;
    mem.recentPreds.push(pred.predict);
    if (mem.recentPreds.length > 20) mem.recentPreds.shift();
    mem.predDistribution[pred.predict === 'TÀI' ? 'T' : 'X']++;
    if (pred.newSticky) mem.stickyInfo = pred.newSticky;

    // Update perf
    if (pred.detail) {
      const vomP = pred.detail.vom.probT > 0.5 ? 'TÀI' : 'XỈU';
      const ppmP = pred.detail.ppm.probT > 0.5 ? 'TÀI' : 'XỈU';
      if (vomP === actual) perf.vom.w++; else perf.vom.l++;
      if (ppmP === actual) perf.ppm.w++; else perf.ppm.l++;
    }

    if (isWin) win++; else lose++;

    const bucket = String(Math.floor(pred.confidence / 10) * 10);
    if (!confBuckets[bucket]) confBuckets[bucket] = { w: 0, l: 0 };
    if (isWin) confBuckets[bucket].w++;
    else confBuckets[bucket].l++;
  }

  const total = win + lose;
  const wr = total > 0 ? (win / total * 100).toFixed(2) : 0;
  const totalPreds = predT + predX;
  const ratioT = totalPreds > 0 ? (predT / totalPreds * 100).toFixed(1) : 0;

  const confReport = {};
  for (const [k, v] of Object.entries(confBuckets)) {
    const t = v.w + v.l;
    confReport[`${k}-${parseInt(k) + 9}%`] = {
      total: t, win: v.w, lose: v.l,
      winrate: t > 0 ? `${(v.w / t * 100).toFixed(1)}%` : '—'
    };
  }

  const biasWarning = parseFloat(ratioT) > 70 || parseFloat(ratioT) < 30;

  return {
    tongPhien: seq.length,
    soLanDuDoan: total,
    soLanBoQua: skip,
    win, lose,
    winrateTong: `${wr}%`,
    phanPhoiDuDoan: {
      tai: predT,
      xiu: predX,
      ratioTai: `${ratioT}%`,
      canBang: !biasWarning,
      canhBao: biasWarning ? `⚠️ Model lệch (${ratioT}% TÀI)` : '✅ Cân bằng'
    },
    guardTriggers: guardCount,
    stickyApplied: stickyCount,
    smoothApplied: smoothCount,
    danhGiaModel: {
      vom: {
        win: perf.vom.w, lose: perf.vom.l,
        winrate: perf.vom.w + perf.vom.l > 0
          ? `${(perf.vom.w / (perf.vom.w + perf.vom.l) * 100).toFixed(2)}%` : '—'
      },
      ppm: {
        win: perf.ppm.w, lose: perf.ppm.l,
        winrate: perf.ppm.w + perf.ppm.l > 0
          ? `${(perf.ppm.w / (perf.ppm.w + perf.ppm.l) * 100).toFixed(2)}%` : '—'
      }
    },
    winrateTheoConfidence: confReport,
    ketLuan: parseFloat(wr) > 55
      ? '⚠️ Có thể lookahead'
      : parseFloat(wr) >= 48
        ? '✅ ~50% — đúng toán học'
        : '❌ < 50%'
  };
}

// ==========================================================
// EXPRESS
// ==========================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get('/taixiu', async (req, res) => {
  try { res.json({ status: 'success', data: await processGame('tx') }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/md5', async (req, res) => {
  try { res.json({ status: 'success', data: await processGame('md5') }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/lstaixiu', (req, res) => {
  const m = memory.tx;
  res.json({
    status: 'success',
    win: m.totalWin, lose: m.totalLose,
    winrate: m.totalWin + m.totalLose > 0
      ? ((m.totalWin / (m.totalWin + m.totalLose)) * 100).toFixed(1) + '%' : '—',
    phanPhoiDuDoan: m.predDistribution,
    biasWarning: m.biasWarning,
    stickyInfo: m.stickyInfo,
    hieuSuatModel: m.modelPerf,
    predHistory: m.predHistory.slice(-20).reverse(),
    data: [...m.history].reverse()
  });
});

app.get('/lsmd5', (req, res) => {
  const m = memory.md5;
  res.json({
    status: 'success',
    win: m.totalWin, lose: m.totalLose,
    winrate: m.totalWin + m.totalLose > 0
      ? ((m.totalWin / (m.totalWin + m.totalLose)) * 100).toFixed(1) + '%' : '—',
    phanPhoiDuDoan: m.predDistribution,
    biasWarning: m.biasWarning,
    stickyInfo: m.stickyInfo,
    hieuSuatModel: m.modelPerf,
    predHistory: m.predHistory.slice(-20).reverse(),
    data: [...m.history].reverse()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online', version: '25.0.0',
    uptime: process.uptime(),
    tx: { win: memory.tx.totalWin, lose: memory.tx.totalLose, dist: memory.tx.predDistribution },
    md5: { win: memory.md5.totalWin, lose: memory.md5.totalLose, dist: memory.md5.predDistribution }
  });
});

app.get('/backtest', async (req, res) => {
  try {
    const type = req.query.type === 'md5' ? 'md5' : 'tx';
    const limit = parseInt(req.query.limit) || 800;
    const r = await backtest(type, limit);
    res.json({ status: 'success', type, data: r });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.post('/reset', (req, res) => {
  const { type } = req.body;
  if (type === 'tx' || type === 'all') { memory.tx = defMem(); saveMem('tx'); }
  if (type === 'md5' || type === 'all') { memory.md5 = defMem(); saveMem('md5'); }
  res.json({ status: 'success', message: `Reset ${type}` });
});

// ==========================================================
// START
// ==========================================================
const server = app.listen(CONFIG.PORT, () => {
  console.log(C.cyan + '=========================================');
  console.log(C.g + `🔥 V25 — FIX NHẢY — http://localhost:${CONFIG.PORT}`);
  console.log(C.cyan + '=========================================');
  console.log(C.y + 'Fix so với V24:');
  console.log(C.r + '  1. Smart guard — chỉ kích hoạt khi model đang thua');
  console.log('  2. Sticky — giữ dự đoán cũ nếu edge mới yếu');
  console.log('  3. Smooth — không nhảy nếu conf chênh < 10%');
  console.log('  4. Detrend nhẹ hơn — không phá dự đoán đúng');
  console.log('  5. Guard streak tăng 5 → 7');
  console.log(C.cyan + '=========================================');
  console.log(C.y + 'Endpoints:');
  console.log(C.r + '  GET  /taixiu            → dự đoán + flags');
  console.log('  GET  /md5               → MD5');
  console.log('  GET  /backtest?type=tx  → backtest');
  console.log('  GET  /lstaixiu          → lịch sử + pred history');
  console.log('  GET  /status            → status');
  console.log('  POST /reset             → reset');
  console.log(C.cyan + '=========================================' + C.r);
});

process.on('SIGINT', () => {
  log('INFO', 'Tắt server...');
  saveMem('tx'); saveMem('md5');
  server.close(() => process.exit(0));
});
