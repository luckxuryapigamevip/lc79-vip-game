/**
 * ==========================================================
 * VIP GOD TIER V23 — THUẬT TOÁN HỌC THẬT (KHÔNG RANDOM)
 * ==========================================================
 * Cài:
 *   npm init -y
 *   npm i express axios cors
 *   node server.js
 *
 * Thuật toán thật:
 *   1. Variable-Order Markov (VOM)  — bậc 1→7, tự chọn
 *   2. PPM (Prediction by Partial Matching) — nén dữ liệu
 *   3. Bayesian smoothing — tránh overfit
 *   4. CUSUM change-point — phát hiện cầu gãy
 *   5. Ensemble có trọng số theo hiệu suất THẬT
 *
 * KHÔNG có:
 *   - Random
 *   - Pattern cứng (2-2, 3-3...)
 *   - Gán điểm bừa
 *
 * Có:
 *   - Học từ dữ liệu thật
 *   - Tự thích nghi
 *   - Backtest chứng minh
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
    tx: path.join(__dirname, 'v23_tx.json'),
    md5: path.join(__dirname, 'v23_md5.json')
  },
  MODEL: {
    maxOrder: 7,           // Markov bậc tối đa
    minSamplesPerOrder: 5, // Cần ít nhất 5 mẫu để tin bậc đó
    laplaceAlpha: 1,       // Bayesian smoothing
    cusumThreshold: 5,     // Ngưỡng phát hiện cầu gãy
    performanceWindow: 50, // Cửa sổ đánh giá hiệu suất model
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
    // Lưu hiệu suất từng model để ensemble có trọng số
    modelPerf: {
      vom: { w: 0, l: 0 },
      ppm: { w: 0, l: 0 },
      cusum: { w: 0, l: 0 }
    },
    // Log dự đoán gần đây để đánh giá
    predLog: []
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
// ★ THUẬT TOÁN 1: VARIABLE-ORDER MARKOV (VOM)
// ==========================================================
/**
 * Học xác suất P(next | context) cho MỌI bậc từ 1 đến maxOrder.
 * Tự chọn bậc cao nhất có đủ mẫu (>= minSamplesPerOrder).
 * Dùng Bayesian smoothing (Laplace) để tránh 0.
 *
 * Trả về: { probT: [0,1], order: int, samples: int }
 */
function vomPredict(history, maxOrder = CONFIG.MODEL.maxOrder) {
  if (!history || history.length < 3) return { probT: 0.5, order: 0, samples: 0 };

  // Duyệt bậc cao → thấp, chọn bậc đầu tiên có đủ mẫu
  for (let order = maxOrder; order >= 1; order--) {
    if (history.length <= order) continue;

    const context = history.slice(-order).join('');
    let countT = 0, countX = 0;

    // Duyệt toàn bộ lịch sử, tìm context giống
    for (let i = 0; i < history.length - order; i++) {
      if (history.slice(i, i + order).join('') === context) {
        if (history[i + order] === 'T') countT++;
        else countX++;
      }
    }

    const total = countT + countX;
    if (total >= CONFIG.MODEL.minSamplesPerOrder) {
      // Laplace smoothing: (count + alpha) / (total + 2*alpha)
      const alpha = CONFIG.MODEL.laplaceAlpha;
      const probT = (countT + alpha) / (total + 2 * alpha);
      return { probT, order, samples: total, context };
    }
  }

  return { probT: 0.5, order: 0, samples: 0 };
}

// ==========================================================
// ★ THUẬT TOÁN 2: PPM (Prediction by Partial Matching)
// ==========================================================
/**
 * PPM hoạt động như sau:
 *   - Thử match context dài nhất có thể
 *   - Nếu không tìm thấy → escape, giảm độ dài context
 *   - Dùng phương pháp "escape" của PPM-C (Method C)
 *
 * Đây là thuật toán nén dữ liệu mạnh — dự đoán ký tự tiếp theo tốt hơn Markov thường.
 *
 * Trả về: { probT, escapeProb, matchedOrder }
 */
