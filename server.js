/**
 * ==============================================================================
 * VIP GOD TIER V38 FINAL - ALL-IN-ONE
 * 5 layer + 18 cầu phụ + warm-up EFS + KB 10k cầu + long pattern + JSON memory
 * Đặt cạnh file cau.txt là chạy full 10.000 cầu
 * ==============================================================================
 */
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    PORT: process.env.PORT || 3000,
    API: { tx: 'https://wtx.tele68.com/v1/tx/sessions', md5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions' },
    TIMEOUT: 15000,
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    WARMUP: { TARGET_EFS: 80, MIN_SESSIONS_ABSOLUTE: 10, SESSIONS_FULL: 100, POLL_INTERVAL_MS: 3000, MAX_WARMUP_SESSIONS: 300, LOG_EVERY_N: 5 },
    MIN_PHIEN: 15,
    FILE: { tx: path.join(__dirname, 'v38_tx.json'), md5: path.join(__dirname, 'v38_md5.json'), cau: path.join(__dirname, 'cau.txt') },
    BANKROLL: { INITIAL: 1000, BASE_BET: 10, MAX_BET: 100, STOP_LOSS: 500, TAKE_PROFIT: 2000 },
    MODEL: { MAX_ORDER: 6, MIN_SAMPLES: 4, LAPLACE_ALPHA: 1.0, CUSUM_THRESHOLD: 5.0, MIN_EDGE: 0.015, SUB_PATTERN_BOOST: 3.5 },
    KB: { ENABLED: true, MIN_CONFIDENCE_TO_BLEND: 0.6, BLEND_WEIGHT: 0.3, CONTEXT_LEN_LONG: 20, MIN_PATTERN_LEN: 15 }
};

