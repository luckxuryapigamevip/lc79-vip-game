/**
 * ==========================================================
 * VIP GOD TIER AI - SERVER V20 (FULL - HỌC CẦU ĐÀNG HOÀNG)
 * ==========================================================
 * Cài đặt:
 *   npm init -y
 *   npm i express axios cors
 *   node server.js
 *
 * Endpoints:
 *   GET  /taixiu               → dự đoán TX
 *   GET  /md5                  → dự đoán MD5
 *   GET  /lstaixiu             → lịch sử TX
 *   GET  /lsmd5                → lịch sử MD5
 *   GET  /status               → trạng thái server
 *   GET  /backtest?type=tx     → backtest tổng
 *   GET  /backtest/:layer      → backtest từng tầng
 *   GET  /export?type=tx       → xuất lịch sử JSON
 *   POST /reset                → reset lịch sử
 *
 * Lưu ý khoa học:
 *   Tài Xỉu là sự kiện độc lập. Không có thuật toán nào
 *   dự đoán được. Code này được viết để CHỨNG MINH điều đó
 *   bằng backtest — chứ không phải để thắng bạc.
 * ==========================================================
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ==========================================================
// 1. CẤU HÌNH
// ==========================================================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API: {
    tx: 'https://wtx.tele68.com/v1/tx/sessions',
    md5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions'
  },
  MIN_PHIEN: 20,
  MAX_STORE: 200,
  TIMEOUT: 15000,
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  FILE: {
    tx: path.join(__dirname, 'history_tx.json'),
    md5: path.join(__dirname, 'history_md5.json')
  },
  BANKROLL: {
    initial: 1000,
    baseBet: 10,
    maxBet: 50,
    stopLoss: 300,
    takeProfit: 500,
    kellyFraction: 0.25
  },
  WEIGHTS: {
    streak: 1.0, zigzag: 1.0, pattern: 1.2, matrix: 0.8,
    dice: 0.6, balance: 1.0, fibonacci: 0.5, markov: 1.0,
    rhythm: 0.9, entropy: 0.7, learner: 2.0  // learner weight cao nhất
  },
  LEARNER: {
    minSamples: 3,
    patternLength: 5,
    decayFactor: 0.95,
    maxPatterns: 5000
  },
  SIGNAL: {
    minToPredict: 0.03,
    maxConfidence: 85,
    minConfidence: 50
  }
};

// ==========================================================
// 2. LOG
// ==========================================================
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(level, msg) {
  const ts = new Date().toISOString();
  const color = {
    INFO: COLORS.cyan, WARN: COLORS.yellow, ERROR: COLORS.red,
    DEBUG: COLORS.gray, WIN: COLORS.green, LOSE: COLORS.red,
    LEARN: COLORS.magenta
  }[level] || COLORS.reset;
  console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${msg}`);
}

// ==========================================================
// 3. MEMORY + PERSISTENCE
// ==========================================================
const defaultMem = () => ({
  lastPhien: null, lastPred: null, history: [],
  totalWin: 0, totalLose: 0,
  bankroll: CONFIG.BANKROLL.initial,
  stopped: false,
  peakBankroll: CONFIG.BANKROLL.initial,
  maxDrawdown: 0,
  learnerPatterns: {}   // pattern -> {T, X, lastSeen}
});

const memory = {
  tx: loadMem('tx'),
  md5: loadMem('md5')
};

function loadMem(type) {
  try {
    if (fs.existsSync(CONFIG.FILE[type])) {
      const raw = JSON.parse(fs.readFileSync(CONFIG.FILE[type], 'utf8'));
      return { ...defaultMem(), ...raw };
    }
  } catch (e) {
    log('ERROR', `Không load được ${type} history: ${e.message}`);
  }
  return defaultMem();
}

function saveMem(type) {
  try {
    fs.writeFileSync(CONFIG.FILE[type], JSON.stringify(memory[type], null, 2));
  } catch (e) {
    log('ERROR', `Không save được ${type}: ${e.message}`);
  }
}

// ==========================================================
// 4. TIỆN ÍCH
// ==========================================================
function toSeq(list) {
  // list[0] mới nhất → đảo lại cũ -> mới
  return list.map(x => x.resultTruyenThong === 'TAI' ? 'T' : 'X').reverse();
}

function diceSeq(list) {
  return list.map(x => ({ point: x.point, dices: x.dices })).reverse();
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ==========================================================
// 5. TẦNG 1: STREAK
// ==========================================================
function analyzeStreak(h) {
  if (!h || h.length < 2) return { signal: 0, reason: '' };
  const L = h.length, last = h[L - 1];
  let n = 1;
  for (let i = L - 2; i >= 0; i--) { if (h[i] === last) n++; else break; }
  if (n >= 2 && n <= 3) { const s = 0.3 * (n - 1); return { signal: last === 'T' ? s : -s, reason: `Bám bệt ${n} tay` }; }
  if (n === 4) return { signal: last === 'T' ? -0.2 : 0.2, reason: 'Bệt 4 — nghi ngờ' };
  return { signal: 0, reason: `Bệt dài ${n} — không bẻ` };
}

// ==========================================================
// 6. TẦNG 2: ZIGZAG
// ==========================================================
function analyzeZigzag(h) {
  if (!h || h.length < 4) return { signal: 0, reason: '' };
  const L = h.length, last = h[L - 1];
  let zz = 0;
  for (let i = L - 1; i >= 1; i--) { if (h[i] !== h[i - 1]) zz++; else break; }
  if (zz >= 3) { const s = Math.min(0.4, zz * 0.1); return { signal: last === 'T' ? -s : s, reason: `Cầu đảo ${zz} nhịp` }; }
  return { signal: 0, reason: '' };
}

// ==========================================================
// 7. TẦNG 3: PATTERN
// ==========================================================
function analyzePattern(h) {
  if (!h || h.length < 6) return { signal: 0, reason: '' };
  const last = h[h.length - 1];
  const l4 = h.slice(-4).join(''), l6 = h.slice(-6).join('');
  if (l6 === 'TTTXXX') return { signal: last === 'X' ? 0.5 : -0.5, reason: 'Pattern 3-3' };
  if (l6 === 'XXXTTT') return { signal: last === 'T' ? -0.5 : 0.5, reason: 'Pattern 3-3' };
  if (l4 === 'TTXX') return { signal: last === 'X' ? 0.3 : -0.3, reason: 'Pattern 2-2' };
  if (l4 === 'XXTT') return { signal: last === 'T' ? -0.3 : 0.3, reason: 'Pattern 2-2' };
  return { signal: 0, reason: '' };
}

// ==========================================================
// 8. TẦNG 4: MATRIX
// ==========================================================
function analyzeMatrix(h) {
  if (!h || h.length < 15) return { signal: 0, reason: '' };
  const L = h.length, pat = h.slice(-5).join('');
  let mT = 0, mX = 0;
  for (let i = 0; i < L - 5; i++) {
    if (h.slice(i, i + 5).join('') === pat) {
      if (h[i + 5] === 'T') mT++; else if (h[i + 5] === 'X') mX++;
    }
  }
  const total = mT + mX;
  if (total < 2) return { signal: 0, reason: '' };
  const ratio = mT / total;
  const conf = Math.min(1, total / 5);
  return { signal: (ratio - 0.5) * 2 * conf, reason: `Matrix ${mT}T/${mX}X` };
}

// ==========================================================
// 9. TẦNG 5: DICE
// ==========================================================
function analyzeDice(dh) {
  if (!dh || dh.length < 5) return { signal: 0, reason: '' };
  const r = dh.slice(0, 5).map(d => d.point || 0);
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  const dev = avg - 10.5;
  if (Math.abs(dev) < 1) return { signal: 0, reason: '' };
  return { signal: clamp(-dev / 6, -0.3, 0.3), reason: `Xúc xắc TB ${avg.toFixed(1)}` };
}

// ==========================================================
// 10. TẦNG 6: BALANCE (z-score)
// ==========================================================
function analyzeBalance(h) {
  if (!h || h.length < 15) return { signal: 0, reason: '' };
  const w = h.slice(-20), n = w.length;
  const cT = w.filter(x => x === 'T').length;
  const p = cT / n;
  const z = (p - 0.5) / Math.sqrt(0.25 / n);
  if (Math.abs(z) < 1.5) return { signal: 0, reason: '' };
  return { signal: clamp(-z * 0.15, -0.5, 0.5), reason: `z=${z.toFixed(2)} (${cT}T/${n - cT}X)` };
}

// ==========================================================
// 11. TẦNG 7: FIBONACCI
// ==========================================================
function analyzeFib(h) {
  if (!h || h.length < 10) return { signal: 0, reason: '' };
  const L = h.length, pos = [1, 2, 3, 5, 8];
  let fT = 0, fX = 0;
  for (const p of pos) { if (L - p >= 0) { if (h[L - p] === 'T') fT++; else fX++; } }
  const total = fT + fX;
  if (total === 0) return { signal: 0, reason: '' };
  return { signal: ((fT - fX) / total) * 0.3, reason: `Fib ${fT}T/${fX}X` };
}

// ==========================================================
// 12. TẦNG 8: MARKOV
// ==========================================================
function analyzeMarkov(h) {
  if (!h || h.length < 20) return { signal: 0, reason: '' };
  const L = h.length, last = h[L - 1];
  let tt = 0, tx = 0, xt = 0, xx = 0;
  for (let i = 0; i < L - 1; i++) {
    if (h[i] === 'T' && h[i + 1] === 'T') tt++;
    if (h[i] === 'T' && h[i + 1] === 'X') tx++;
    if (h[i] === 'X' && h[i + 1] === 'T') xt++;
    if (h[i] === 'X' && h[i + 1] === 'X') xx++;
  }
  if (last === 'T') {
    const t = tt + tx;
    if (t >= 5) return { signal: ((tt - tx) / t) * 0.4, reason: `Markov T→(T${tt}/X${tx})` };
  } else {
    const t = xt + xx;
    if (t >= 5) return { signal: ((xx - xt) / t) * 0.4, reason: `Markov X→(X${xx}/T${xt})` };
  }
  return { signal: 0, reason: '' };
}

// ==========================================================
// 13. TẦNG 9: RHYTHM
// ==========================================================
function analyzeRhythm(h) {
  if (!h || h.length < 8) return { signal: 0, reason: '' };
  const r8 = h.slice(-8), cT = r8.filter(x => x === 'T').length;
  const p = r8.join('');
  if (p === 'TTXXTTXX') return { signal: -0.4, reason: 'Nhịp 2-2-2-2' };
  if (p === 'XXTTXXTT') return { signal: 0.4, reason: 'Nhịp 2-2-2-2' };
  if (cT >= 6) return { signal: -0.3, reason: `Nghiêng Tài (${cT}/8)` };
  if (cT <= 2) return { signal: 0.3, reason: `Nghiêng Xỉu (${cT}/8)` };
  return { signal: 0, reason: '' };
}

// ==========================================================
// 14. TẦNG 10: ENTROPY
// ==========================================================
function analyzeEntropy(h) {
  if (!h || h.length < 10) return { signal: 0, reason: '', entropy: 0 };
  const L = h.length, cT = h.filter(x => x === 'T').length;
  const pT = cT / L, pX = 1 - pT;
  let e = 0;
  if (pT > 0) e -= pT * Math.log2(pT);
  if (pX > 0) e -= pX * Math.log2(pX);
  if (e > 0.98) return { signal: 0, reason: `Entropy cao (${e.toFixed(3)})`, entropy: e };
  return { signal: 0, reason: '', entropy: e };
}

// ==========================================================
// 15. TẦNG 11: LEARNER — HỌC CẦU ĐÀNG HOÀNG
// ==========================================================
/**
 * Học từ lịch sử: pattern N ký tự → xác suất ký tự tiếp theo
 * Đây là cách "học cầu" thực sự: đếm chứ không đoán mò.
 * Nhưng vì xúc xắc độc lập → pattern học được cũng ~50/50.
 * Điểm khác biệt: learner có TRỌNG SỐ CAO NHẤT, nên nếu nó
 * thực sự tìm được pattern có edge, engine sẽ tin nó.
 */