function ppmPredict(history, maxOrder = CONFIG.MODEL.maxOrder) {
  if (!history || history.length < 3) return { probT: 0.5, matchedOrder: 0 };

  // Xây dựng bảng đếm theo bậc
  const tables = {}; // order -> context -> {T, X}
  for (let order = 1; order <= maxOrder; order++) {
    tables[order] = {};
  }

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

  // PPM escape: duyệt bậc cao → thấp
  let escapeProb = 1.0;
  for (let order = maxOrder; order >= 1; order--) {
    if (history.length < order) continue;

    const ctx = history.slice(-order).join('');
    const t = tables[order][ctx];

    if (!t) continue;

    const total = t.T + t.X;
    if (total === 0) continue;

    // PPM Method C: P(char) = count / (total + unique)
    const unique = (t.T > 0 ? 1 : 0) + (t.X > 0 ? 1 : 0);
    const pT = (t.T / (total + unique)) * escapeProb;
    const pX = (t.X / (total + unique)) * escapeProb;

    // Nếu đủ mạnh → trả về luôn
    if (total >= 3) {
      const probT = pT / (pT + pX + 1e-9);
      return { probT: clamp(probT, 0.01, 0.99), matchedOrder: order, samples: total };
    }

    // Escape: giảm escapeProb cho bậc tiếp theo
    escapeProb *= (unique / (total + unique));
  }

  // Fallback: toàn bộ lịch sử
  const cT = history.filter(x => x === 'T').length;
  return { probT: (cT + 1) / (history.length + 2), matchedOrder: 0 };
}

// ==========================================================
// ★ THUẬT TOÁN 3: CUSUM CHANGE-POINT DETECTION
// ==========================================================
/**
 * CUSUM (Cumulative Sum Control Chart):
 * Phát hiện thay đổi phân phối trong chuỗi.
 * Dùng để biết cầu hiện tại còn ổn định hay đã gãy.
 *
 * Trả về: { changeDetected: bool, strength: 0-1 }
 */
