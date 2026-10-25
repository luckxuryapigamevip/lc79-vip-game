/**
 * ==========================================================
 * VIP GOD TIER V24 — FIX "TOÀN TÀI"
 * ==========================================================
 * Bug V23: probT luôn lệch 1 phía → đoán toàn TÀI
 * Fix V24:
 *   1. Detrend: trừ historical bias khỏi probT
 *   2. Confidence floor: chỉ đoán khi edge >= 8%
 *   3. Balance guard: nếu 5 phiên gần nhất đoán 1 phía → bẻ
 *   4. Balance log: cảnh báo khi model bias
 *   5. Backtest thêm "distribution" — kiểm tra % TÀI/XỈU dự đoán
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
    tx: path.join(__dirname, 'v24_tx.json'),
    md5: path.join(__dirname, 'v24_md5.json')
  },
  MODEL: {
    maxOrder: 7,
    minSamplesPerOrder: 5,
    laplaceAlpha: 1,
    cusumThreshold: 5
  },
  // ★ FIX MỚI: Kiểm soát bias
  BIAS_CONTROL: {
    DETREND_STRENGTH: 0.7,     // 0-1: càng cao càng kéo về 50/50
    MIN_EDGE_TO_PREDICT: 0.08, // 8% edge tối thiểu mới đoán
    MAX_ONE_SIDED_STREAK: 5,   // 5 phiên cùng phía → force bẻ
    BALANCE_WINDOW: 20          // Cửa sổ kiểm tra balance
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
    lastPhien: null, lastPred: null,
    history: [], totalWin: 0, totalLose: 0,
    modelPerf: {
      vom: { w: 0, l: 0 },
      ppm: { w: 0, l: 0 }
    },
    // ★ Track phân phối dự đoán để phát hiện bias
    predDistribution: { T: 0, X: 0 },
    recentPreds: [],  // 10 dự đoán gần nhất
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
// ★ FIX 1: DETREND — Kéo probT về 50/50 nếu lịch sử lệch
// ==========================================================
/**
 * Nếu lịch sử có 60% Tài → model sẽ luôn đoán Tài vì probT > 0.5.
 * Detrend: tính bias lịch sử, trừ khỏi probT.
 *
 * Ví dụ: history 60% Tài, model probT = 0.62
 *   → bias = 0.60 - 0.50 = 0.10
 *   → detrended = 0.62 - 0.10 * 0.7 = 0.55
 *   → vẫn > 0.5 nhưng gần hơn, không bias nặng
 */
function detrend(probT, history) {
  if (!history || history.length < 10) return probT;

  const cT = history.filter(x => x === 'T').length;
  const histBias = cT / history.length - 0.5; // [-0.5, 0.5]

  // Trừ bias * strength
  const strength = CONFIG.BIAS_CONTROL.DETREND_STRENGTH;
  const adjusted = probT - histBias * strength;

  return clamp(adjusted, 0.01, 0.99);
}

// ==========================================================
// VOM (giữ nguyên V23)
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
// PPM (giữ nguyên V23)
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
// CUSUM (giữ nguyên)
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
// ★ FIX 2: ENSEMBLE có DETREND
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

  // ★ FIX: Bỏ 0.5 * wCusum (gây bias TÀI)
  let probT = (vom.probT * wVom + ppm.probT * wPpm) / totalW;

  // ★ FIX: Detrend khỏi historical bias
  const probTRaw = probT;
  probT = detrend(probT, history);

  // Nếu cầu gãy → kéo về 0.5
  let uncertaintyBoost = 0;
  if (cusum.changeDetected) {
    uncertaintyBoost = cusum.strength * 0.4;
  }
  probT = probT * (1 - uncertaintyBoost) + 0.5 * uncertaintyBoost;

  const samplesFactor = Math.min(1, (vom.samples + ppm.samples) / 20);
  const stabilityFactor = 1 - uncertaintyBoost;
  const confidence = samplesFactor * stabilityFactor;

  return {
    probT,
    probTRaw,
    confidence,
    vom, ppm, cusum,
    weights: { vom: wVom, ppm: wPpm },
    totalSamples: vom.samples + ppm.samples
  };
}

// ==========================================================
// ★ FIX 3: BALANCE GUARD — Chống đoán 1 phía
// ==========================================================
/**
 * Nếu 5 dự đoán gần nhất đều TÀI → force XỈU
 * Nếu 5 dự đoán gần nhất đều XỈU → force TÀI
 *
 * Lý do: model bị bias thì phải phá bias, không thể để nó
 * đoán 1 phía mãi được.
 */