function analyzeLearner(history, patterns) {
  if (!history || history.length < CONFIG.MIN_PHIEN) return { signal: 0, reason: '' };

  // 1. Học: duyệt toàn bộ lịch sử, đếm pattern → next
  const learned = {};
  const N = CONFIG.LEARNER.patternLength;
  const decay = CONFIG.LEARNER.decayFactor;

  for (let i = 0; i < history.length - N; i++) {
    const pat = history.slice(i, i + N).join('');
    const next = history[i + N];
    if (!learned[pat]) learned[pat] = { T: 0, X: 0, total: 0 };
    // Trọng số giảm dần theo thời gian (mẫu cũ ít quan trọng hơn)
    const age = history.length - i;
    const weight = Math.pow(decay, age / 10);
    if (next === 'T') learned[pat].T += weight;
    else learned[pat].X += weight;
    learned[pat].total += weight;
  }

  // 2. Predict dựa trên pattern hiện tại
  const currentPat = history.slice(-N).join('');
  const stat = learned[currentPat];

  if (!stat || stat.total < CONFIG.LEARNER.minSamples) {
    return { signal: 0, reason: 'Learner: chưa đủ mẫu' };
  }

  const pT = stat.T / stat.total;
  const pX = stat.X / stat.total;
  const edge = pT - pX; // [-1, 1]
  const confidence = Math.min(1, stat.total / 10); // càng nhiều mẫu càng tin

  const signal = clamp(edge * confidence, -0.8, 0.8);

  // Cập nhật patterns (dùng cho lần sau — không bắt buộc)
  if (Object.keys(patterns).length < CONFIG.LEARNER.maxPatterns) {
    patterns[currentPat] = {
      T: Math.round(stat.T * 100) / 100,
      X: Math.round(stat.X * 100) / 100,
      total: Math.round(stat.total * 100) / 100,
      pT: pT,
      lastSeen: Date.now()
    };
  }

  return {
    signal,
    reason: `Learner: pat[${currentPat}] → T${stat.T.toFixed(1)}/X${stat.X.toFixed(1)} (p=${pT.toFixed(2)})`
  };
}