function cusumDetect(history) {
  if (!history || history.length < 10) return { changeDetected: false, strength: 0 };

  // Giả sử mean = 0.5 (T=1, X=0)
  const values = history.map(x => x === 'T' ? 1 : 0);
  const target = 0.5;
  const threshold = CONFIG.MODEL.cusumThreshold;

  let sHi = 0, sLo = 0;
  let maxS = 0;

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
// ★ THUẬT TOÁN 4: ENSEMBLE CÓ TRỌNG SỐ THEO HIỆU SUẤT
// ==========================================================
/**
 * Kết hợp 3 model trên với trọng số = hiệu suất THẬT của chúng.
 * Model nào đoán đúng gần đây → trọng số cao.
 * Model nào sai → trọng số thấp (nhưng không bao giờ = 0).
 *
 * Đây là "online learning" — model tự điều chỉnh.
 */
function ensemblePredict(history, perf) {
  const vom = vomPredict(history);
  const ppm = ppmPredict(history);
  const cusum = cusumDetect(history);

  // Tính trọng số từ hiệu suất gần đây
  const calcWeight = (model) => {
    const total = model.w + model.l;
    if (total < 5) return 1.0; // chưa đủ mẫu → trọng số trung tính
    const wr = model.w / total;
    // Weight = 0.5 + (wr - 0.5) * 2 → [0, 1.5]
    // Model thắng nhiều → weight cao
    return clamp(0.5 + (wr - 0.5) * 2, 0.1, 1.5);
  };

  const wVom = calcWeight(perf.vom);
  const wPpm = calcWeight(perf.ppm);
  const wCusum = calcWeight(perf.cusum);

  // Nếu CUSUM phát hiện cầu gãy → giảm tin tất cả, tăng uncertainty
  let uncertaintyBoost = 0;
  if (cusum.changeDetected) {
    uncertaintyBoost = cusum.strength * 0.3;
  }

  // Tổng hợp
  const totalW = wVom + wPpm + wCusum;
  let probT = (vom.probT * wVom + ppm.probT * wPpm + 0.5 * wCusum) / totalW;

  // Kéo về 0.5 nếu uncertainty cao
  probT = probT * (1 - uncertaintyBoost) + 0.5 * uncertaintyBoost;

  // Confidence dựa trên:
  // - Số mẫu VOM
  // - Số mẫu PPM
  // - Không có change-point
  const samplesFactor = Math.min(1, (vom.samples + (ppm.samples || 0)) / 20);
  const stabilityFactor = 1 - uncertaintyBoost;
  const confidence = samplesFactor * stabilityFactor;

  return {
    probT,
    confidence,
    vom, ppm, cusum,
    weights: { vom: wVom, ppm: wPpm, cusum: wCusum },
    totalSamples: vom.samples + (ppm.samples || 0)
  };
}

// ==========================================================
// DỰ ĐOÁN CUỐI CÙNG
// ==========================================================
function makePrediction(history, perf) {
  if (!history || history.length < CONFIG.MIN_PHIEN) {
    return {
      predict: 'CHỜ', confidence: 0, reason: 'Chưa đủ dữ liệu',
      detail: null
    };
  }

  const result = ensemblePredict(history, perf);
  const edge = Math.abs(result.probT - 0.5);

  // Nếu edge quá nhỏ → không đoán (trung thực, không bừa)
  if (edge < 0.03) {
    return {
      predict: 'CHỜ',
      confidence: 0,
      reason: `Edge ${(edge * 100).toFixed(1)}% quá nhỏ — không đoán`,
      detail: result
    };
  }

  const predict = result.probT > 0.5 ? 'TÀI' : 'XỈU';

  // Confidence = edge * 100 + samples factor
  // Edge 5% → confidence 55%
  // Edge 15% → confidence 65%
  // Edge 30% → confidence 80%
  // Cap ở 80% (không bao giờ tuyên bố > 80% vì không trung thực)
  let confidence = 50 + edge * 200; // edge 0.05 → 60%, 0.15 → 80%
  confidence = confidence * (0.5 + result.confidence * 0.5); // scale theo samples
  confidence = clamp(Math.round(confidence), 0, 80);

  const vomInfo = result.vom.order > 0
    ? `VOM bậc ${result.vom.order} (${result.vom.samples} mẫu)`
    : 'VOM: ít mẫu';
  const ppmInfo = result.ppm.matchedOrder > 0
    ? `PPM bậc ${result.ppm.matchedOrder}`
    : 'PPM: không match';
  const cusumInfo = result.cusum.changeDetected
    ? `⚠️ CUSUM: cầu có thể gãy`
    : 'CUSUM: ổn định';

  return {
    predict,
    confidence,
    reason: `${vomInfo} | ${ppmInfo} | ${cusumInfo}`,
    detail: result
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

        // Cập nhật hiệu suất từng model (dùng để ensemble tính trọng số)
        if (mem.lastModelPerf) {
          for (const [model, pred] of Object.entries(mem.lastModelPerf)) {
            if (pred === null) continue;
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
  const pred = makePrediction(hist, mem.modelPerf);
  mem.lastPhien = cur;
  mem.lastPred = pred.predict !== 'CHỜ' ? pred.predict : null;

  // Lưu dự đoán riêng của từng model để chấm điểm sau
  if (pred.detail) {
    mem.lastModelPerf = {
      vom: pred.detail.vom.probT,
      ppm: pred.detail.ppm.probT,
      cusum: 0.5 // CUSUM không predict trực tiếp
    };
  } else {
    mem.lastModelPerf = null;
  }

  log('MODEL', `[${type}] VOM: P(T)=${(pred.detail?.vom.probT * 100 || 50).toFixed(1)}% | PPM: P(T)=${(pred.detail?.ppm.probT * 100 || 50).toFixed(1)}% | CUSUM: ${pred.detail?.cusum.changeDetected ? 'GÃY' : 'ổn định'}`);
  log('INFO', `[${type}] Dự đoán ${parseFloat(cur) + 1}: ${pred.predict} (${pred.confidence}%)`);

  return {
    phienHienTai: cur,
    phienDuDoan: String(parseFloat(cur) + 1),
    duDoan: pred.predict,
    tiLe: `${pred.confidence}%`,
    liDo: pred.reason,
    chiTiet: pred.detail ? {
      vom: {
        probT: (pred.detail.vom.probT * 100).toFixed(2) + '%',
        order: pred.detail.vom.order,
        samples: pred.detail.vom.samples,
        context: pred.detail.vom.context || null
      },
      ppm: {
        probT: (pred.detail.ppm.probT * 100).toFixed(2) + '%',
        matchedOrder: pred.detail.ppm.matchedOrder,
        samples: pred.detail.ppm.samples || 0
      },
      cusum: {
        changeDetected: pred.detail.cusum.changeDetected,
        strength: (pred.detail.cusum.strength * 100).toFixed(1) + '%'
      },
      weights: pred.detail.weights,
      totalSamples: pred.detail.totalSamples
    } : null,
    xucXac: list[0].dices || [],
    tongDiem: list[0].point || 0,
    hieuSuatModel: {
      vom: `${mem.modelPerf.vom.w}W/${mem.modelPerf.vom.l}L`,
      ppm: `${mem.modelPerf.ppm.w}W/${mem.modelPerf.ppm.l}L`,
      cusum: `${mem.modelPerf.cusum.w}W/${mem.modelPerf.cusum.l}L`
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
  log('INFO', `Backtest V23 ${type} — limit ${limit}`);
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

  // Metrics
  let win = 0, lose = 0, skip = 0;
  const perf = { vom: { w: 0, l: 0 }, ppm: { w: 0, l: 0 }, cusum: { w: 0, l: 0 } };
  const confBuckets = {};

  // Đánh giá riêng từng model
  let vomW = 0, vomL = 0, ppmW = 0, ppmL = 0;

  for (let i = CONFIG.MIN_PHIEN; i < seq.length; i++) {
    const h = seq.slice(0, i);
    const pred = makePrediction(h, perf);

    // Đánh giá từng model độc lập
    const vomR = vomPredict(h);
    const ppmR = ppmPredict(h);
    const actual = seq[i] === 'T' ? 'TÀI' : 'XỈU';

    if (vomR.probT > 0.55) {
      if (vomR.probT > 0.5 === (actual === 'TÀI')) vomW++; else vomL++;
    } else if (vomR.probT < 0.45) {
      if (vomR.probT < 0.5 === (actual === 'XỈU')) vomW++; else vomL++;
    }

    if (ppmR.probT > 0.55) {
      if (ppmR.probT > 0.5 === (actual === 'TÀI')) ppmW++; else ppmL++;
    } else if (ppmR.probT < 0.45) {
      if (ppmR.probT < 0.5 === (actual === 'XỈU')) ppmW++; else ppmL++;
    }

    // Đánh giá ensemble
    if (pred.predict === 'CHỜ') { skip++; continue; }
    const isWin = pred.predict === actual;

    // Cập nhật perf
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

  const confReport = {};
  for (const [k, v] of Object.entries(confBuckets)) {
    const t = v.w + v.l;
    confReport[`${k}-${parseInt(k) + 9}%`] = {
      total: t, win: v.w, lose: v.l,
      winrate: t > 0 ? `${(v.w / t * 100).toFixed(1)}%` : '—'
    };
  }

  return {
    tongPhien: seq.length,
    soLanDuDoan: total,
    soLanBoQua: skip,
    win, lose,
    winrateTong: `${wr}%`,
    // Đánh giá từng model độc lập
    danhGiaModel: {
      vom: {
        win: vomW, lose: vomL,
        winrate: vomW + vomL > 0 ? `${(vomW / (vomW + vomL) * 100).toFixed(2)}%` : '—',
        samples: vomW + vomL
      },
      ppm: {
        win: ppmW, lose: ppmL,
        winrate: ppmW + ppmL > 0 ? `${(ppmW / (ppmW + ppmL) * 100).toFixed(2)}%` : '—',
        samples: ppmW + ppmL
      }
    },
    winrateTheoConfidence: confReport,
    ketLuan: parseFloat(wr) > 55
      ? '⚠️ Có thể có lookahead — kiểm tra lại'
      : parseFloat(wr) >= 48
        ? '✅ ~50% — không có edge, đúng toán học'
        : '❌ < 50% — ngược chiều, thua nhiều hơn'
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
    hieuSuatModel: m.modelPerf,
    data: [...m.history].reverse()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online', version: '23.0.0',
    uptime: process.uptime(),
    tx: { win: memory.tx.totalWin, lose: memory.tx.totalLose, perf: memory.tx.modelPerf },
    md5: { win: memory.md5.totalWin, lose: memory.md5.totalLose, perf: memory.md5.modelPerf }
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
  console.log(C.g + `🔥 V23 — HỌC THẬT — http://localhost:${CONFIG.PORT}`);
  console.log(C.cyan + '=========================================');
  console.log(C.y + 'Thuật toán:');
  console.log(C.r + '  1. Variable-Order Markov (VOM) bậc 1-7');
  console.log('  2. PPM (Prediction by Partial Matching)');
  console.log('  3. CUSUM change-point detection');
  console.log('  4. Ensemble có trọng số theo hiệu suất');
  console.log(C.cyan + '=========================================');
  console.log(C.y + 'Endpoints:');
  console.log(C.r + '  GET  /taixiu            → dự đoán TX');
  console.log('  GET  /md5               → dự đoán MD5');
  console.log('  GET  /backtest?type=tx  → kiểm chứng từng model');
  console.log('  GET  /lstaixiu          → lịch sử + hiệu suất model');
  console.log('  GET  /status            → trạng thái');
  console.log('  POST /reset             → reset');
  console.log(C.cyan + '=========================================' + C.r);
});

process.on('SIGINT', () => {
  log('INFO', 'Tắt server...');
  saveMem('tx'); saveMem('md5');
  server.close(() => process.exit(0));
});