function checkBalanceGuard(recentPreds) {
  if (!recentPreds || recentPreds.length < CONFIG.BIAS_CONTROL.MAX_ONE_SIDED_STREAK) {
    return { force: null, reason: '' };
  }

  const last5 = recentPreds.slice(-CONFIG.BIAS_CONTROL.MAX_ONE_SIDED_STREAK);
  const allT = last5.every(p => p === 'TÀI');
  const allX = last5.every(p => p === 'XỈU');

  if (allT) {
    return {
      force: 'XỈU',
      reason: `⚠️ ${CONFIG.BIAS_CONTROL.MAX_ONE_SIDED_STREAK} phiên toàn TÀI — force bẻ XỈU`
    };
  }
  if (allX) {
    return {
      force: 'TÀI',
      reason: `⚠️ ${CONFIG.BIAS_CONTROL.MAX_ONE_SIDED_STREAK} phiên toàn XỈU — force bẻ TÀI`
    };
  }

  return { force: null, reason: '' };
}

// ==========================================================
// ★ FIX 4: DỰ ĐOÁN CUỐI (có balance guard + edge floor)
// ==========================================================
function makePrediction(history, perf, recentPreds) {
  if (!history || history.length < CONFIG.MIN_PHIEN) {
    return {
      predict: 'CHỜ', confidence: 0,
      reason: 'Chưa đủ dữ liệu', detail: null
    };
  }

  const result = ensemblePredict(history, perf);
  const edge = Math.abs(result.probT - 0.5);

  // ★ FIX: Edge floor 8% thay vì 3%
  if (edge < CONFIG.BIAS_CONTROL.MIN_EDGE_TO_PREDICT) {
    return {
      predict: 'CHỜ',
      confidence: 0,
      reason: `Edge ${(edge * 100).toFixed(1)}% < ${CONFIG.BIAS_CONTROL.MIN_EDGE_TO_PREDICT * 100}% — không đoán`,
      detail: result
    };
  }

  let predict = result.probT > 0.5 ? 'TÀI' : 'XỈU';

  // ★ FIX: Balance guard
  const guard = checkBalanceGuard(recentPreds);
  let guardApplied = false;
  if (guard.force && guard.force !== predict) {
    predict = guard.force;
    guardApplied = true;
  }

  // Confidence
  let confidence = 50 + edge * 200;
  confidence = confidence * (0.5 + result.confidence * 0.5);
  confidence = clamp(Math.round(confidence), 0, 80);

  const vomInfo = result.vom.order > 0
    ? `VOM bậc ${result.vom.order} (${result.vom.samples}m)`
    : 'VOM: ít mẫu';
  const ppmInfo = result.ppm.matchedOrder > 0
    ? `PPM bậc ${result.ppm.matchedOrder}`
    : 'PPM: no match';
  const cusumInfo = result.cusum.changeDetected ? 'CUSUM gãy' : 'CUSUM ổn';

  const reasonParts = [vomInfo, ppmInfo, cusumInfo];
  if (guardApplied) reasonParts.push(guard.reason);

  return {
    predict,
    confidence,
    reason: reasonParts.join(' | '),
    detail: result,
    guardApplied
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
          status: isWin ? 'WIN' : 'LOSE', ts: Date.now()
        });
        if (isWin) mem.totalWin++; else mem.totalLose++;
        if (mem.history.length > CONFIG.MAX_STORE) mem.history.shift();

        // Cập nhật perf
        if (mem.lastModelPerf) {
          for (const [model, pred] of Object.entries(mem.lastModelPerf)) {
            if (pred === null || !mem.modelPerf[model]) continue;
            const modelPred = pred > 0.5 ? 'TÀI' : 'XỈU';
            if (modelPred === actual) mem.modelPerf[model].w++;
            else mem.modelPerf[model].l++;
          }
        }

        saveMem(type);
        log(isWin ? 'WIN' : 'LOSE', `[${type}] ${mem.lastPhien}: ${mem.lastPred} vs ${actual} → ${isWin ? '✅' : '❌'}`);
      }
    }
  }

  // Dự đoán
  const pred = makePrediction(hist, mem.modelPerf, mem.recentPreds);
  mem.lastPhien = cur;
  mem.lastPred = pred.predict !== 'CHỜ' ? pred.predict : null;

  // Lưu dự đoán vào distribution
  if (pred.predict !== 'CHỜ') {
    mem.predDistribution[pred.predict === 'TÀI' ? 'T' : 'X']++;
    mem.recentPreds.push(pred.predict);
    if (mem.recentPreds.length > 20) mem.recentPreds.shift();
  }

  // ★ FIX 5: Bias warning
  const totalPreds = mem.predDistribution.T + mem.predDistribution.X;
  if (totalPreds > 10) {
    const tRatio = mem.predDistribution.T / totalPreds;
    if (tRatio > 0.7 || tRatio < 0.3) {
      mem.biasWarning = true;
      log('WARN', `[${type}] ⚠️ BIAS: ${(tRatio * 100).toFixed(0)}% dự đoán là TÀI — model có thể bị lệch`);
    } else {
      mem.biasWarning = false;
    }
  }

  // Lưu model perf
  if (pred.detail) {
    mem.lastModelPerf = {
      vom: pred.detail.vom.probT,
      ppm: pred.detail.ppm.probT
    };
  } else {
    mem.lastModelPerf = null;
  }

  log('MODEL', `[${type}] VOM: P(T)=${((pred.detail?.vom.probT || 0.5) * 100).toFixed(1)}% | PPM: P(T)=${((pred.detail?.ppm.probT || 0.5) * 100).toFixed(1)}% | Detrended P(T)=${((pred.detail?.probT || 0.5) * 100).toFixed(1)}%`);
  log('INFO', `[${type}] Dự đoán ${parseFloat(cur) + 1}: ${pred.predict} (${pred.confidence}%)`);

  return {
    phienHienTai: cur,
    phienDuDoan: String(parseFloat(cur) + 1),
    duDoan: pred.predict,
    tiLe: `${pred.confidence}%`,
    liDo: pred.reason,
    guardApplied: pred.guardApplied || false,
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
// BACKTEST (có kiểm tra distribution)
// ==========================================================
async function backtest(type, limit = 800) {
  log('INFO', `Backtest V24 ${type} — limit ${limit}`);
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
  let guardTriggers = 0;
  const perf = { vom: { w: 0, l: 0 }, ppm: { w: 0, l: 0 } };
  const recentPreds = [];
  const confBuckets = {};

  for (let i = CONFIG.MIN_PHIEN; i < seq.length; i++) {
    const h = seq.slice(0, i);
    const pred = makePrediction(h, perf, recentPreds);

    if (pred.predict === 'CHỜ') { skip++; continue; }
    if (pred.guardApplied) guardTriggers++;

    const actual = seq[i] === 'T' ? 'TÀI' : 'XỈU';
    const isWin = pred.predict === actual;

    if (pred.predict === 'TÀI') predT++;
    else predX++;

    recentPreds.push(pred.predict);
    if (recentPreds.length > 20) recentPreds.shift();

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

  // Kiểm tra bias
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
      canhBao: biasWarning
        ? `⚠️ Model dự đoán lệch (${ratioT}% TÀI) — vẫn còn bias`
        : '✅ Phân phối cân bằng'
    },
    guardTriggers,
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
      ? '⚠️ Có thể lookahead — kiểm tra lại'
      : parseFloat(wr) >= 48
        ? '✅ ~50% — đúng toán học (random)'
        : '❌ < 50% — tệ hơn random'
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
    hieuSuatModel: m.modelPerf,
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
    hieuSuatModel: m.modelPerf,
    data: [...m.history].reverse()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online', version: '24.0.0',
    uptime: process.uptime(),
    tx: { win: memory.tx.totalWin, lose: memory.tx.totalLose, dist: memory.tx.predDistribution, bias: memory.tx.biasWarning },
    md5: { win: memory.md5.totalWin, lose: memory.md5.totalLose, dist: memory.md5.predDistribution, bias: memory.md5.biasWarning }
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
  console.log(C.g + `🔥 V24 — FIX "TOÀN TÀI" — http://localhost:${CONFIG.PORT}`);
  console.log(C.cyan + '=========================================');
  console.log(C.y + 'Fix so với V23:');
  console.log(C.r + '  1. Detrend — kéo probT về 50/50 nếu lịch sử lệch');
  console.log('  2. Edge floor 8% — chỉ đoán khi đủ mạnh');
  console.log('  3. Balance guard — 5 phiên 1 phía → force bẻ');
  console.log('  4. Bias warning — cảnh báo khi model lệch');
  console.log('  5. Bỏ 0.5*wCusum — nguyên nhân gây bias TÀI');
  console.log(C.cyan + '=========================================');
  console.log(C.y + 'Endpoints:');
  console.log(C.r + '  GET  /taixiu            → dự đoán (có kiểm soát bias)');
  console.log('  GET  /md5               → dự đoán MD5');
  console.log('  GET  /backtest?type=tx  → backtest + kiểm tra phân phối');
  console.log('  GET  /lstaixiu          → lịch sử + phân phối');
  console.log('  GET  /status            → trạng thái');
  console.log('  POST /reset             → reset');
  console.log(C.cyan + '=========================================' + C.r);
});

process.on('SIGINT', () => {
  log('INFO', 'Tắt server...');
  saveMem('tx'); saveMem('md5');
  server.close(() => process.exit(0));
});