// ==========================================================
// 16. ENGINE TỔNG HỢP
// ==========================================================
function runEngine(history, diceHist, patterns) {
  if (!history || history.length < CONFIG.MIN_PHIEN) {
    return { predict: 'CHỜ', confidence: '0%', reason: 'Chưa đủ dữ liệu', detail: [], rawSignal: 0 };
  }

  const parts = [
    { name: 'Streak',    ...analyzeStreak(history),              w: CONFIG.WEIGHTS.streak },
    { name: 'Zigzag',    ...analyzeZigzag(history),              w: CONFIG.WEIGHTS.zigzag },
    { name: 'Pattern',   ...analyzePattern(history),             w: CONFIG.WEIGHTS.pattern },
    { name: 'Matrix',    ...analyzeMatrix(history),              w: CONFIG.WEIGHTS.matrix },
    { name: 'Dice',      ...analyzeDice(diceHist),               w: CONFIG.WEIGHTS.dice },
    { name: 'Balance',   ...analyzeBalance(history),             w: CONFIG.WEIGHTS.balance },
    { name: 'Fibonacci', ...analyzeFib(history),                 w: CONFIG.WEIGHTS.fibonacci },
    { name: 'Markov',    ...analyzeMarkov(history),              w: CONFIG.WEIGHTS.markov },
    { name: 'Rhythm',    ...analyzeRhythm(history),              w: CONFIG.WEIGHTS.rhythm },
    { name: 'Entropy',   ...analyzeEntropy(history),             w: CONFIG.WEIGHTS.entropy },
    { name: 'Learner',   ...analyzeLearner(history, patterns),   w: CONFIG.WEIGHTS.learner }
  ];

  let sum = 0, wsum = 0, agreeT = 0, agreeX = 0, neutral = 0;

  for (const p of parts) {
    const s = p.signal || 0;
    sum += s * p.w;
    wsum += p.w;
    if (s > 0.05) agreeT++;
    else if (s < -0.05) agreeX++;
    else neutral++;
  }

  const finalSignal = wsum > 0 ? sum / wsum : 0;

  if (Math.abs(finalSignal) < CONFIG.SIGNAL.minToPredict) {
    return {
      predict: 'CHỜ', confidence: '50%',
      reason: 'Tín hiệu yếu — bỏ qua',
      detail: parts.map(p => ({ name: p.name, signal: (p.signal || 0).toFixed(3), reason: p.reason || '—' })),
      rawSignal: finalSignal
    };
  }

  const predict = finalSignal > 0 ? 'TÀI' : 'XỈU';
  const agree = predict === 'TÀI' ? agreeT : agreeX;
  const totalVotes = agreeT + agreeX + neutral;
  const agreeRatio = totalVotes > 0 ? agree / totalVotes : 0;
  const strength = Math.abs(finalSignal);

  let confPct = 50 + agreeRatio * 30 + strength * 20;
  confPct = clamp(confPct, CONFIG.SIGNAL.minConfidence, CONFIG.SIGNAL.maxConfidence);

  return {
    predict,
    confidence: `${confPct.toFixed(0)}%`,
    reason: parts.filter(p => p.reason).slice(0, 5).map(p => p.reason).join(' + '),
    detail: parts.map(p => ({ name: p.name, signal: (p.signal || 0).toFixed(3), reason: p.reason || '—' })),
    rawSignal: finalSignal,
    votes: { T: agreeT, X: agreeX, neutral }
  };
}