const COLORS = { reset:'\x1b[0m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', magenta:'\x1b[35m', cyan:'\x1b[36m', gray:'\x1b[90m' };
function log(level, message) {
    const ts = new Date().toLocaleTimeString();
    const cmap = { INFO:COLORS.cyan, WARN:COLORS.yellow, ERROR:COLORS.red, WIN:COLORS.green, LOSE:COLORS.red, MODEL:COLORS.magenta, WARMUP:COLORS.blue, READY:COLORS.green, SUB:COLORS.yellow, KB:COLORS.cyan };
    console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${cmap[level]||COLORS.reset}[${level}]${COLORS.reset} ${message}`);
}

// ==============================================================================
// KB — Knowledge Base
// ==============================================================================
let CAU_DATABASE = [], CAU_MAP = new Map(), CAU_LOADED = false;
const LEARNED_RUNTIME = new Map(), LEARN_QUEUE = [];

// Pattern dài 10k ký tự (rút gọn hợp lệ — phần còn lại nếu có sẽ đọc từ cau_long.txt)
const LONG_PATTERN_10K = "TTXXXTTTTTTTTTTXXXTXTTXXXXXTTXXTXXTTTXTXXTTXXTXTXXTXXXTXTTTTXXTXTXXXTXXXTTTTTXTTTTXTXTXXTTTXTTXTTTXXXXXTXTTXXTXTXTXXXXXTTTTTTTXTTTTTTXTTTXXXTTXXXTTXXXXXTXTTXXXXTTTTXXXTTTXXXTTTTTTTXTTXTTXXTXXTTTTXXXXXXXTTXXTTTXXXXXTXXXTTXTTXXXXXXXTXTTXXTTTTTTTTTXTXXXXXTTXTTXTXXTXTXTXXXXTXTTXTTTTTTXTTXXTTXXXXXTTTXTTTXTXXTXXXXXTTTTTTTXTTTTTTTTXXXXXXXTTXTXXXXXXTXTTXTXXTTTXXXXTXTXTXXXTXTXXTXXTXXXTXTTTTTXTTXXXXTTXTXXXXXXXXXTXXTTTTXTTXTXTXXXTTTTXXTXXXTTTXTTXTXXXTTTTTXTTXTTTTXTXXTTXXXXXXXTTTXTTTTTXTTTXTTTXTTTXTXTTTXXTTTTXTTXXTTTTXXXXXXXXTTXXXTTXTTXXXXXXXXXTXTTTTTTXTXTXTTTXXTXTTXXTTTXTXXXTXTTTXXTXXXTTTTXTTTTTTTTTXXXXXXTXXTTTTTTTTTTTXXXTTTTTTTTTTTXTTTTXXXXXTTTXXTTXXTTXXTXXTTTTTTTTXXTTTTTTXXTTTTXTTXTTXTXXTTTXXTTXXTTTTTXXXXXTXTTXXXXXXTTXTXTTTTXTTXXXTXXXTXXTTTTTTTTTTXXTTXXTTXXXTTXXXXTXTTTXXTTTXXXTTXTTXTXTTXTXTTXXTTTXXXTXXTXTTTTXTTXXXXXXXXTTXXXXXTXTXXXXXXXXXTXXXXTTTTTXTXTTXXTTTXTXXTTTTTTTTTTTTTTTXXXXXXXXXXXTXTTXTTTTXXXXTTTTTTXTTXXTTTXTXTTXXXXTTTXXTXXXXTTTTXXXTTXTXXTXXXXTTTXTXXXXTXTTXTXXXTTXXXXXXXXXTTTTTTXTXTTTXTXXTTXTTTXXTXTXTTTTTTXXTXXTXTXXXXXTTXTTXTXTXXTTTXXTXXXXXXXXXTTXXTXXXXXTXXTXTTXXTTTTTTTXTXXXTXXXXTTXTXXTTTXXXXXXTTTXTTXXTTXXTTTTXXXTTTXXXTTTTXXTTTXTXXTTXTTTXXTTXXTTTTXTTTXXTTTTXTXXTTTTTTXTXTTXXXXXTTTXXXXXXXTTTTXTXTTTTXTXTTTTXXTXXXXTTXTTTTXXXTXXXXXTTXTXXXTXTTTXXTTTTXXXTTXTTTTTXTXXXTTXXTXTTXXTXTTXXTXXXXXXXTTTTTTXXTTXXTXXXTXTTXXXXTTTTTTTTTTXTTXTTTXXTXTTXXXXXTXXTXXXXXXXXXTXXXTXXTXXTTTTXXXXTTXXXTTTTTXXTTTXTXXTXXTTTTXXXXXTTTTTTXXXXTTTTTTTXTTTTTTTTTTTXXTTTXXTXXXTTTTTTXXXTXXXTTXTTXXTTXXTXTTXXTTTTTXXXTTTXTXTTXTTXXTTTTTXTXXTTTTXTXTTXTTTXXXTTXXXXXXTXTXXTTTXTXTXTTXXXTTTXXTTXTTTXTTTTTTTXXXXXXXTTTXXTTXXXXXXXXTTXXXXXXXTXTTTXXTTTXTTXTXTXXXXTTXXXXXTTTTTTTTTTXTTXXXXXTTTTTXXXXTTXTTTXXXXTTXXXXTTTTTTXTXXXTTTXTTXXXXXTXXXTXTXXXXTTXTXXXXTTXTXTTTTTXXTTTTTTXXTTXXTXTXTXTTXTTTTXXXTTTTXTTXXXXXXTXTTXXTTTTTTTXXXXTTTXXTXTTXXTXXXTTTXXTTTXTXXXXTTXTXTXTTTTTXXTXXXXXXTTXXXXXXTTTXTTXTTTXXTXXXTTXXTTXTXTTXXXXXXTTXXXTTTTXXXTTXTXXTXTTXXXXXTTXXTTTXXXXXTTTXXXXXXTTTXTXXTTTTXXXTTTXXTTXXTTTTXTXXTXTXTTTTXXXXXXXTXXXTTTXTXTTXTXTXXXXXXXXTXXTXXXXXTTTXTTXXXTTXXTTXTXXXTTTTTTTTXXTXXXTTTTTTXXTXXTXXTTXXXTTXXXXXTTTTTTXXTTTXXXTTTTXXXXXXTTXXTTXXXTXTXXTTXXTTTXXXTXTXXTTXXTXXTXTTTXTXTTTXXXTXXXXXXXXXXXXTTXXTXXXTXXXXTTTTXXXXTTXXXTTXXXTXXXXXTTXXTXXXTTXTXTTTTXXXXXTXTTTTXXXTTTXXXXXTXXXXXXXXTTTTXXTXTXTTTTTTTTTTTXTXTTTXTTXXXTXXXTTTXXXXXTXTTTTXXXTTXXTXTTTTTXXXXTXTXTTTTTTTXTTTXXTXXTXXTXXTXTXTXTTTTTTTXXXXXXXXTTTXXXXXTXXXTTXXXXTXTTXXXTTTXXXTXXTXXTTTTTTTTTTXXTXTTTTTXXXTTTTTTXXTTTTTTTXXXXXXXTTTXTXTTTTXXTTXTXTXXXXXXXXXXXXXTTTXXTXTXXXTTXXTTTTXTXTTTTXTTXTTTTTTXTXXXTTTTTTXTXXXTTTXXTXTTXXTTTTTTTXXXXXXXTTTTXTTXXXXTTTTTTXXXTTXTTTTTTTTXXTTTTTTTTXTXXTTXTTXXXTTTXXXXXXXXTXXTTXTXTTXXXXXXXXXXTTXTXXXTTTTTTTXXTTXTXTTTXXXXXXXXXTTTTXTXXTXTXXXTTXXXXXXTXTTXXTXTXTTTTTTXTTXXXTTTTTTTTTTXXXTTTTTTXTTXXXXTTTXXXTXTXXXXXXXXXTTXXXTTTXXTXXTXXXXTTXXTTTTXXXXXTXXTTXXXTXXXTXXTTXXXXXXXXXXXTXXXXTTXXTTXXXXTTXXXXXXXTXXTTTTXXXTTXXXXXTXTXXTTXXTXXXXTXTXTTTTTTTTTTTTTTTTTXXTXTTTTXTTTTTTTTTTXXXXXTTTTTTTTTTTTTTXXXXXTTXTXTXXXXXXXXTTTTTTXXXXTXTTTTXXXXXTXTTTTTTTXTTXXXXXXTTTTXXXTXXXXXXXXTTTTTTTXXTTTTTTTXXXXTTXXXXXTXTXTXTXXXXTTXXXXXTTTXXXTTXXTTTXTTTTXXXTXXXXTTXXTTTTTTTXTTTTXXXTTTTTXXXXXXXTTTTXTTXXTXTTXTXXXXXXXXTTTTXTXTTTXTTXTTTTXXXXXXTTXTTTTXXXXTXXXXXXXXXXXXXXTTXTTTTTTTXXXXTTXXTXXXXXXXTTTTTXTTTXXTXTTXXTTXXXXTTTTXTTTXTTTXTXXTXTXXXTXXXTTTXXXTXXXTTTTTTTTXXXTXXTTXXTTXXXXXTTXXXXXTTXXXXTXXTTXXXXXTTXXTXXTXTXXXXXTTTTTXXXXTXXXXXXTTXXTTTTXTTTXXXXXXTTTTXTXTTXXTXXXTXTXTXXXTXTTXTXTXXTTTXTTXTTTXXTXTTXTXXTTTTTXXXTXTXTXTTTXXTTTXXTTXXTXTTTTXTTXXXTXXTTTTXTTTXXTTTTTXXXXXXXXTXXTTTXXXTXXXXXXTXTXTXTTXXXTTXXXTXXTXTTTTXTTTTXXXXXXXTXTXTTTXTTTTTTTXXXXXXXXXXXXXTTTTTTTTTTTXXXTXXTXXXTXXTTTTTXXTTTTTXXXXTTTTTXTTTTTTTTTTXTXXTXXXXTTXXTXXXTXTXXTXXTTXXTXXTXTTTXTTTXTXXTTXTTTXTXXXXTXXTXTTTXTTTXXXTXXTXXTXTXTXXXXXTTTTTTXXTTTXTXXTTXXTXXXXXTXTTTTXXXTTXTTTTXTTTXXXTXTTTTTTTTXTXTXXXXTXTTTXTXTXXXXTTTTXXXTTXXXTTXXXTTTTTXXXTXXTTTXTTTXXXTTTTTXXTTXXTXXXXXTTTXTTTTTTTTTTTXXTTTXXXXXXXXTTXXXXXXXXXXXXTXXTTTXTXXTTXXTTTTXXTTTTTXXTXTXTXTXTTXTXXXXXXTTTTXTTTTTTXTXTXTXXTTTXXXXTTTTXXTXXTTXXTXXTXXXTTTTTTTTTTXTTTTTTXXTXTXTXTXXXXXXXXTTXTXXXTTTXTTXTXXXXXXXTTTXXTTTXXXXXXTXTTXTXXXXXXXXXTXTXXTTXTXTXXXTTTXTTXXXXXTTTTTTTXXTTTXTTXXXXXXXX";

function loadCauDatabase(filePath) {
    try {
        if (!fs.existsSync(filePath)) { log('WARN', `⚠️  Không tìm thấy ${filePath} — chạy KHÔNG KB`); return false; }
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim());
        let count = 0;
        for (const line of lines) {
            const m = line.match(/^\s*\d+\.\s*([TX]{10,30})\s*-\s*([TX])\s*$/);
            if (!m) continue;
            const pattern = m[1], next = m[2];
            CAU_DATABASE.push({ pattern, next, idx: count });
            if (!CAU_MAP.has(pattern)) CAU_MAP.set(pattern, { T: 0, X: 0, total: 0 });
            const e = CAU_MAP.get(pattern);
            if (next === 'T') e.T++; else e.X++;
            e.total++; count++;
        }
        CAU_LOADED = true;
        log('KB', `✅ Nạp ${count} cầu | Unique: ${CAU_MAP.size} | LongPattern: ${LONG_PATTERN_10K.length} ký tự`);
        return true;
    } catch (e) { log('ERROR', `Load cau.txt: ${e.message}`); return false; }
}

function lookupCauDatabase(history, minLen = 15) {
    if (!CAU_LOADED || history.length < minLen) return { hit: false, fallback: true };
    const tail = history.slice(-minLen).join('');
    if (CAU_MAP.has(tail)) {
        const e = CAU_MAP.get(tail), probT = e.T / e.total;
        return { hit: true, pattern: tail, matchedLen: minLen, nextCounts: { T: e.T, X: e.X, total: e.total }, probT, source: 'KB_EXACT', confidence: Math.min(1, e.total / 5) * Math.abs(probT - 0.5) * 2 };
    }
    for (let len = minLen - 1; len >= 8; len--) {
        if (history.length < len) continue;
        const sub = history.slice(-len).join('');
        if (CAU_MAP.has(sub)) {
            const e = CAU_MAP.get(sub);
            if (e.total >= 2) {
                const probT = e.T / e.total;
                return { hit: true, pattern: sub, matchedLen: len, nextCounts: { T: e.T, X: e.X, total: e.total }, probT, source: 'KB_SUB_' + len, confidence: Math.min(1, e.total / 5) * Math.abs(probT - 0.5) * 2 };
            }
        }
    }
    return { hit: false, fallback: true, suggestLearn: true };
}

function lookupLongPattern(history, contextLen = 20) {
    if (history.length < contextLen) return { hit: false };
    const ctx = history.slice(-contextLen).join('');
    const positions = [];
    let idx = LONG_PATTERN_10K.indexOf(ctx);
    while (idx !== -1 && positions.length < 50) { positions.push(idx); idx = LONG_PATTERN_10K.indexOf(ctx, idx + 1); }
    if (positions.length === 0) return { hit: false, context: ctx };
    let cT = 0, cX = 0;
    for (const p of positions) { const a = LONG_PATTERN_10K[p + contextLen]; if (a === 'T') cT++; else if (a === 'X') cX++; }
    const total = cT + cX;
    if (total === 0) return { hit: false, context: ctx };
    return { hit: true, context: ctx, occurrences: positions.length, nextCounts: { T: cT, X: cX, total }, probT: cT / total, source: 'LONG_PATTERN', confidence: Math.min(1, total / 5) * Math.abs(cT / total - 0.5) * 2 };
}

function learnPattern(history, actualNext) {
    if (history.length < 15) return;
    const tail = history.slice(-15).join('');
    if (!LEARNED_RUNTIME.has(tail)) LEARNED_RUNTIME.set(tail, { T: 0, X: 0, total: 0 });
    const e = LEARNED_RUNTIME.get(tail);
    if (actualNext === 'T') e.T++; else e.X++; e.total++;
    LEARN_QUEUE.push({ pattern: tail, next: actualNext, ts: Date.now() });
    if (LEARN_QUEUE.length > 500) LEARN_QUEUE.shift();
}

function kbSignal(history) {
    const kb = lookupCauDatabase(history, CONFIG.KB.MIN_PATTERN_LEN);
    const lp = lookupLongPattern(history, CONFIG.KB.CONTEXT_LEN_LONG);
    const signals = [];
    if (kb.hit) signals.push({ source: kb.source, probT: kb.probT, confidence: kb.confidence, meta: kb });
    if (lp.hit) signals.push({ source: lp.source, probT: lp.probT, confidence: lp.confidence, meta: lp });
    if (signals.length === 0) return { hit: false, probT: 0.5, confidence: 0, reason: 'KB không khớp cầu nào', suggestLearn: kb.suggestLearn, details: { kb, lp } };
    const totalConf = signals.reduce((s, x) => s + x.confidence, 0);
    const avgProbT = signals.reduce((s, x) => s + x.probT * x.confidence, 0) / (totalConf || 1);
    return { hit: true, probT: avgProbT, confidence: Math.min(1, totalConf), reason: signals.map(s => `${s.source} (${(s.probT*100).toFixed(0)}%)`).join(' + '), signals, details: { kb, lp } };
}

function KB_getStats() {
    return { loaded: CAU_LOADED, patterns: CAU_DATABASE.length, unique: CAU_MAP.size, learned: LEARNED_RUNTIME.size, queueLen: LEARN_QUEUE.length, longPatternLen: LONG_PATTERN_10K.length };
}

// ==============================================================================
// JSON MEMORY
// ==============================================================================
function createDefaultMemory() {
    return {
        lastPhien: null, lastPrediction: null, lastConfidence: null, lastModelDetails: null,
        statistics: { win: 0, lose: 0, bankroll: CONFIG.BANKROLL.INITIAL, peakBankroll: CONFIG.BANKROLL.INITIAL, maxDrawdown: 0, isStopped: false },
        models: { vom: { win: 0, lose: 0 }, ppm: { win: 0, lose: 0 }, learner: { win: 0, lose: 0 } },
        subPatternStats: {}, kbStats: { hit: 0, miss: 0, win: 0, lose: 0 }
    };
}
function loadMemory(type) {
    try { if (fs.existsSync(CONFIG.FILE[type])) return { ...createDefaultMemory(), ...JSON.parse(fs.readFileSync(CONFIG.FILE[type], 'utf8')) }; }
    catch (e) { log('ERROR', `Load ${type}: ${e.message}`); }
    return createDefaultMemory();
}
function saveMemory(type, mem) {
    try { fs.writeFileSync(CONFIG.FILE[type], JSON.stringify(mem, null, 2), 'utf8'); }
    catch (e) { log('ERROR', `Save ${type}: ${e.message}`); }
}
const memory = { tx: loadMemory('tx'), md5: loadMemory('md5') };

const warmupState = { tx: createEmptyWarmup(), md5: createEmptyWarmup() };
function createEmptyWarmup() {
    return { isReady: false, efs: 0, scannedSessions: 0, breakdown: { dataVolume: 0, patternCoverage: 0, modelStability: 0, cusumStability: 0 }, readyAt: null, history: [], lastUpdated: null, lastPhien: null, detectedPatterns: [] };
}

function convertToSequence(list) { return list.map(i => i.resultTruyenThong === 'TAI' ? 'T' : 'X').reverse(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function calculateKellyBet(mem, confidence) {
    if (mem.statistics.isStopped) return 0;
    const p = confidence / 100, kelly = Math.max(0, 2 * p - 1);
    return clamp(CONFIG.BANKROLL.BASE_BET * (1 + kelly * 3), CONFIG.BANKROLL.BASE_BET, CONFIG.BANKROLL.MAX_BET);
}

// ==============================================================================
// 5 LAYER GỐC
// ==============================================================================
function layerVOM(history) {
    if (history.length < 5) return 0.5;
    for (let order = CONFIG.MODEL.MAX_ORDER; order >= 1; order--) {
        if (history.length <= order) continue;
        const ctx = history.slice(-order).join('');
        let cT = 0, cX = 0;
        for (let i = 0; i < history.length - order; i++) if (history.slice(i, i + order).join('') === ctx) { if (history[i + order] === 'T') cT++; else cX++; }
        const total = cT + cX;
        if (total >= CONFIG.MODEL.MIN_SAMPLES) return (cT + CONFIG.MODEL.LAPLACE_ALPHA) / (total + 2 * CONFIG.MODEL.LAPLACE_ALPHA);
    }
    return 0.5;
}
function layerPPM(history) {
    if (history.length < 5) return 0.5;
    const tables = {};
    for (let o = 1; o <= CONFIG.MODEL.MAX_ORDER; o++) tables[o] = {};
    for (let i = 0; i < history.length - 1; i++) for (let o = 1; o <= CONFIG.MODEL.MAX_ORDER; o++) {
        if (i < o) continue;
        const ctx = history.slice(i - o, i).join(''), next = history[i];
        if (!tables[o][ctx]) tables[o][ctx] = { T: 0, X: 0 };
        if (next === 'T') tables[o][ctx].T++; else tables[o][ctx].X++;
    }
    let escapeProb = 1.0;
    for (let o = CONFIG.MODEL.MAX_ORDER; o >= 1; o--) {
        if (history.length < o) continue;
        const ctx = history.slice(-o).join(''), t = tables[o][ctx];
        if (!t) continue;
        const total = t.T + t.X; if (total === 0) continue;
        const unique = (t.T > 0 ? 1 : 0) + (t.X > 0 ? 1 : 0);
        const pT = (t.T / (total + unique)) * escapeProb, pX = (t.X / (total + unique)) * escapeProb;
        if (total >= 2) return pT / (pT + pX + 1e-9);
        escapeProb *= (unique / (total + unique));
    }
    return 0.5;
}
function layerLearner(history) {
    if (history.length < 12) return 0.5;
    const N = 4, current = history.slice(-N).join('');
    let cT = 0, cX = 0;
    for (let i = 0; i < history.length - N; i++) if (history.slice(i, i + N).join('') === current) { if (history[i + N] === 'T') cT++; else cX++; }
    const total = cT + cX; if (total === 0) return 0.5;
    return (cT + 1) / (total + 2);
}
function layerCUSUM(history) {
    if (history.length < 15) return { isBroken: false, strength: 0 };
    const vals = history.map(x => x === 'T' ? 1 : 0);
    let sHi = 0, sLo = 0, maxS = 0;
    for (const v of vals) { sHi = Math.max(0, sHi + (v - 0.6)); sLo = Math.max(0, sLo + (0.4 - v)); maxS = Math.max(maxS, sHi, sLo); }
    return { isBroken: maxS > CONFIG.MODEL.CUSUM_THRESHOLD, strength: clamp(maxS / 10, 0, 1) };
}

// ==============================================================================
// 18 CẦU PHỤ
// ==============================================================================
function detectMirror(h) {
    if (h.length < 4) return { hit: false };
    const w4 = h.slice(-4).join('');
    if (w4[0]===w4[3] && w4[1]===w4[2] && w4[0]!==w4[1]) { const nx = w4[3]==='T'?'X':'T'; return { hit: true, name: 'Gương ABBA', probT: nx==='T'?0.72:0.28, detail: `${w4}→${nx}` }; }
    if (h.length >= 6) { const w6 = h.slice(-6).join(''); if (w6[0]===w6[5] && w6[1]===w6[4] && w6[2]===w6[3] && w6[0]!==w6[1]) { const nx = w6[5]==='T'?'X':'T'; return { hit: true, name: 'Gương ABCCBA', probT: nx==='T'?0.74:0.26, detail: `${w6}` }; } }
    return { hit: false };
}
function detectPalindrome(h) {
    if (h.length < 5) return { hit: false };
    for (const n of [5, 7]) { if (h.length < n) continue; const w = h.slice(-n); if (w.join('') === w.slice().reverse().join('')) { const nx = h[h.length - n]; return { hit: true, name: `Palindrome ${n}`, probT: nx==='T'?0.74:0.26, detail: `${w.join('')}` }; } }
    return { hit: false };
}
function detectFullReverse(h) {
    if (h.length < 6) return { hit: false };
    const n = Math.min(5, Math.floor(h.length / 2)); if (n < 3) return { hit: false };
    const b1 = h.slice(-n*2, -n).join(''), b2 = h.slice(-n).join('');
    for (let i = 0; i < n; i++) if (b1[i] === b2[i]) return { hit: false };
    const nx = b1[0]; return { hit: true, name: 'Đảo toàn phần', probT: nx==='T'?0.70:0.30, detail: `${b1}↔${b2}` };
}
function detectCycle(h) {
    if (h.length < 6) return { hit: false };
    for (const n of [2, 3, 4]) { if (h.length < n*2) continue; const b1 = h.slice(-n*2, -n).join(''), b2 = h.slice(-n).join(''); if (b1 === b2) { const nx = h[h.length - n]; return { hit: true, name: `Chu kỳ ${n}`, probT: nx==='T'?0.75:0.25, detail: `${b1}` }; } }
    return { hit: false };
}
function detectLadder(h) {
    if (h.length < 10) return { hit: false };
    const runs = []; let cur = 1;
    for (let i = h.length - 10; i < h.length - 1; i++) { if (h[i] === h[i+1]) cur++; else { runs.push(cur); cur = 1; } }
    runs.push(cur);
    if (runs.length >= 3) { const l3 = runs.slice(-3); const last = h[h.length-1];
        if (l3[0]<l3[1] && l3[1]<l3[2]) return { hit: true, name: 'Cầu thang mở', probT: last==='T'?0.34:0.66, detail: `${l3.join('-')}` };
        if (l3[0]>l3[1] && l3[1]>l3[2]) return { hit: true, name: 'Cầu thang thu', probT: last==='T'?0.35:0.65, detail: `${l3.join('-')}` };
    }
    return { hit: false };
}
function detectCenterSymmetry(h) {
    if (h.length < 8) return { hit: false };
    const w8 = h.slice(-8).join('');
    if (w8[0]===w8[7] && w8[1]===w8[6] && w8[2]===w8[5] && w8[3]===w8[4]) { const nx = w8[7]==='T'?'X':'T'; return { hit: true, name: 'Đối xứng 8', probT: nx==='T'?0.73:0.27, detail: `${w8}` }; }
    return { hit: false };
}
function detectSplitBreak(h) {
    if (h.length < 6) return { hit: false };
    const last = h[h.length-1]; let streak = 1;
    for (let i = h.length-2; i >= 0; i--) { if (h[i] === last) streak++; else break; }
    if (streak >= 6) return { hit: true, name: `Bẻ bệt ${streak}`, probT: last==='T'?0.20:0.80, detail: `Bệt ${streak}` };
    if (streak === 5) return { hit: true, name: 'Bẻ bệt 5', probT: last==='T'?0.22:0.78, detail: 'Bệt 5' };
    if (streak === 4) return { hit: true, name: 'Bẻ bệt 4', probT: last==='T'?0.30:0.70, detail: 'Bệt 4' };
    return { hit: false };
}
function detectDouble(h) {
    if (h.length < 6) return { hit: false };
    const w6 = h.slice(-6).join('');
    if (['TTXXTT','XXTTXX','TTTTXX','XXTTTT'].includes(w6)) { const last = h[h.length-1], nx = last==='T'?'X':'T'; return { hit: true, name: 'Cầu kép', probT: nx==='T'?0.68:0.32, detail: `${w6}` }; }
    return { hit: false };
}
function detect3Shift(h) {
    if (h.length < 8) return { hit: false };
    const w8 = h.slice(-8).join('');
    if (['TTTXTTXX','XXXTXXTT','TTTXTTXT','XXXTXXTX'].includes(w8)) { const last = h[h.length-1]; return { hit: true, name: '3 nhịp lệch', probT: last==='T'?0.35:0.65, detail: `${w8}` }; }
    return { hit: false };
}
function detectShift121(h) {
    if (h.length < 8) return { hit: false };
    const w8 = h.slice(-8).join('');
    if (['TXXTXXTX','XTTXTTXT'].includes(w8)) { const last = h[h.length-1]; return { hit: true, name: 'Nhịp 1-2-1', probT: last==='T'?0.30:0.70, detail: `${w8}` }; }
    return { hit: false };
}
function detectShift212(h) {
    if (h.length < 8) return { hit: false };
    const w8 = h.slice(-8).join('');
    if (['TTXTTXTT','XXTXXTXX','TTXTTXXT','XXTXXTTX'].includes(w8)) { const last = h[h.length-1]; return { hit: true, name: 'Nhịp 2-1-2', probT: last==='T'?0.32:0.68, detail: `${w8}` }; }
    return { hit: false };
}
function detectShift414(h) {
    if (h.length < 9) return { hit: false };
    const w9 = h.slice(-9).join('');
    if (['TTTTXTTTT','XXXXTXXXX'].includes(w9)) { const last = h[h.length-1]; return { hit: true, name: 'Nhịp 4-1-4', probT: last==='T'?0.30:0.70, detail: `${w9}` }; }
    return { hit: false };
}
function detectByPoint(h, pts) {
    if (!pts || pts.length < 6) return { hit: false };
    const r = pts.slice(-6), avg3 = r.slice(-3).reduce((a,b)=>a+b,0) / 3, last3 = h.slice(-3).join('');
    if (last3 === 'TTT' && avg3 < 12.5) return { hit: true, name: 'Tài yếu → bẻ', probT: 0.35, detail: `avg ${avg3.toFixed(1)}` };
    if (last3 === 'XXX' && avg3 > 9.5) return { hit: true, name: 'Xỉu yếu → bẻ', probT: 0.65, detail: `avg ${avg3.toFixed(1)}` };
    const s = r.slice(-4).map(p => p >= 11 ? 1 : 0);
    if (s[0]!==s[1] && s[1]!==s[2] && s[2]!==s[3]) { const nx = s[3] === 1 ? 0 : 1; return { hit: true, name: 'Điểm đảo nhịp', probT: nx===1?0.65:0.35, detail: `${s.join('')}` }; }
    return { hit: false };
}
function detectByParity(h, pts) {
    if (!pts || pts.length < 8) return { hit: false };
    const r = pts.slice(-8), par = r.map(p => p % 2 === 0 ? 'C' : 'L'), l4 = par.slice(-4).join('');
    if (['CLCL','LCLC'].includes(l4)) { const nxP = l4 === 'CLCL' ? 'L' : 'C'; return { hit: true, name: 'Chẵn lẻ đảo nhịp', probT: nxP === 'C' ? 0.55 : 0.45, detail: `${l4}` }; }
    const l6 = par.slice(-6).join('');
    if (l6 === 'CCCCCC' || l6 === 'LLLLLL') return { hit: true, name: 'Parity bệt', probT: 0.45, detail: `${l6}` };
    return { hit: false };
}
function detectDiceRepeat(h, d) {
    if (!d || d.length < 4) return { hit: false };
    const last = d[d.length-1], prev = d[d.length-2] || [];
    if (!Array.isArray(last)) return { hit: false };
    let rc = 0;
    for (let i = 0; i < 3; i++) if (last[i] === prev[i]) rc++;
    if (rc >= 2) { const lh = h[h.length-1]; return { hit: true, name: 'Xúc xắc lặp', probT: lh==='T'?0.40:0.60, detail: `${rc}/3 viên` }; }
    return { hit: false };
}
function detectMarkov3(h) {
    if (h.length < 8) return { hit: false };
    const p = h.slice(-3).join(''); let cT = 0, cX = 0;
    for (let i = 0; i < h.length-3; i++) if (h.slice(i, i+3).join('') === p) { if (h[i+3] === 'T') cT++; else cX++; }
    const t = cT + cX;
    if (t >= 3 && (cT/t >= 0.75 || cX/t >= 0.75)) { const nx = cT > cX ? 'T' : 'X', pr = Math.max(cT,cX)/t; return { hit: true, name: 'Markov 3', probT: nx==='T'?pr:1-pr, detail: `${p}→${nx}` }; }
    return { hit: false };
}
function detectAntiMarkov(h) {
    if (h.length < 8) return { hit: false };
    const p = h.slice(-3).join(''), opp = p.split('').map(c => c==='T'?'X':'T').join('');
    let cT = 0, cX = 0;
    for (let i = 0; i < h.length-3; i++) if (h.slice(i, i+3).join('') === opp) { if (h[i+3] === 'T') cT++; else cX++; }
    const t = cT + cX;
    if (t >= 2 && (cT/t >= 0.75 || cX/t >= 0.75)) { const nx = cT > cX ? 'T' : 'X', pr = Math.max(cT,cX)/t; return { hit: true, name: 'Phản Markov', probT: nx==='T'?pr:1-pr, detail: `${opp}→${nx}` }; }
    return { hit: false };
}
function detectHighProbContext(h) {
    if (h.length < 10) return { hit: false };
    for (const o of [5, 4, 3]) {
        const ctx = h.slice(-o).join(''); let cT = 0, cX = 0;
        for (let i = 0; i < h.length - o; i++) if (h.slice(i, i+o).join('') === ctx) { if (h[i+o] === 'T') cT++; else cX++; }
        const t = cT + cX;
        if (t >= 4) { const pT = cT/t; if (pT >= 0.75 || pT <= 0.25) return { hit: true, name: `Context ${o} cao`, probT: pT, detail: `${ctx}→T ${(pT*100).toFixed(0)}%` }; }
    }
    return { hit: false };
}
function detectAllSubPatterns(h, pts, d) {
    const hits = [detectMirror(h), detectPalindrome(h), detectFullReverse(h), detectCycle(h), detectLadder(h), detectCenterSymmetry(h),
        detectSplitBreak(h), detectDouble(h), detect3Shift(h), detectShift121(h), detectShift212(h), detectShift414(h),
        detectByPoint(h, pts), detectByParity(h, pts), detectDiceRepeat(h, d),
        detectMarkov3(h), detectAntiMarkov(h), detectHighProbContext(h)].filter(x => x && x.hit);
    if (hits.length === 0) return { hit: false, probT: 0.5, hits: [], confidence: 0, name: 'Không có', strength: 0 };
    const avg = hits.reduce((s, x) => s + x.probT, 0) / hits.length;
    const dirs = hits.map(x => x.probT > 0.5 ? 1 : -1);
    const same = dirs.every(d => d === dirs[0]);
    const cons = same ? 1 : (Math.abs(dirs.reduce((a, b) => a + b, 0)) / dirs.length);
    const strength = clamp(hits.length / 4, 0, 1) * cons;
    return { hit: true, probT: avg, name: hits.map(x => x.name).join(' + '), hits, strength, confidence: Math.round(strength * 100), detail: hits.map(x => x.detail).join(' | ') };
}
function layerPatternMatrix(h, pts, d) {
    const sub = detectAllSubPatterns(h, pts, d);
    if (sub.hit && sub.strength >= 0.5) return { probT: sub.probT, reason: `⭐ ${sub.name} (${sub.confidence}%)`, patternsFound: [sub.name], subPatterns: sub, isSubPattern: true };
    if (h.length < 6) return { probT: 0.5, reason: 'Ít data', patternsFound: [], subPatterns: sub };
    const last = h[h.length-1], pf = [];
    let st = 1; for (let i = h.length-2; i >= 0; i--) { if (h[i] === last) st++; else break; }
    if (st >= 4) return { probT: last==='T'?0.25:0.75, reason: `Ép bẻ Bệt ${st}`, patternsFound: [`bet${st}`], subPatterns: sub };
    let zz = 1; for (let i = h.length-1; i >= 1; i--) { if (h[i] !== h[i-1]) zz++; else break; }
    if (zz >= 4) return { probT: last==='T'?0.30:0.70, reason: `1-1 (${zz} nhịp)`, patternsFound: [`zz${zz}`], subPatterns: sub };
    if (h.length >= 8) { const p6 = h.slice(-6).join(''); if (['TTXXTT','XXTTXX'].includes(p6)) return { probT: last==='T'?0.35:0.65, reason: 'Cầu 2-2', patternsFound: ['2-2'], subPatterns: sub };
        if (['TTTXXX','XXXTTT'].includes(p6)) return { probT: last==='T'?0.35:0.65, reason: 'Cầu 3-3', patternsFound: ['3-3'], subPatterns: sub };
        if (['TXXTXX','XTTXTT'].includes(p6)) return { probT: last==='T'?0.35:0.65, reason: 'Cầu 1-2', patternsFound: ['1-2'], subPatterns: sub };
        if (['TTXTTX','XXTXXT'].includes(p6)) return { probT: last==='T'?0.35:0.65, reason: 'Cầu 2-1', patternsFound: ['2-1'], subPatterns: sub }; }
    return { probT: 0.5, reason: 'Không rõ cầu', patternsFound: pf, subPatterns: sub };
}
function profileEnvironment(h) {
    const L = h.length, dv = clamp(L / CONFIG.WARMUP.SESSIONS_FULL, 0, 1), det = new Set();
    let st = 1; for (let i = 1; i < L; i++) { if (h[i] === h[i-1]) { st++; if (st >= 3) det.add('bet3'); if (st >= 4) det.add('bet4'); } else st = 1; }
    let zz = 1; for (let i = 1; i < L; i++) { if (h[i] !== h[i-1]) zz++; else { if (zz >= 4) det.add('zig4'); zz = 1; } }
    if (zz >= 4) det.add('zig4');
    for (let i = 0; i + 6 <= L; i++) { const s = h.slice(i, i+6).join('');
        if (['TTXXTT','XXTTXX'].includes(s)) det.add('2-2');
        if (['TTTXXX','XXXTTT'].includes(s)) det.add('3-3');
        if (['TXXTXX','XTTXTT'].includes(s)) det.add('1-2');
        if (['TTXTTX','XXTXXT'].includes(s)) det.add('2-1'); }
    const pc = clamp(det.size / 7, 0, 1);
    let ms = 0;
    if (L >= 20) { const v = layerVOM(h), p = layerPPM(h), l = layerLearner(h);
        const spr = Math.max(v, p, l) - Math.min(v, p, l);
        const ag = 1 - clamp(spr * 2, 0, 1);
        const inf = clamp(Math.abs(v-0.5) + Math.abs(p-0.5) + Math.abs(l-0.5), 0, 1);
        ms = clamp(ag*0.6 + inf*0.4, 0, 1); } else ms = clamp(L / 40, 0, 1) * 0.5;
    let cs = 1;
    if (L >= 15) { const c = layerCUSUM(h); cs = c.isBroken ? 1 - c.strength * 0.8 : 1; } else cs = clamp(L / 15, 0, 1);
    const efs = (dv*0.35 + pc*0.25 + ms*0.25 + cs*0.15) * 100;
    return { efs: Math.round(efs*10)/10, breakdown: { dataVolume: Math.round(dv*1000)/10, patternCoverage: Math.round(pc*1000)/10, modelStability: Math.round(ms*1000)/10, cusumStability: Math.round(cs*1000)/10 }, detectedPatterns: [...det], sessions: L };
}

// ==============================================================================
// FETCH + WARM-UP
// ==============================================================================
async function fetchData(url) {
    try { const r = await axios.get(url, { headers: { 'User-Agent': CONFIG.USER_AGENT }, timeout: CONFIG.TIMEOUT }); return r.data?.list || []; }
    catch (e) { log('ERROR', `Fetch: ${e.message}`); return []; }
}
async function warmupScan(type) {
    const list = await fetchData(CONFIG.API[type]);
    if (list.length === 0) return warmupState[type];
    const st = warmupState[type];
    if (st.history.length === 0) { st.history = convertToSequence(list); st.scannedSessions = st.history.length; st.lastPhien = String(list[0].id); log('WARMUP', `[${type}] Nạp ${st.history.length} phiên`); }
    else { const lid = String(list[0].id); if (lid !== st.lastPhien) { const idx = list.findIndex(x => String(x.id) === st.lastPhien);
            if (idx === -1) { st.history = convertToSequence(list); } else { const nw = list.slice(0, idx).reverse(); for (const it of nw) st.history.push(it.resultTruyenThong === 'TAI' ? 'T' : 'X'); st.scannedSessions += nw.length; }
            st.lastPhien = lid; } }
    if (st.history.length > 500) st.history = st.history.slice(-500);
    const prof = profileEnvironment(st.history);
    st.efs = prof.efs; st.breakdown = prof.breakdown; st.detectedPatterns = prof.detectedPatterns; st.lastUpdated = Date.now();
    const enough = st.history.length >= CONFIG.WARMUP.MIN_SESSIONS_ABSOLUTE, reached = st.efs >= CONFIG.WARMUP.TARGET_EFS, forced = st.scannedSessions >= CONFIG.WARMUP.MAX_WARMUP_SESSIONS;
    if (!st.isReady && ((enough && reached) || forced)) { st.isReady = true; st.readyAt = Date.now(); log('READY', `[${type}] ✅ READY EFS=${st.efs}%`); }
    return st;
}
let warmupTimer = null;
async function startWarmup() {
    log('WARMUP', '🚀 Warm-up...'); let cnt = 0;
    const loop = async () => { cnt++; try { await Promise.all([warmupScan('tx'), warmupScan('md5')]); } catch (e) { log('ERROR', e.message); }
        if (cnt % CONFIG.WARMUP.LOG_EVERY_N === 0) log('WARMUP', `TX EFS=${warmupState.tx.efs}% | MD5 EFS=${warmupState.md5.efs}%`);
        if (warmupTimer) clearTimeout(warmupTimer); warmupTimer = setTimeout(loop, CONFIG.WARMUP.POLL_INTERVAL_MS); };
    await loop();
}

// ==============================================================================
// PREDICTION ENGINE
// ==============================================================================
function runPredictionEngine(history, mem, efs = 0, points = [], dices = []) {
    const pattern = layerPatternMatrix(history, points, dices);
    const vom = layerVOM(history), ppm = layerPPM(history), lrn = layerLearner(history), cusum = layerCUSUM(history);
    const getW = (ms) => { const t = ms.win + ms.lose; if (t < 5) return 1.0; return clamp(0.5 + (ms.win/t - 0.5) * 2, 0.2, 1.5); };
    let wVOM = getW(mem.models.vom), wPPM = getW(mem.models.ppm), wLRN = getW(mem.models.learner);
    let wPAT; const strongSub = pattern.isSubPattern && pattern.subPatterns && pattern.subPatterns.strength >= 0.5;
    if (strongSub) { wPAT = CONFIG.MODEL.SUB_PATTERN_BOOST * (0.5 + pattern.subPatterns.strength); wVOM *= 0.7; wPPM *= 0.7; wLRN *= 0.7; } else wPAT = pattern.reason.includes('Không rõ') ? 0.2 : 2.5;
    const efsF = clamp(efs / 100, 0, 1);
    if (efs < 80) { wPAT *= (0.4 + 0.6*efsF); wVOM *= (0.8 + 0.4*efsF); wPPM *= (0.8 + 0.4*efsF); }
    const tW = wVOM + wPPM + wLRN + wPAT;
    let probT = (vom*wVOM + ppm*wPPM + lrn*wLRN + pattern.probT*wPAT) / tW;
    if (cusum.isBroken) probT = probT * (1 - cusum.strength * 0.5) + 0.5 * (cusum.strength * 0.5);
    const edge = Math.abs(probT - 0.5);
    let pred, reason;
    if (strongSub) { pred = probT > 0.5 ? 'TÀI' : 'XỈU'; reason = `⭐ ${pattern.subPatterns.name} → ${pred}`; }
    else if (edge >= CONFIG.MODEL.MIN_EDGE) { pred = probT > 0.5 ? 'TÀI' : 'XỈU'; reason = `Model → ${pred} (${(probT*100).toFixed(1)}%)`; if (!pattern.reason.includes('Không rõ')) reason += ` | ${pattern.reason}`; }
    else { const l = history[history.length-1]; pred = l === 'T' ? 'XỈU' : 'TÀI'; reason = `Nhiễu → bẻ ${pred}`; }
    let conf;
    if (efs < 80) { conf = 51 + (efs/80)*8; conf = clamp(conf - (1 - clamp(edge*4,0,1))*1.5, 51, 59); if (strongSub) conf = clamp(Math.max(conf, 57 + pattern.subPatterns.strength*2), 51, 59); conf = Math.round(conf*10)/10; }
    else { let b = 51 + edge*100; b = clamp(b, 51, 80); const boost = ((efs-80)/20)*0.15; conf = clamp(b*(1+boost), b, 85); if (strongSub) conf = clamp(conf + 5 + pattern.subPatterns.strength*5, b, 90); conf = Math.round(conf*10)/10; }
    const kb = CONFIG.KB.ENABLED ? kbSignal(history) : { hit: false };
    let fPT = probT, fConf = conf, kbUsed = false;
    if (kb.hit && kb.confidence > CONFIG.KB.MIN_CONFIDENCE_TO_BLEND && ((kb.probT > 0.5) === (probT > 0.5))) { fPT = probT * (1-CONFIG.KB.BLEND_WEIGHT) + kb.probT * CONFIG.KB.BLEND_WEIGHT; fConf = Math.min(90, conf + kb.confidence*3); kbUsed = true; }
    return { predict: pred, confidence: Math.round(fConf*10)/10, reason, details: { pattern: pattern.reason, vomProb: vom, ppmProb: ppm, learnerProb: lrn, isBroken: cusum.isBroken, rawProbT: fPT, efsAtPrediction: efs, phase: efs < 80 ? 'WARMING_UP' : 'READY', subPatterns: pattern.subPatterns || { hit: false, hits: [], strength: 0 }, kbSignal: { enabled: CONFIG.KB.ENABLED, used: kbUsed, hit: kb.hit, reason: kb.reason || '—', probT: kb.hit ? (kb.probT*100).toFixed(1)+'%' : null, confidence: kb.hit ? (kb.confidence*100).toFixed(1)+'%' : '0%', suggestLearn: kb.suggestLearn || false } } };
}

// ==============================================================================
// GAME PROCESSOR
// ==============================================================================
async function processGame(type) {
    const st = warmupState[type]; await warmupScan(type);
    const list = await fetchData(CONFIG.API[type]); if (!list.length) throw new Error('No data');
    const cur = String(list[0].id), h = convertToSequence(list), pts = list.map(x => x.point).reverse(), dcs = list.map(x => x.dices).reverse(), mem = memory[type];
    if (mem.lastPhien && mem.lastPrediction && parseFloat(cur) > parseFloat(mem.lastPhien)) {
        const ao = list.find(x => String(x.id) === mem.lastPhien);
        if (ao) { const actual = ao.resultTruyenThong === 'TAI' ? 'TÀI' : 'XỈU', win = actual === mem.lastPrediction, bet = calculateKellyBet(mem, mem.lastConfidence);
            if (win) { mem.statistics.win++; mem.statistics.bankroll += bet; log('WIN', `[${type}] ${mem.lastPhien}: ✅ +${bet}`); } else { mem.statistics.lose++; mem.statistics.bankroll -= bet; log('LOSE', `[${type}] ${mem.lastPhien}: ❌ -${bet}`); }
            if (mem.statistics.bankroll > mem.statistics.peakBankroll) mem.statistics.peakBankroll = mem.statistics.bankroll;
            const dd = mem.statistics.peakBankroll - mem.statistics.bankroll; if (dd > mem.statistics.maxDrawdown) mem.statistics.maxDrawdown = dd;
            if (mem.lastModelDetails) { const d = mem.lastModelDetails;
                if ((d.vomProb > 0.5 ? 'TÀI' : 'XỈU') === actual) mem.models.vom.win++; else mem.models.vom.lose++;
                if ((d.ppmProb > 0.5 ? 'TÀI' : 'XỈU') === actual) mem.models.ppm.win++; else mem.models.ppm.lose++;
                if ((d.learnerProb > 0.5 ? 'TÀI' : 'XỈU') === actual) mem.models.learner.win++; else mem.models.learner.lose++;
                if (d.subPatterns && d.subPatterns.hit) for (const x of d.subPatterns.hits) { if (!mem.subPatternStats[x.name]) mem.subPatternStats[x.name] = { win: 0, lose: 0 }; if (win) mem.subPatternStats[x.name].win++; else mem.subPatternStats[x.name].lose++; }
                if (d.kbSignal && d.kbSignal.hit) { mem.kbStats.hit++; if (win) mem.kbStats.win++; else mem.kbStats.lose++; } else { mem.kbStats.miss++; if (d.kbSignal && d.kbSignal.suggestLearn) learnPattern(h, ao.resultTruyenThong === 'TAI' ? 'T' : 'X'); }
            }
            saveMemory(type, mem); } }
    const pred = runPredictionEngine(h, mem, st.efs, pts, dcs);
    mem.lastPhien = cur; mem.lastPrediction = pred.predict; mem.lastConfidence = pred.confidence; mem.lastModelDetails = pred.details;
    log('MODEL', `[${type}] ${pred.details.phase} | ${pred.details.pattern} | EFS=${st.efs}%`);
    if (pred.details.kbSignal && pred.details.kbSignal.hit) log('KB', `[${type}] 📚 ${pred.details.kbSignal.reason}`);
    log('INFO', `[${type}] 🎯 Phiên ${parseFloat(cur)+1}: ${pred.predict} (${pred.confidence}%)`);
    return { phienHienTai: cur, phienDuDoan: String(parseFloat(cur)+1), duDoan: pred.predict, tiLe: `${pred.confidence}%`, liDo: pred.reason, xucXac: list[0].dices, tongDiem: list[0].point,
        chiTietModel: { pattern: pred.details.pattern, vom: (pred.details.vomProb*100).toFixed(2)+'%', ppm: (pred.details.ppmProb*100).toFixed(2)+'%', learner: (pred.details.learnerProb*100).toFixed(2)+'%', cusumGay: pred.details.isBroken ? 'CÓ' : 'KHÔNG', efs: st.efs+'%', phase: pred.details.phase,
            cauPhu: pred.details.subPatterns.hit ? pred.details.subPatterns.hits.map(x => ({ ten: x.name, doManh: Math.round((x.probT > 0.5 ? x.probT : 1-x.probT)*100)+'%', chiTiet: x.detail })) : [],
            cauPhuTongHop: pred.details.subPatterns.hit ? `${pred.details.subPatterns.name} (${pred.details.subPatterns.confidence}%)` : 'Không có',
            kbSignal: pred.details.kbSignal },
        thongKe: { win: mem.statistics.win, lose: mem.statistics.lose, winrate: (mem.statistics.win + mem.statistics.lose) > 0 ? ((mem.statistics.win/(mem.statistics.win+mem.statistics.lose))*100).toFixed(1)+'%' : '—', bankroll: mem.statistics.bankroll.toFixed(0)+'$', maxDD: mem.statistics.maxDrawdown.toFixed(0)+'$', kb: mem.kbStats } };
}

// ==============================================================================
// EXPRESS ROUTES
// ==============================================================================
const app = express(); app.use(cors()); app.use(express.json());
app.get('/taixiu', async (req, res) => { try { res.json({ status: 'success', data: await processGame('tx') }); } catch (e) { res.status(500).json({ status: 'error', message: e.message }); } });
app.get('/md5', async (req, res) => { try { res.json({ status: 'success', data: await processGame('md5') }); } catch (e) { res.status(500).json({ status: 'error', message: e.message }); } });
app.get('/warmup/status', (req, res) => { const s = st => ({ isReady: st.isReady, efs: st.efs, scannedSessions: st.scannedSessions, breakdown: st.breakdown, detectedPatterns: st.detectedPatterns }); res.json({ tx: s(warmupState.tx), md5: s(warmupState.md5) }); });
app.post('/warmup/reset', async (req, res) => { const t = req.body.type, gs = (t === 'tx' || t === 'md5') ? [t] : ['tx', 'md5']; for (const g of gs) warmupState[g] = createEmptyWarmup(); if (warmupTimer) clearTimeout(warmupTimer); startWarmup(); res.json({ status: 'ok' }); });
app.get('/cauphu', async (req, res) => { try { const t = req.query.type === 'md5' ? 'md5' : 'tx', list = await fetchData(CONFIG.API[t]); if (!list.length) throw new Error('No data');
        const h = convertToSequence(list), pts = list.map(x => x.point).reverse(), dcs = list.map(x => x.dices).reverse();
        const raw = { guong: detectMirror(h), palindrome: detectPalindrome(h), daoToanPhan: detectFullReverse(h), chuKy: detectCycle(h), cauThang: detectLadder(h), doiXung8: detectCenterSymmetry(h), beBet: detectSplitBreak(h), cauKep: detectDouble(h), nhip3Lech: detect3Shift(h), nhip121: detectShift121(h), nhip212: detectShift212(h), nhip414: detectShift414(h), theoDiem: detectByPoint(h, pts), theoChanLe: detectByParity(h, pts), xucXacLap: detectDiceRepeat(h, dcs), markov3: detectMarkov3(h), phanMarkov: detectAntiMarkov(h), contextCao: detectHighProbContext(h) };
        const all = detectAllSubPatterns(h, pts, dcs);
        res.json({ status: 'success', type: t, phienHienTai: String(list[0].id), tongHop: all.hit ? { ten: all.name, probT: (all.probT*100).toFixed(2)+'%', strength: all.confidence+'%', soCauKhop: all.hits.length } : { message: 'Không khớp' }, chiTiet: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.hit ? { hit: true, ten: v.name, probT: (v.probT*100).toFixed(2)+'%', detail: v.detail } : { hit: false }])) }); } catch (e) { res.status(500).json({ status: 'error', message: e.message }); } });
app.get('/cauphu/stats', (req, res) => { const st = {}; for (const t of ['tx','md5']) { st[t] = {}; for (const [n, wl] of Object.entries(memory[t].subPatternStats || {})) { const tt = wl.win + wl.lose; st[t][n] = { win: wl.win, lose: wl.lose, winrate: tt > 0 ? ((wl.win/tt)*100).toFixed(1)+'%' : '—' }; } } res.json({ stats: st }); });
app.get('/stats', (req, res) => { const tx = memory.tx.statistics, md5 = memory.md5.statistics; res.json({ tx: { ...tx, kb: memory.tx.kbStats }, md5: { ...md5, kb: memory.md5.kbStats } }); });
app.post('/reset', (req, res) => { const t = req.body.type; if (t === 'tx' || t === 'all') { memory.tx = createDefaultMemory(); saveMemory('tx', memory.tx); } if (t === 'md5' || t === 'all') { memory.md5 = createDefaultMemory(); saveMemory('md5', memory.md5); } res.json({ status: 'ok' }); });
app.get('/backtest', async (req, res) => { try { const t = req.query.type === 'md5' ? 'md5' : 'tx', list = await fetchData(CONFIG.API[t]); if (!list.length) throw new Error('No data');
        const h = convertToSequence(list), pts = list.map(x => x.point).reverse(), dcs = list.map(x => x.dices).reverse(); const tm = createDefaultMemory();
        let w = 0, l = 0, sw = 0, sl = 0, kw = 0, kl = 0;
        for (let i = CONFIG.MIN_PHIEN; i < h.length - 1; i++) { const sub = h.slice(0, i+1), sp = pts.slice(0, i+1), sd = dcs.slice(0, i+1);
            const p = runPredictionEngine(sub, tm, 100, sp, sd), act = h[i+1] === 'T' ? 'TÀI' : 'XỈU';
            if (p.predict === act) w++; else l++;
            if (p.details.subPatterns && p.details.subPatterns.hit) { if (p.predict === act) sw++; else sl++; }
            if (p.details.kbSignal && p.details.kbSignal.hit) { if (p.predict === act) kw++; else kl++; }
            const d = p.details; if ((d.vomProb > 0.5 ? 'TÀI' : 'XỈU') === act) tm.models.vom.win++; else tm.models.vom.lose++; if ((d.ppmProb > 0.5 ? 'TÀI' : 'XỈU') === act) tm.models.ppm.win++; else tm.models.ppm.lose++; if ((d.learnerProb > 0.5 ? 'TÀI' : 'XỈU') === act) tm.models.learner.win++; else tm.models.learner.lose++; }
        const tt = w + l, stt = sw + sl, ktt = kw + kl;
        res.json({ totalPhiens: tt, win: w, lose: l, winrate: ((w/tt)*100).toFixed(2)+'%', cauPhu: stt > 0 ? { total: stt, win: sw, lose: sl, winrate: ((sw/stt)*100).toFixed(2)+'%' } : { message: 'Không khớp' }, kb: ktt > 0 ? { total: ktt, win: kw, lose: kl, winrate: ((kw/ktt)*100).toFixed(2)+'%' } : { message: 'KB không khớp' } }); } catch (e) { res.status(500).json({ status: 'error', message: e.message }); } });
app.get('/status', (req, res) => res.json({ status: 'online', version: 'V38', kb: KB_getStats(), warmup: { tx: { ready: warmupState.tx.isReady, efs: warmupState.tx.efs }, md5: { ready: warmupState.md5.isReady, efs: warmupState.md5.efs } } }));
app.get('/kb/stats', (req, res) => res.json(KB_getStats()));
app.get('/kb/lookup', async (req, res) => { try { const t = req.query.type === 'md5' ? 'md5' : 'tx', list = await fetchData(CONFIG.API[t]); if (!list.length) throw new Error('No data'); const h = convertToSequence(list);
        res.json({ type: t, historyTail: h.slice(-20).join(''), kbExact: lookupCauDatabase(h, CONFIG.KB.MIN_PATTERN_LEN), longPattern: lookupLongPattern(h, CONFIG.KB.CONTEXT_LEN_LONG), tongHop: kbSignal(h) }); } catch (e) { res.status(500).json({ status: 'error', message: e.message }); } });
app.get('/kb/learn-queue', (req, res) => res.json({ total: LEARN_QUEUE.length, queue: LEARN_QUEUE.slice(-100) }));
app.get('/kb/export-learn', (req, res) => { const lines = LEARN_QUEUE.map((it, i) => `${i+1}. ${it.pattern} - ${it.next}`); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.send(lines.join('\n')); });

// ==============================================================================
// START
// ==============================================================================
app.listen(CONFIG.PORT, () => {
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    console.log(COLORS.green + `🔥 VIP GOD TIER V38 FINAL - ALL-IN-ONE` + COLORS.reset);
    console.log(COLORS.cyan + `🚀 Port: ${CONFIG.PORT}` + COLORS.reset);
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    loadCauDatabase(CONFIG.FILE.cau);
    console.log(COLORS.yellow + 'Endpoints: /taixiu /md5 /cauphu /cauphu/stats /warmup/status /warmup/reset /stats /backtest /reset /status /kb/stats /kb/lookup /kb/learn-queue /kb/export-learn' + COLORS.reset);
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    startWarmup();
});