// ==========================================================
// 17. FETCH
// ==========================================================
async function fetchData(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': CONFIG.UA, 'Accept': 'application/json' },
        timeout: CONFIG.TIMEOUT
      });
      if (res.status === 200 && res.data) return res.data;
    } catch (e) {
      log('ERROR', `Fetch lần ${i + 1}: ${e.message}`);
      if (i === retries - 1) return null;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

// ==========================================================
// 18. QUẢN LÝ VỐN — KELLY CRITERION
// ==========================================================
function calcBetSize(mem, confidencePct) {
  const p = confidencePct / 100;
  // Kelly: f = (p*b - q) / b, với b=1 (cược 1 ăn 1)
  // f = 2p - 1
  const kelly = Math.max(0, 2 * p - 1);
  const f = kelly * CONFIG.BANKROLL.kellyFraction;
  const bet = clamp(
    CONFIG.BANKROLL.baseBet * (1 + f * 10),
    CONFIG.BANKROLL.baseBet,
    CONFIG.BANKROLL.maxBet
  );
  return Math.round(bet);
}

function updateBankroll(mem, isWin, confidencePct) {
  if (mem.stopped) return;

  const bet = calcBetSize(mem, confidencePct);
  if (isWin) mem.bankroll += bet;
  else mem.bankroll -= bet;

  if (mem.bankroll > mem.peakBankroll) mem.peakBankroll = mem.bankroll;
  const dd = mem.peakBankroll - mem.bankroll;
  if (dd > mem.maxDrawdown) mem.maxDrawdown = dd;

  const profit = mem.bankroll - CONFIG.BANKROLL.initial;
  if (profit <= -CONFIG.BANKROLL.stopLoss) {
    mem.stopped = true;
    log('WARN', `🛑 STOP-LOSS: lỗ ${Math.abs(profit).toFixed(0)}`);
  }
  if (profit >= CONFIG.BANKROLL.takeProfit) {
    mem.stopped = true;
    log('WIN', `🎯 TAKE-PROFIT: lãi ${profit.toFixed(0)}`);
  }
}

// ==========================================================
// 19. XỬ LÝ CHÍNH
// ==========================================================
async function processGame(type) {
  const url = CONFIG.API[type];
  const data = await fetchData(url);
  if (!data || !data.list || data.list.length === 0) {
    throw new Error('Không lấy được dữ liệu API');
  }

  const list = data.list;
  const currentPhien = String(list[0].id);
  const history = toSeq(list);
  const dh = diceSeq(list);
  const mem = memory[type];

  // Chấm điểm phiên trước
  if (mem.lastPhien && mem.lastPred) {
    const cur = parseFloat(currentPhien), prev = parseFloat(mem.lastPhien);
    if (cur > prev) {
      const actualObj = list.find(x => String(x.id) === mem.lastPhien);
      if (actualObj) {
        const actual = actualObj.resultTruyenThong === 'TAI' ? 'TÀI' : 'XỈU';
        const isWin = actual === mem.lastPred;
        const conf = mem.lastConfidence || 50;

        mem.history.push({
          phien: mem.lastPhien,
          duDoan: mem.lastPred,
          ketQua: actual,
          status: isWin ? 'WIN' : 'LOSE',
          tiLe: mem.lastConfidence,
          timestamp: Date.now()
        });

        if (isWin) mem.totalWin++; else mem.totalLose++;
        if (mem.history.length > CONFIG.MAX_STORE) mem.history.shift();

        updateBankroll(mem, isWin, conf);
        saveMem(type);

        log(isWin ? 'WIN' : 'LOSE', `[${type}] Phiên ${mem.lastPhien}: ${mem.lastPred} vs ${actual} → ${isWin ? '✅' : '❌'}`);
      } else {
        log('WARN', `[${type}] Không tìm thấy phiên ${mem.lastPhien}`);
      }
    }
  }

  // Dự đoán
  const pred = runEngine(history, dh, mem.learnerPatterns);
  mem.lastPhien = currentPhien;
  mem.lastPred = pred.predict !== 'CHỜ' ? pred.predict : null;
  mem.lastConfidence = pred.predict !== 'CHỜ' ? parseInt(pred.confidence) : null;

  log('INFO', `[${type}] Dự đoán ${parseFloat(currentPhien) + 1}: ${pred.predict} (${pred.confidence})`);

  return {
    phienHienTai: currentPhien,
    phienDuDoan: String(parseFloat(currentPhien) + 1),
    duDoan: pred.predict,
    tiLe: pred.confidence,
    liDo: pred.reason,
    chiTiet: pred.detail,
    votes: pred.votes,
    rawSignal: pred.rawSignal,
    xucXac: list[0].dices || [],
    tongDiem: list[0].point || 0,
    thongKe: {
      win: mem.totalWin,
      lose: mem.totalLose,
      winrate: mem.totalWin + mem.totalLose > 0
        ? ((mem.totalWin / (mem.totalWin + mem.totalLose)) * 100).toFixed(1) + '%' : '—',
      bankroll: mem.bankroll.toFixed(0),
      maxDrawdown: mem.maxDrawdown.toFixed(0),
      stopped: mem.stopped
    }
  };
}

// ==========================================================
// 20. BACKTEST
// ==========================================================
async function runBacktest(type, limit = 500) {
  log('INFO', `Backtest ${type} — limit ${limit}`);
  const url = CONFIG.API[type];
  let all = [], page = 1;

  while (all.length < limit && page <= 15) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': CONFIG.UA },
        params: { page, limit: 100 },
        timeout: CONFIG.TIMEOUT
      });
      const list = res.data?.list || [];
      if (list.length === 0) break;
      all = all.concat(list);
      log('DEBUG', `Trang ${page}: +${list.length} (tổng ${all.length})`);
      if (list.length < 100) break;
      page++;
    } catch (e) {
      log('ERROR', `Trang ${page}: ${e.message}`);
      break;
    }
  }

  if (all.length === 0) throw new Error('Không lấy được dữ liệu');

  all.sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
  const seq = all.map(x => x.resultTruyenThong === 'TAI' ? 'T' : 'X');
  const diceArr = all.map(x => ({ point: x.point, dices: x.dices }));

  let win = 0, lose = 0, skip = 0;
  const detail = [];
  const patterns = {};

  for (let i = CONFIG.MIN_PHIEN; i < seq.length; i++) {
    const hist = seq.slice(0, i);
    const dh = diceArr.slice(0, i).reverse();
    const pred = runEngine(hist, dh, patterns);

    if (pred.predict === 'CHỜ') { skip++; continue; }
    const actual = seq[i] === 'T' ? 'TÀI' : 'XỈU';
    const isWin = pred.predict === actual;
    if (isWin) win++; else lose++;

    if (detail.length < 30) {
      detail.push({
        phien: all[i].id, duDoan: pred.predict, ketQua: actual,
        status: isWin ? 'WIN' : 'LOSE', tiLe: pred.confidence
      });
    }
  }

  const total = win + lose;
  const winrate = total > 0 ? (win / total * 100).toFixed(2) : '0';

  // Random baseline
  let rW = 0, rL = 0;
  for (let i = CONFIG.MIN_PHIEN; i < seq.length; i++) {
    const g = Math.random() < 0.5 ? 'TÀI' : 'XỈU';
    const a = seq[i] === 'T' ? 'TÀI' : 'XỈU';
    if (g === a) rW++; else rL++;
  }
  const randomWr = (rW / (rW + rL) * 100).toFixed(2);

  return {
    tongPhien: seq.length,
    soLanDuDoan: total, soLanBoQua: skip,
    win, lose,
    winrate: `${winrate}%`,
    randomWinrate: `${randomWr}%`,
    ketLuan: parseFloat(winrate) > 52
      ? '⚠️ Đáng ngờ — kiểm tra lookahead bias'
      : parseFloat(winrate) >= 48
        ? '✅ ~50% — đúng kỳ vọng toán học (random)'
        : '❌ Dưới 50% — tệ hơn random',
    chiTiet30: detail
  };
}

async function backtestLayer(type, layerName, limit = 500) {
  log('INFO', `Backtest layer ${layerName} — ${type} — limit ${limit}`);
  const url = CONFIG.API[type];
  let all = [];
  let page = 1;

  while (all.length < limit && page <= 15) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': CONFIG.UA },
        params: { page, limit: 100 },
        timeout: CONFIG.TIMEOUT
      });
      const list = res.data?.list || [];
      if (list.length === 0) break;
      all = all.concat(list);
      if (list.length < 100) break;
      page++;
    } catch (e) { break; }
  }

  if (all.length === 0) throw new Error('Không có dữ liệu');
  all.sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
  const seq = all.map(x => x.resultTruyenThong === 'TAI' ? 'T' : 'X');
  const diceArr = all.map(x => ({ point: x.point, dices: x.dices }));

  // Map layer → function
  const layerFns = {
    streak: (h) => analyzeStreak(h),
    zigzag: (h) => analyzeZigzag(h),
    pattern: (h) => analyzePattern(h),
    matrix: (h) => analyzeMatrix(h),
    dice: (h, d) => analyzeDice(d),
    balance: (h) => analyzeBalance(h),
    fibonacci: (h) => analyzeFib(h),
    markov: (h) => analyzeMarkov(h),
    rhythm: (h) => analyzeRhythm(h),
    entropy: (h) => analyzeEntropy(h),
    learner: (h, d, p) => analyzeLearner(h, p)
  };

  const fn = layerFns[layerName];
  if (!fn) throw new Error(`Layer không hợp lệ: ${layerName}`);

  let win = 0, lose = 0, skip = 0;
  const patterns = {};

  for (let i = CONFIG.MIN_PHIEN; i < seq.length; i++) {
    const hist = seq.slice(0, i);
    const dh = diceArr.slice(0, i).reverse();
    const res = fn(hist, dh, patterns);
    if (!res || Math.abs(res.signal || 0) < 0.03) { skip++; continue; }
    const pred = res.signal > 0 ? 'TÀI' : 'XỈU';
    const actual = seq[i] === 'T' ? 'TÀI' : 'XỈU';
    if (pred === actual) win++; else lose++;
  }

  const total = win + lose;
  return {
    layer: layerName, type,
    tongPhien: seq.length, soLanDuDoan: total, soLanBoQua: skip,
    win, lose,
    winrate: total > 0 ? `${(win / total * 100).toFixed(2)}%` : '0%'
  };
}

// ==========================================================
// 21. EXPRESS ROUTES
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
    totalWin: m.totalWin, totalLose: m.totalLose,
    winrate: m.totalWin + m.totalLose > 0
      ? ((m.totalWin / (m.totalWin + m.totalLose)) * 100).toFixed(1) + '%' : '—',
    bankroll: m.bankroll.toFixed(0),
    maxDrawdown: m.maxDrawdown.toFixed(0),
    stopped: m.stopped,
    data: [...m.history].reverse()
  });
});

app.get('/lsmd5', (req, res) => {
  const m = memory.md5;
  res.json({
    status: 'success',
    totalWin: m.totalWin, totalLose: m.totalLose,
    winrate: m.totalWin + m.totalLose > 0
      ? ((m.totalWin / (m.totalWin + m.totalLose)) * 100).toFixed(1) + '%' : '—',
    bankroll: m.bankroll.toFixed(0),
    maxDrawdown: m.maxDrawdown.toFixed(0),
    stopped: m.stopped,
    data: [...m.history].reverse()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online', version: '20.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    tx: { win: memory.tx.totalWin, lose: memory.tx.totalLose, bankroll: memory.tx.bankroll, stopped: memory.tx.stopped },
    md5: { win: memory.md5.totalWin, lose: memory.md5.totalLose, bankroll: memory.md5.bankroll, stopped: memory.md5.stopped }
  });
});

app.get('/backtest', async (req, res) => {
  try {
    const type = req.query.type === 'md5' ? 'md5' : 'tx';
    const limit = parseInt(req.query.limit) || 500;
    const r = await runBacktest(type, limit);
    res.json({ status: 'success', type, data: r });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/backtest/:layer', async (req, res) => {
  try {
    const type = req.query.type === 'md5' ? 'md5' : 'tx';
    const limit = parseInt(req.query.limit) || 500;
    const r = await backtestLayer(type, req.params.layer, limit);
    res.json({ status: 'success', data: r });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/export', (req, res) => {
  const type = req.query.type === 'md5' ? 'md5' : 'tx';
  res.json({ status: 'success', data: memory[type].history });
});

app.post('/reset', (req, res) => {
  const { type } = req.body;
  if (type === 'tx' || type === 'all') memory.tx = defaultMem();
  if (type === 'md5' || type === 'all') memory.md5 = defaultMem();
  if (type === 'tx' || type === 'all') saveMem('tx');
  if (type === 'md5' || type === 'all') saveMem('md5');
  res.json({ status: 'success', message: `Reset ${type}` });
});

// ==========================================================
// 22. KHỞI ĐỘNG
// ==========================================================
const server = app.listen(CONFIG.PORT, () => {
  console.log(COLORS.cyan + '=========================================');
  console.log(COLORS.green + `🔥 VIP GOD TIER V20 — http://localhost:${CONFIG.PORT}`);
  console.log(COLORS.cyan + '=========================================');
  console.log(COLORS.yellow + 'Endpoints:');
  console.log(COLORS.reset + '  GET  /taixiu                    → dự đoán TX');
  console.log('  GET  /md5                       → dự đoán MD5');
  console.log('  GET  /lstaixiu                  → lịch sử TX');
  console.log('  GET  /lsmd5                     → lịch sử MD5');
  console.log('  GET  /status                    → trạng thái');
  console.log('  GET  /backtest?type=tx          → backtest tổng');
  console.log('  GET  /backtest/:layer           → backtest từng tầng');
  console.log('         layers: streak|zigzag|pattern|matrix|dice|');
  console.log('                 balance|fibonacci|markov|rhythm|entropy|learner');
  console.log('  GET  /export?type=tx            → xuất JSON');
  console.log('  POST /reset                     → reset {type:"tx"|"md5"|"all"}');
  console.log(COLORS.cyan + '=========================================');
  console.log(COLORS.yellow + '⚠️  Tài Xỉu là sự kiện độc lập.');
  console.log('   Backtest sẽ cho winrate ~50%. Đó là SỰ THẬT TOÁN HỌC.');
  console.log(COLORS.cyan + '=========================================' + COLORS.reset);
});

process.on('SIGINT', () => {
  log('INFO', 'Đang tắt server...');
  saveMem('tx');
  saveMem('md5');
  server.close(() => process.exit(0));
});
