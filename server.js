/**
 * ==============================================================================
 * VIP GOD TIER AI - V36 (ULTIMATE — FULL SUB-PATTERNS + WARM-UP + ADAPTIVE CONF)
 * ==============================================================================
 * Tổng hợp:
 *  - V32: 5 layer thuật toán gốc (Pattern, VOM, PPM, Learner, CUSUM)
 *  - V33: Warm-up EFS (Environment Familiarity Score)
 *  - V34: Confidence thích ứng (51-59% warm-up → tăng dần READY)
 *  - V35: 9 cầu phụ cực chuẩn
 *  - V36: THÊM 9 cầu phụ nâng cao (tổng 18) + fix lỗi V35
 * ==============================================================================
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ==============================================================================
// PHẦN 1: CẤU HÌNH
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    API: {
        tx: 'https://wtx.tele68.com/v1/tx/sessions',
        md5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions'
    },
    TIMEOUT: 15000,
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',

    WARMUP: {
        TARGET_EFS: 80,
        MIN_SESSIONS_ABSOLUTE: 10,
        SESSIONS_FULL: 100,
        POLL_INTERVAL_MS: 3000,
        MAX_WARMUP_SESSIONS: 300,
        LOG_EVERY_N: 5
    },

    MIN_PHIEN: 15,
    FILE: {
        tx: path.join(__dirname, 'v36_tx_data.json'),
        md5: path.join(__dirname, 'v36_md5_data.json')
    },
    BANKROLL: {
        INITIAL: 1000, BASE_BET: 10, MAX_BET: 100,
        STOP_LOSS: 500, TAKE_PROFIT: 2000
    },
    MODEL: {
        MAX_ORDER: 6, MIN_SAMPLES: 4,
        LAPLACE_ALPHA: 1.0,
        CUSUM_THRESHOLD: 5.0,
        MIN_EDGE: 0.015,
        SUB_PATTERN_MIN_HITS: 2,
        SUB_PATTERN_BOOST: 3.5
    }
};

// ==============================================================================
// PHẦN 2: LOGGER
// ==============================================================================
const COLORS = {
    reset:'\x1b[0m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
    blue:'\x1b[34m', magenta:'\x1b[35m', cyan:'\x1b[36m', gray:'\x1b[90m'
};
function log(level, message) {
    const ts = new Date().toLocaleTimeString();
    let color = COLORS.reset;
    if (level==='INFO') color=COLORS.cyan;
    if (level==='WARN') color=COLORS.yellow;
    if (level==='ERROR') color=COLORS.red;
    if (level==='WIN') color=COLORS.green;
    if (level==='LOSE') color=COLORS.red;
    if (level==='MODEL') color=COLORS.magenta;
    if (level==='WARMUP') color=COLORS.blue;
    if (level==='READY') color=COLORS.green;
    if (level==='SUB') color=COLORS.yellow;
    console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${message}`);
}

// ==============================================================================
// PHẦN 3: PERSISTENCE
// ==============================================================================
function createDefaultMemory() {
    return {
        lastPhien: null, lastPrediction: null, lastConfidence: null, lastModelDetails: null,
        statistics: {
            win: 0, lose: 0,
            bankroll: CONFIG.BANKROLL.INITIAL,
            peakBankroll: CONFIG.BANKROLL.INITIAL,
            maxDrawdown: 0, isStopped: false
        },
        models: {
            vom: { win: 0, lose: 0 },
            ppm: { win: 0, lose: 0 },
            learner: { win: 0, lose: 0 }
        },
        subPatternStats: {} // thống kê win/lose theo từng cầu phụ
    };
}
function loadMemory(type) {
    try {
        if (fs.existsSync(CONFIG.FILE[type])) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG.FILE[type], 'utf8'));
            return { ...createDefaultMemory(), ...parsed };
        }
    } catch (e) { log('ERROR', `Load ${type}: ${e.message}`); }
    return createDefaultMemory();
}
function saveMemory(type, mem) {
    try { fs.writeFileSync(CONFIG.FILE[type], JSON.stringify(mem, null, 2), 'utf8'); }
    catch (e) { log('ERROR', `Save ${type}: ${e.message}`); }
}
const memory = { tx: loadMemory('tx'), md5: loadMemory('md5') };

// ==============================================================================
// PHẦN 4: WARM-UP STATE
// ==============================================================================
const warmupState = {
    tx:  createEmptyWarmup(),
    md5: createEmptyWarmup()
};
function createEmptyWarmup() {
    return {
        isReady: false, efs: 0, scannedSessions: 0,
        breakdown: { dataVolume: 0, patternCoverage: 0, modelStability: 0, cusumStability: 0 },
        readyAt: null, history: [], lastUpdated: null, lastPhien: null,
        detectedPatterns: []
    };
}

// ==============================================================================
// PHẦN 5: UTILITIES
// ==============================================================================
function convertToSequence(list) {
    return list.map(i => i.resultTruyenThong === 'TAI' ? 'T' : 'X').reverse();
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function calculateKellyBet(mem, confidence) {
    if (mem.statistics.isStopped) return 0;
    const p = confidence / 100;
    const kelly = Math.max(0, 2 * p - 1);
    return clamp(CONFIG.BANKROLL.BASE_BET * (1 + kelly * 3), CONFIG.BANKROLL.BASE_BET, CONFIG.BANKROLL.MAX_BET);
}

// ==============================================================================
// PHẦN 6: ALGORITHM LAYERS CƠ BẢN
// ==============================================================================
function layerVOM(history) {
    if (history.length < 5) return 0.5;
    for (let order = CONFIG.MODEL.MAX_ORDER; order >= 1; order--) {
        if (history.length <= order) continue;
        const ctx = history.slice(-order).join('');
        let cT = 0, cX = 0;
        for (let i = 0; i < history.length - order; i++) {
            if (history.slice(i, i + order).join('') === ctx) {
                if (history[i + order] === 'T') cT++; else cX++;
            }
        }
        const total = cT + cX;
        if (total >= CONFIG.MODEL.MIN_SAMPLES) {
            return (cT + CONFIG.MODEL.LAPLACE_ALPHA) / (total + 2 * CONFIG.MODEL.LAPLACE_ALPHA);
        }
    }
    return 0.5;
}
function layerPPM(history) {
    if (history.length < 5) return 0.5;
    const tables = {};
    for (let o = 1; o <= CONFIG.MODEL.MAX_ORDER; o++) tables[o] = {};
    for (let i = 0; i < history.length - 1; i++) {
        for (let o = 1; o <= CONFIG.MODEL.MAX_ORDER; o++) {
            if (i < o) continue;
            const ctx = history.slice(i - o, i).join('');
            const next = history[i];
            if (!tables[o][ctx]) tables[o][ctx] = { T: 0, X: 0 };
            if (next === 'T') tables[o][ctx].T++; else tables[o][ctx].X++;
        }
    }
    let escapeProb = 1.0;
    for (let o = CONFIG.MODEL.MAX_ORDER; o >= 1; o--) {
        if (history.length < o) continue;
        const ctx = history.slice(-o).join('');
        const t = tables[o][ctx];
        if (!t) continue;
        const total = t.T + t.X;
        if (total === 0) continue;
        const unique = (t.T > 0 ? 1 : 0) + (t.X > 0 ? 1 : 0);
        const pT = (t.T / (total + unique)) * escapeProb;
        const pX = (t.X / (total + unique)) * escapeProb;
        if (total >= 2) return pT / (pT + pX + 1e-9);
        escapeProb *= (unique / (total + unique));
    }
    return 0.5;
}
function layerLearner(history) {
    if (history.length < 12) return 0.5;
    const N = 4;
    const current = history.slice(-N).join('');
    let cT = 0, cX = 0;
    for (let i = 0; i < history.length - N; i++) {
        if (history.slice(i, i + N).join('') === current) {
            if (history[i + N] === 'T') cT++; else cX++;
        }
    }
    const total = cT + cX;
    if (total === 0) return 0.5;
    return (cT + 1) / (total + 2);
}
function layerCUSUM(history) {
    if (history.length < 15) return { isBroken: false, strength: 0 };
    const vals = history.map(x => x === 'T' ? 1 : 0);
    let sHi = 0, sLo = 0, maxS = 0;
    for (const v of vals) {
        sHi = Math.max(0, sHi + (v - 0.6));
        sLo = Math.max(0, sLo + (0.4 - v));
        maxS = Math.max(maxS, sHi, sLo);
    }
    return { isBroken: maxS > CONFIG.MODEL.CUSUM_THRESHOLD, strength: clamp(maxS / 10, 0, 1) };
}

// ==============================================================================
// PHẦN 7: 18 CẦU PHỤ CỰC CHUẨN
// ==============================================================================

// ---------- NHÓM 1: CẦU HÌNH HỌC ----------

// #1 Gương
function detectMirror(history) {
    const L = history.length;
    if (L < 4) return { hit: false };
    const w4 = history.slice(-4).join('');
    if (w4[0]===w4[3] && w4[1]===w4[2] && w4[0]!==w4[1]) {
        const next = w4[3]==='T' ? 'X' : 'T';
        return { hit: true, name: 'Gương ABBA', probT: next==='T'?0.72:0.28, detail: `Chuỗi ${w4} → dự đoán ${next}` };
    }
    if (L >= 6) {
        const w6 = history.slice(-6).join('');
        if (w6[0]===w6[5] && w6[1]===w6[4] && w6[2]===w6[3] && w6[0]!==w6[1]) {
            const next = w6[5]==='T' ? 'X' : 'T';
            return { hit: true, name: 'Gương ABCCBA', probT: next==='T'?0.74:0.26, detail: `Chuỗi ${w6} đối xứng kép` };
        }
    }
    return { hit: false };
}

// #2 Palindrome
function detectPalindrome(history) {
    const L = history.length;
    if (L < 5) return { hit: false };
    for (const n of [5, 7]) {
        if (L < n) continue;
        const w = history.slice(-n);
        if (w.join('') === w.slice().reverse().join('')) {
            const next = history[L - n];
            return { hit: true, name: `Palindrome ${n}`, probT: next==='T'?0.74:0.26, detail: `Chuỗi ${w.join('')} đối xứng` };
        }
    }
    return { hit: false };
}

// #3 Đảo toàn phần
function detectFullReverse(history) {
    const L = history.length;
    if (L < 6) return { hit: false };
    const n = Math.min(5, Math.floor(L / 2));
    if (n < 3) return { hit: false };
    const b1 = history.slice(-n * 2, -n).join('');
    const b2 = history.slice(-n).join('');
    let isRev = true;
    for (let i = 0; i < n; i++) if (b1[i] === b2[i]) { isRev = false; break; }
    if (isRev) {
        const next = b1[0];
        return { hit: true, name: 'Đảo toàn phần', probT: next==='T'?0.70:0.30, detail: `${b1} ↔ ${b2} đảo ngược` };
    }
    return { hit: false };
}

// #4 Chu kỳ
function detectCycle(history) {
    const L = history.length;
    if (L < 6) return { hit: false };
    for (const n of [2, 3, 4]) {
        if (L < n * 2) continue;
        const b1 = history.slice(-n * 2, -n).join('');
        const b2 = history.slice(-n).join('');
        if (b1 === b2) {
            const next = history[L - n];
            return { hit: true, name: `Chu kỳ ${n}`, probT: next==='T'?0.75:0.25, detail: `${b1} lặp lại` };
        }
    }
    return { hit: false };
}

// #5 Cầu thang
function detectLadder(history) {
    const L = history.length;
    if (L < 10) return { hit: false };
    const runs = [];
    let cur = 1;
    for (let i = L - 10; i < L - 1; i++) {
        if (history[i] === history[i + 1]) cur++;
        else { runs.push(cur); cur = 1; }
    }
    runs.push(cur);
    if (runs.length >= 3) {
        const last3 = runs.slice(-3);
        if (last3[0] < last3[1] && last3[1] < last3[2]) {
            const last = history[L - 1];
            return { hit: true, name: 'Cầu thang mở', probT: last==='T'?0.34:0.66, detail: `Run ${last3.join('-')} mở rộng` };
        }
        if (last3[0] > last3[1] && last3[1] > last3[2]) {
            const last = history[L - 1];
            return { hit: true, name: 'Cầu thang thu', probT: last==='T'?0.35:0.65, detail: `Run ${last3.join('-')} thu hẹp` };
        }
    }
    return { hit: false };
}

// #6 Đối xứng trục giữa (8 phiên)
function detectCenterSymmetry(history) {
    const L = history.length;
    if (L < 8) return { hit: false };
    const w8 = history.slice(-8).join('');
    // AB CD DC BA
    if (w8[0]===w8[7] && w8[1]===w8[6] && w8[2]===w8[5] && w8[3]===w8[4]) {
        const next = w8[7]==='T' ? 'X' : 'T';
        return { hit: true, name: 'Đối xứng 8', probT: next==='T'?0.73:0.27, detail: `Chuỗi ${w8} đối xứng trục giữa` };
    }
    return { hit: false };
}

// ---------- NHÓM 2: CẦU NHỊP ----------

// #7 Bẻ bệt
function detectSplitBreak(history) {
    const L = history.length;
    if (L < 6) return { hit: false };
    const last = history[L - 1];
    let streak = 1;
    for (let i = L - 2; i >= 0; i--) {
        if (history[i] === last) streak++; else break;
    }
    if (streak >= 6) return { hit: true, name: `Bẻ bệt ${streak}`, probT: last==='T'?0.20:0.80, detail: `Bệt ${streak} cực mạnh` };
    if (streak === 5) return { hit: true, name: 'Bẻ bệt 5', probT: last==='T'?0.22:0.78, detail: `Bệt 5` };
    if (streak === 4) return { hit: true, name: 'Bẻ bệt 4', probT: last==='T'?0.30:0.70, detail: `Bệt 4` };
    return { hit: false };
}

// #8 Cầu kép
function detectDouble(history) {
    const L = history.length;
    if (L < 6) return { hit: false };
    const w6 = history.slice(-6).join('');
    const pats = ['TTXXTT', 'XXTTXX', 'TTTTXX', 'XXTTTT', 'TTXX XX'.replace(/\s/g,'')];
    if (['TTXXTT','XXTTXX','TTTTXX','XXTTTT'].includes(w6)) {
        const last = history[L - 1];
        const next = last === 'T' ? 'X' : 'T';
        return { hit: true, name: 'Cầu kép', probT: next==='T'?0.68:0.32, detail: `Chuỗi ${w6}` };
    }
    return { hit: false };
}

// #9 Nhịp 3 lệch
function detect3Shift(history) {
    const L = history.length;
    if (L < 8) return { hit: false };
    const w8 = history.slice(-8).join('');
    if (['TTTXTTXX','XXXTXXTT','TTTXTTXT','XXXTXXTX'].includes(w8)) {
        const last = history[L - 1];
        return { hit: true, name: '3 nhịp lệch', probT: last==='T'?0.35:0.65, detail: `Chuỗi ${w8}` };
    }
    return { hit: false };
}

// #10 Nhịp 1-2-1
function detectShift121(history) {
    const L = history.length;
    if (L < 8) return { hit: false };
    const w8 = history.slice(-8).join('');
    if (['TXXTXXTXX'.slice(0,8),'XTTXTTXT'].includes(w8) ||
        ['TXXTXXTX','XTTXTTXT'].includes(w8)) {
        const last = history[L - 1];
        return { hit: true, name: 'Nhịp 1-2-1', probT: last==='T'?0.30:0.70, detail: `Chuỗi ${w8}` };
    }
    return { hit: false };
}

// #11 Nhịp 2-1-2
function detectShift212(history) {
    const L = history.length;
    if (L < 8) return { hit: false };
    const w8 = history.slice(-8).join('');
    if (['TTXTTXTT','XXTXXTXX','TTXTTXXT','XXTXXTTX'].includes(w8)) {
        const last = history[L - 1];
        return { hit: true, name: 'Nhịp 2-1-2', probT: last==='T'?0.32:0.68, detail: `Chuỗi ${w8}` };
    }
    return { hit: false };
}

// #12 Nhịp 4-1-4
function detectShift414(history) {
    const L = history.length;
    if (L < 9) return { hit: false };
    const w9 = history.slice(-9).join('');
    if (['TTTTXTTTT','XXXXTXXXX'].includes(w9)) {
        const last = history[L - 1];
        return { hit: true, name: 'Nhịp 4-1-4', probT: last==='T'?0.30:0.70, detail: `Chuỗi ${w9}` };
    }
    return { hit: false };
}

// ---------- NHÓM 3: CẦU THỐNG KÊ ----------

// #13 Theo tổng điểm
function detectByPoint(history, points) {
    if (!points || points.length < 6) return { hit: false };
    const recent = points.slice(-6);
    const avg3 = recent.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const last3 = history.slice(-3).join('');
    if (last3 === 'TTT' && avg3 < 12.5) {
        return { hit: true, name: 'Tài yếu → bẻ', probT: 0.35, detail: `3 Tài nhưng điểm TB thấp (${avg3.toFixed(1)})` };
    }
    if (last3 === 'XXX' && avg3 > 9.5) {
        return { hit: true, name: 'Xỉu yếu → bẻ', probT: 0.65, detail: `3 Xỉu nhưng điểm TB cao (${avg3.toFixed(1)})` };
    }
    const signs = recent.slice(-4).map(p => p >= 11 ? 1 : 0);
    if (signs[0]!==signs[1] && signs[1]!==signs[2] && signs[2]!==signs[3]) {
        const next = signs[3] === 1 ? 0 : 1;
        return { hit: true, name: 'Điểm đảo nhịp', probT: next===1?0.65:0.35, detail: `Điểm ${signs.join('')}` };
    }
    return { hit: false };
}

// #14 Theo chẵn/lẻ
function detectByParity(history, points) {
    if (!points || points.length < 8) return { hit: false };
    const recent = points.slice(-8);
    const parities = recent.map(p => p % 2 === 0 ? 'C' : 'L');
    // 4 phiên gần nhất: C L C L hoặc L C L C
    const last4 = parities.slice(-4).join('');
    if (['CLCL','LCLC'].includes(last4)) {
        const nextP = last4 === 'CLCL' ? 'L' : 'C';
        const lastHist = history[history.length - 1];
        // Dựa vào tương quan lịch sử: nếu Tài/Xỉu đồng hành với chẵn/lẻ tương ứng
        // heuristic: dự đoán theo hướng giữ nhịp chẵn/lẻ
        return {
            hit: true,
            name: 'Chẵn lẻ đảo nhịp',
            probT: nextP === 'C' ? 0.55 : 0.45,
            detail: `Parity ${last4} → nhịp ${nextP}`
        };
    }
    // 6 phiên liên tiếp cùng parity
    const last6 = parities.slice(-6).join('');
    if (last6 === 'CCCCCC' || last6 === 'LLLLLL') {
        return { hit: true, name: 'Parity bệt', probT: 0.45, detail: `6 phiên cùng parity ${last6}` };
    }
    return { hit: false };
}

// #15 Xúc xắc lặp
function detectDiceRepeat(history, dices) {
    if (!dices || dices.length < 4) return { hit: false };
    // dices gần nhất
    const last = dices[dices.length - 1];
    if (!last || !Array.isArray(last)) return { hit: false };
    // đếm số viên lặp lại với 2 phiên trước
    let repeatCount = 0;
    const prev = dices[dices.length - 2] || [];
    for (let i = 0; i < 3; i++) {
        if (last[i] === prev[i]) repeatCount++;
    }
    if (repeatCount >= 2) {
        const lastHist = history[history.length - 1];
        // Xu hướng: khi 2-3 viên lặp → thường đảo kết quả
        return {
            hit: true,
            name: 'Xúc xắc lặp',
            probT: lastHist === 'T' ? 0.40 : 0.60,
            detail: `${repeatCount}/3 viên lặp → dự đoán đảo`
        };
    }
    return { hit: false };
}

// ---------- NHÓM 4: CẦU MARKOV NÂNG CAO ----------

// #16 Markov bậc 3 (theo mẫu 3 phiên cũ, tìm phiên tiếp phổ biến)
function detectMarkov3(history) {
    const L = history.length;
    if (L < 8) return { hit: false };
    const pattern = history.slice(-3).join('');
    let cT = 0, cX = 0;
    for (let i = 0; i < L - 3; i++) {
        if (history.slice(i, i + 3).join('') === pattern) {
            if (history[i + 3] === 'T') cT++; else cX++;
        }
    }
    const total = cT + cX;
    if (total >= 3 && (cT / total >= 0.75 || cX / total >= 0.75)) {
        const next = cT > cX ? 'T' : 'X';
        const p = Math.max(cT, cX) / total;
        return {
            hit: true,
            name: 'Markov bậc 3',
            probT: next === 'T' ? p : 1 - p,
            detail: `Pattern ${pattern} → ${next} (${(p*100).toFixed(0)}%)`
        };
    }
    return { hit: false };
}

// #17 Phản Markov
function detectAntiMarkov(history) {
    const L = history.length;
    if (L < 8) return { hit: false };
    const pattern = history.slice(-3).join('');
    const opposite = pattern.split('').map(c => c === 'T' ? 'X' : 'T').join('');
    let cT = 0, cX = 0;
    for (let i = 0; i < L - 3; i++) {
        if (history.slice(i, i + 3).join('') === opposite) {
            if (history[i + 3] === 'T') cT++; else cX++;
        }
    }
    const total = cT + cX;
    if (total >= 2 && (cT / total >= 0.75 || cX / total >= 0.75)) {
        const next = cT > cX ? 'T' : 'X';
        const p = Math.max(cT, cX) / total;
        return {
            hit: true,
            name: 'Phản Markov',
            probT: next === 'T' ? p : 1 - p,
            detail: `Pattern đảo ${opposite} → ${next} (${(p*100).toFixed(0)}%)`
        };
    }
    return { hit: false };
}

// #18 Xác suất cao — context 5 phiên, hit ≥75%
function detectHighProbContext(history) {
    const L = history.length;
    if (L < 10) return { hit: false };
    for (const order of [5, 4, 3]) {
        const ctx = history.slice(-order).join('');
        let cT = 0, cX = 0;
        for (let i = 0; i < L - order; i++) {
            if (history.slice(i, i + order).join('') === ctx) {
                if (history[i + order] === 'T') cT++; else cX++;
            }
        }
        const total = cT + cX;
        if (total >= 4) {
            const pT = cT / total;
            if (pT >= 0.75 || pT <= 0.25) {
                return {
                    hit: true,
                    name: `Context ${order} cao`,
                    probT: pT,
                    detail: `Context ${ctx} → Tài ${(pT*100).toFixed(0)}%`
                };
            }
        }
    }
    return { hit: false };
}

// ==============================================================================
// PHẦN 8: TỔNG HỢP 18 CẦU PHỤ
// ==============================================================================
function detectAllSubPatterns(history, points, dices) {
    const detectors = [
        // Nhóm 1: hình học
        detectMirror(history),
        detectPalindrome(history),
        detectFullReverse(history),
        detectCycle(history),
        detectLadder(history),
        detectCenterSymmetry(history),
        // Nhóm 2: nhịp
        detectSplitBreak(history),
        detectDouble(history),
        detect3Shift(history),
        detectShift121(history),
        detectShift212(history),
        detectShift414(history),
        // Nhóm 3: thống kê
        detectByPoint(history, points),
        detectByParity(history, points),
        detectDiceRepeat(history, dices),
        // Nhóm 4: Markov nâng cao
        detectMarkov3(history),
        detectAntiMarkov(history),
        detectHighProbContext(history)
    ];

    const hits = detectors.filter(d => d && d.hit);
    if (hits.length === 0) {
        return { hit: false, probT: 0.5, hits: [], confidence: 0, name: 'Không có cầu phụ', strength: 0 };
    }

    const avgProbT = hits.reduce((s, d) => s + d.probT, 0) / hits.length;
    const directions = hits.map(h => h.probT > 0.5 ? 1 : -1);
    const sameDir = directions.every(d => d === directions[0]);
    const consistency = sameDir ? 1 : (Math.abs(directions.reduce((a, b) => a + b, 0)) / directions.length);
    const strength = clamp(hits.length / 4, 0, 1) * consistency;

    return {
        hit: true,
        probT: avgProbT,
        name: hits.map(h => h.name).join(' + '),
        hits,
        strength,
        confidence: Math.round(strength * 100),
        detail: hits.map(h => h.detail).join(' | ')
    };
}

// ==============================================================================
// PHẦN 9: PATTERN MATRIX (có tích hợp cầu phụ)
// ==============================================================================
function layerPatternMatrix(history, points, dices) {
    const L = history.length;
    const sub = detectAllSubPatterns(history, points, dices);

    if (sub.hit && sub.strength >= 0.5) {
        return {
            probT: sub.probT,
            reason: `⭐ CẦU PHỤ: ${sub.name} (strength ${sub.confidence}%)`,
            patternsFound: [sub.name],
            subPatterns: sub,
            isSubPattern: true
        };
    }

    if (L < 6) return { probT: 0.5, reason: 'Ít data', patternsFound: [], subPatterns: sub };

    const last = history[L - 1];
    const patternsFound = [];

    let streak = 1;
    for (let i = L - 2; i >= 0; i--) { if (history[i] === last) streak++; else break; }
    if (streak >= 4) {
        patternsFound.push(`bet${streak}`);
        return { probT: last==='T'?0.25:0.75, reason: `Ép bẻ Bệt ${streak}`, patternsFound, subPatterns: sub };
    }
    if (streak === 3) patternsFound.push('bet3');

    let zigzag = 1;
    for (let i = L - 1; i >= 1; i--) { if (history[i] !== history[i-1]) zigzag++; else break; }
    if (zigzag >= 4) {
        patternsFound.push(`zigzag${zigzag}`);
        return { probT: last==='T'?0.30:0.70, reason: `Cầu 1-1 (${zigzag} nhịp)`, patternsFound, subPatterns: sub };
    }

    if (L >= 8) {
        const p6 = history.slice(-6).join('');
        if (['TTXXTT','XXTTXX'].includes(p6)) { patternsFound.push('2-2'); return { probT: last==='T'?0.35:0.65, reason:'Cầu 2-2', patternsFound, subPatterns: sub }; }
        if (['TTTXXX','XXXTTT'].includes(p6)) { patternsFound.push('3-3'); return { probT: last==='T'?0.35:0.65, reason:'Cầu 3-3', patternsFound, subPatterns: sub }; }
        if (['TXXTXX','XTTXTT'].includes(p6)) { patternsFound.push('1-2'); return { probT: last==='T'?0.35:0.65, reason:'Cầu 1-2', patternsFound, subPatterns: sub }; }
        if (['TTXTTX','XXTXXT'].includes(p6)) { patternsFound.push('2-1'); return { probT: last==='T'?0.35:0.65, reason:'Cầu 2-1', patternsFound, subPatterns: sub }; }
    }

    return { probT: 0.5, reason: 'Không rõ cầu', patternsFound, subPatterns: sub };
}

// ==============================================================================
// PHẦN 10: ENV PROFILER + EFS
// ==============================================================================
function profileEnvironment(history) {
    const L = history.length;
    const dataVolume = clamp(L / CONFIG.WARMUP.SESSIONS_FULL, 0, 1);

    // Pattern coverage
    let detected = new Set();
    let streak = 1;
    for (let i = 1; i < L; i++) {
        if (history[i] === history[i-1]) {
            streak++;
            if (streak >= 3) detected.add('bet3');
            if (streak >= 4) detected.add('bet4');
        } else streak = 1;
    }
    let zig = 1;
    for (let i = 1; i < L; i++) {
        if (history[i] !== history[i-1]) zig++;
        else { if (zig >= 4) detected.add('zig4'); zig = 1; }
    }
    if (zig >= 4) detected.add('zig4');
    for (let i = 0; i + 6 <= L; i++) {
        const s = history.slice(i, i+6).join('');
        if (['TTXXTT','XXTTXX'].includes(s)) detected.add('2-2');
        if (['TTTXXX','XXXTTT'].includes(s)) detected.add('3-3');
        if (['TXXTXX','XTTXTT'].includes(s)) detected.add('1-2');
        if (['TTXTTX','XXTXXT'].includes(s)) detected.add('2-1');
    }
    const patternCoverage = clamp(detected.size / 7, 0, 1);

    // Model stability
    let modelStability = 0;
    if (L >= 20) {
        const vom = layerVOM(history);
        const ppm = layerPPM(history);
        const lrn = layerLearner(history);
        const spread = Math.max(vom, ppm, lrn) - Math.min(vom, ppm, lrn);
        const agree = 1 - clamp(spread * 2, 0, 1);
        const informative = clamp(Math.abs(vom-0.5) + Math.abs(ppm-0.5) + Math.abs(lrn-0.5), 0, 1);
        modelStability = clamp(agree * 0.6 + informative * 0.4, 0, 1);
    } else {
        modelStability = clamp(L / 40, 0, 1) * 0.5;
    }

    // CUSUM
    let cusumStability = 1;
    if (L >= 15) {
        const c = layerCUSUM(history);
        cusumStability = c.isBroken ? 1 - c.strength * 0.8 : 1;
    } else {
        cusumStability = clamp(L / 15, 0, 1);
    }

    const efs = (
        dataVolume      * 0.35 +
        patternCoverage * 0.25 +
        modelStability  * 0.25 +
        cusumStability  * 0.15
    ) * 100;

    return {
        efs: Math.round(efs * 10) / 10,
        breakdown: {
            dataVolume:      Math.round(dataVolume      * 1000) / 10,
            patternCoverage: Math.round(patternCoverage * 1000) / 10,
            modelStability:  Math.round(modelStability  * 1000) / 10,
            cusumStability:  Math.round(cusumStability  * 1000) / 10
        },
        detectedPatterns: [...detected],
        sessions: L
    };
}

// ==============================================================================
// PHẦN 11: FETCH + WARM-UP
// ==============================================================================
async function fetchData(url) {
    try {
        const r = await axios.get(url, {
            headers: { 'User-Agent': CONFIG.USER_AGENT },
            timeout: CONFIG.TIMEOUT
        });
        return r.data?.list || [];
    } catch (e) {
        log('ERROR', `Fetch: ${e.message}`);
        return [];
    }
}

async function warmupScan(type) {
    const list = await fetchData(CONFIG.API[type]);
    if (list.length === 0) {
        log('WARN', `[${type}] Warm-up: API rỗng.`);
        return warmupState[type];
    }
    const state = warmupState[type];

    if (state.history.length === 0) {
        state.history = convertToSequence(list);
        state.scannedSessions = state.history.length;
        state.lastPhien = String(list[0].id);
        log('WARMUP', `[${type}] Nạp full: ${state.history.length} phiên (mới nhất: ${state.lastPhien})`);
    } else {
        const latestId = String(list[0].id);
        if (latestId !== state.lastPhien) {
            const idx = list.findIndex(x => String(x.id) === state.lastPhien);
            if (idx === -1) {
                state.history = convertToSequence(list);
                log('WARMUP', `[${type}] Phiên cũ rớt khỏi API → nạp lại (${state.history.length})`);
            } else {
                const newOnes = list.slice(0, idx).reverse();
                for (const it of newOnes) {
                    state.history.push(it.resultTruyenThong === 'TAI' ? 'T' : 'X');
                }
                state.scannedSessions += newOnes.length;
            }
            state.lastPhien = latestId;
        }
    }
    if (state.history.length > 500) state.history = state.history.slice(-500);

    const profile = profileEnvironment(state.history);
    state.efs = profile.efs;
    state.breakdown = profile.breakdown;
    state.detectedPatterns = profile.detectedPatterns;
    state.lastUpdated = Date.now();

    const enough = state.history.length >= CONFIG.WARMUP.MIN_SESSIONS_ABSOLUTE;
    const reached = state.efs >= CONFIG.WARMUP.TARGET_EFS;
    const forced = state.scannedSessions >= CONFIG.WARMUP.MAX_WARMUP_SESSIONS;

    if (!state.isReady && ((enough && reached) || forced)) {
        state.isReady = true;
        state.readyAt = Date.now();
        log('READY', `[${type}] ✅ READY sau ${state.scannedSessions} phiên | EFS=${state.efs}%`);
    }
    return state;
}

let warmupTimer = null;
async function startWarmup() {
    log('WARMUP', '🚀 Bắt đầu quét làm quen môi trường...');
    let count = 0;
    const loop = async () => {
        count++;
        try { await Promise.all([warmupScan('tx'), warmupScan('md5')]); }
        catch (e) { log('ERROR', `Warm-up loop: ${e.message}`); }

        if (count % CONFIG.WARMUP.LOG_EVERY_N === 0) {
            log('WARMUP', `Tiến độ: TX EFS=${warmupState.tx.efs}% (${warmupState.tx.isReady?'READY':'...'}) | MD5 EFS=${warmupState.md5.efs}% (${warmupState.md5.isReady?'READY':'...'})`);
        }
        if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
        warmupTimer = setTimeout(loop, CONFIG.WARMUP.POLL_INTERVAL_MS);
    };
    await loop();
}

// ==============================================================================
// PHẦN 12: ENSEMBLE ENGINE (V36 - Full)
// ==============================================================================
function runPredictionEngine(history, mem, efs = 0, points = [], dices = []) {
    const pattern      = layerPatternMatrix(history, points, dices);
    const vomProb      = layerVOM(history);
    const ppmProb      = layerPPM(history);
    const learnerProb  = layerLearner(history);
    const cusum        = layerCUSUM(history);

    const getWeight = (ms) => {
        const total = ms.win + ms.lose;
        if (total < 5) return 1.0;
        return clamp(0.5 + (ms.win / total - 0.5) * 2, 0.2, 1.5);
    };
    let wVOM = getWeight(mem.models.vom);
    let wPPM = getWeight(mem.models.ppm);
    let wLRN = getWeight(mem.models.learner);

    let wPAT;
    const hasStrongSub = pattern.isSubPattern && pattern.subPatterns && pattern.subPatterns.strength >= 0.5;
    if (hasStrongSub) {
        wPAT = CONFIG.MODEL.SUB_PATTERN_BOOST * (0.5 + pattern.subPatterns.strength);
        wVOM *= 0.7; wPPM *= 0.7; wLRN *= 0.7;
    } else {
        wPAT = pattern.reason.includes('Không rõ') ? 0.2 : 2.5;
    }

    const efsFactor = clamp(efs / 100, 0, 1);
    if (efs < 80) {
        wPAT *= (0.4 + 0.6 * efsFactor);
        wVOM *= (0.8 + 0.4 * efsFactor);
        wPPM *= (0.8 + 0.4 * efsFactor);
    }
    const totalW = wVOM + wPPM + wLRN + wPAT;

    let probT = (
        vomProb       * wVOM +
        ppmProb       * wPPM +
        learnerProb   * wLRN +
        pattern.probT * wPAT
    ) / totalW;

    if (cusum.isBroken) {
        probT = probT * (1 - cusum.strength * 0.5) + 0.5 * (cusum.strength * 0.5);
    }

    const edge = Math.abs(probT - 0.5);
    let finalPredict, finalReason;

    if (hasStrongSub) {
        finalPredict = probT > 0.5 ? 'TÀI' : 'XỈU';
        finalReason = `⭐ ${pattern.subPatterns.name} → ${finalPredict} (${(probT * 100).toFixed(1)}%)`;
    } else if (edge >= CONFIG.MODEL.MIN_EDGE) {
        finalPredict = probT > 0.5 ? 'TÀI' : 'XỈU';
        finalReason = `Model chọn ${finalPredict} (Xác suất: ${(probT * 100).toFixed(1)}%)`;
        if (!pattern.reason.includes('Không rõ')) finalReason += ` | ${pattern.reason}`;
    } else {
        const lastResult = history[history.length - 1];
        finalPredict = lastResult === 'T' ? 'XỈU' : 'TÀI';
        finalReason = `Tín hiệu nhiễu -> Ép bẻ ${finalPredict}`;
    }

    // Confidence thích ứng
    let confidence;
    if (efs < 80) {
        confidence = 51 + (efs / 80) * 8;
        confidence = clamp(confidence - (1 - clamp(edge * 4, 0, 1)) * 1.5, 51, 59);
        if (hasStrongSub) {
            confidence = Math.max(confidence, 57 + pattern.subPatterns.strength * 2);
            confidence = clamp(confidence, 51, 59);
        }
        confidence = Math.round(confidence * 10) / 10;
    } else {
        let base = 51 + edge * 100;
        base = clamp(base, 51, 80);
        const boost = ((efs - 80) / 20) * 0.15;
        confidence = clamp(base * (1 + boost), base, 85);
        if (hasStrongSub) {
            confidence = clamp(confidence + 5 + pattern.subPatterns.strength * 5, base, 90);
        }
        confidence = Math.round(confidence * 10) / 10;
    }

    return {
        predict: finalPredict,
        confidence,
        reason: finalReason,
        details: {
            pattern: pattern.reason,
            vomProb, ppmProb, learnerProb,
            isBroken: cusum.isBroken,
            rawProbT: probT,
            efsAtPrediction: efs,
            phase: efs < 80 ? 'WARMING_UP' : 'READY',
            subPatterns: pattern.subPatterns || { hit: false, hits: [], strength: 0 }
        }
    };
}

// ==============================================================================
// PHẦN 13: GAME PROCESSOR
// ==============================================================================
async function processGame(type) {
    const state = warmupState[type];
    await warmupScan(type);

    const list = await fetchData(CONFIG.API[type]);
    if (!list.length) throw new Error('Không lấy được dữ liệu API');

    const currentPhien = String(list[0].id);
    const history = convertToSequence(list);
    const points = list.map(x => x.point).reverse();
    const dices = list.map(x => x.dices).reverse();
    const mem = memory[type];

    // Chấm điểm phiên trước
    if (mem.lastPhien && mem.lastPrediction && parseFloat(currentPhien) > parseFloat(mem.lastPhien)) {
        const actualObj = list.find(x => String(x.id) === mem.lastPhien);
        if (actualObj) {
            const actualResult = actualObj.resultTruyenThong === 'TAI' ? 'TÀI' : 'XỈU';
            const isWin = actualResult === mem.lastPrediction;
            const bet = calculateKellyBet(mem, mem.lastConfidence);

            if (isWin) {
                mem.statistics.win++;
                mem.statistics.bankroll += bet;
                log('WIN', `[${type}] Phiên ${mem.lastPhien}: ${mem.lastPrediction} vs ${actualResult} -> ✅ (+${bet.toFixed(0)}$)`);
            } else {
                mem.statistics.lose++;
                mem.statistics.bankroll -= bet;
                log('LOSE', `[${type}] Phiên ${mem.lastPhien}: ${mem.lastPrediction} vs ${actualResult} -> ❌ (-${bet.toFixed(0)}$)`);
            }
            if (mem.statistics.bankroll > mem.statistics.peakBankroll) mem.statistics.peakBankroll = mem.statistics.bankroll;
            const dd = mem.statistics.peakBankroll - mem.statistics.bankroll;
            if (dd > mem.statistics.maxDrawdown) mem.statistics.maxDrawdown = dd;

            if (mem.lastModelDetails) {
                const d = mem.lastModelDetails;
                if ((d.vomProb > 0.5 ? 'TÀI' : 'XỈU') === actualResult) mem.models.vom.win++; else mem.models.vom.lose++;
                if ((d.ppmProb > 0.5 ? 'TÀI' : 'XỈU') === actualResult) mem.models.ppm.win++; else mem.models.ppm.lose++;
                if ((d.learnerProb > 0.5 ? 'TÀI' : 'XỈU') === actualResult) mem.models.learner.win++; else mem.models.learner.lose++;

                // Thống kê theo cầu phụ
                if (d.subPatterns && d.subPatterns.hit) {
                    for (const h of d.subPatterns.hits) {
                        if (!mem.subPatternStats[h.name]) mem.subPatternStats[h.name] = { win: 0, lose: 0 };
                        if (isWin) mem.subPatternStats[h.name].win++;
                        else mem.subPatternStats[h.name].lose++;
                    }
                }
            }
            saveMemory(type, mem);
        }
    }

    const prediction = runPredictionEngine(history, mem, state.efs, points, dices);

    mem.lastPhien = currentPhien;
    mem.lastPrediction = prediction.predict;
    mem.lastConfidence = prediction.confidence;
    mem.lastModelDetails = prediction.details;

    log('MODEL', `[${type}] Phase=${prediction.details.phase} | Cầu: ${prediction.details.pattern} | Raw P_T: ${(prediction.details.rawProbT * 100).toFixed(1)}% | EFS=${state.efs}%`);
    if (prediction.details.subPatterns.hit) {
        log('SUB', `[${type}] ⭐ Cầu phụ: ${prediction.details.subPatterns.name} (strength ${prediction.details.subPatterns.confidence}%)`);
    }
    log('INFO', `[${type}] 🎯 Phiên ${parseFloat(currentPhien) + 1}: ${prediction.predict} (${prediction.confidence}%) | Phase: ${prediction.details.phase}`);

    return {
        phienHienTai: currentPhien,
        phienDuDoan: String(parseFloat(currentPhien) + 1),
        duDoan: prediction.predict,
        tiLe: `${prediction.confidence}%`,
        liDo: prediction.reason,
        xucXac: list[0].dices,
        tongDiem: list[0].point,
        chiTietModel: {
            pattern: prediction.details.pattern,
            vom: (prediction.details.vomProb * 100).toFixed(2) + '%',
            ppm: (prediction.details.ppmProb * 100).toFixed(2) + '%',
            learner: (prediction.details.learnerProb * 100).toFixed(2) + '%',
            cusumGay: prediction.details.isBroken ? 'CÓ' : 'KHÔNG',
            efs: state.efs + '%',
            phase: prediction.details.phase,
            cauPhu: prediction.details.subPatterns.hit
                ? prediction.details.subPatterns.hits.map(h => ({
                    ten: h.name,
                    doManh: Math.round((h.probT > 0.5 ? h.probT : 1 - h.probT) * 100) + '%',
                    chiTiet: h.detail
                }))
                : [],
            cauPhuTongHop: prediction.details.subPatterns.hit
                ? `${prediction.details.subPatterns.name} (strength ${prediction.details.subPatterns.confidence}%)`
                : 'Không có',
            cauPhuStrength: prediction.details.subPatterns.strength || 0
        },
        thongKe: {
            win: mem.statistics.win,
            lose: mem.statistics.lose,
            winrate: (mem.statistics.win + mem.statistics.lose) > 0
                ? ((mem.statistics.win / (mem.statistics.win + mem.statistics.lose)) * 100).toFixed(1) + '%'
                : '—',
            bankroll: mem.statistics.bankroll.toFixed(0) + '$',
            maxDD: mem.statistics.maxDrawdown.toFixed(0) + '$'
        }
    };
}

// ==============================================================================
// PHẦN 14: EXPRESS ROUTERS
// ==============================================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get('/taixiu', async (req, res) => {
    try { res.json({ status: 'success', data: await processGame('tx') }); }
    catch (e) { res.status(500).json({ status: 'error', message: e.message, fallback: 'TÀI' }); }
});
app.get('/md5', async (req, res) => {
    try { res.json({ status: 'success', data: await processGame('md5') }); }
    catch (e) { res.status(500).json({ status: 'error', message: e.message, fallback: 'TÀI' }); }
});

app.get('/warmup/status', (req, res) => {
    const s = (st) => ({
        isReady: st.isReady, efs: st.efs, scannedSessions: st.scannedSessions,
        breakdown: st.breakdown, detectedPatterns: st.detectedPatterns, readyAt: st.readyAt
    });
    res.json({ status: 'ok', targetEfs: CONFIG.WARMUP.TARGET_EFS, tx: s(warmupState.tx), md5: s(warmupState.md5) });
});

app.post('/warmup/reset', async (req, res) => {
    const { type } = req.body;
    const games = (type === 'tx' || type === 'md5') ? [type] : ['tx', 'md5'];
    for (const g of games) warmupState[g] = createEmptyWarmup();
    if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
    startWarmup();
    res.json({ status: 'ok', message: `Reset warm-up: ${games.join(', ')}` });
});

// Endpoint xem tất cả 18 cầu phụ đang khớp real-time
app.get('/cauphu', async (req, res) => {
    try {
        const type = req.query.type === 'md5' ? 'md5' : 'tx';
        const list = await fetchData(CONFIG.API[type]);
        if (!list.length) throw new Error('Không có data');
        const history = convertToSequence(list);
        const points = list.map(x => x.point).reverse();
        const dices = list.map(x => x.dices).reverse();

        const raw = {
            // Nhóm 1
            guong:                detectMirror(history),
            palindrome:           detectPalindrome(history),
            daoToanPhan:          detectFullReverse(history),
            chuKy:                detectCycle(history),
            cauThang:             detectLadder(history),
            doiXung8:             detectCenterSymmetry(history),
            // Nhóm 2
            beBet:                detectSplitBreak(history),
            cauKep:               detectDouble(history),
            nhip3Lech:            detect3Shift(history),
            nhip121:              detectShift121(history),
            nhip212:              detectShift212(history),
            nhip414:              detectShift414(history),
            // Nhóm 3
            theoDiem:             detectByPoint(history, points),
            theoChanLe:           detectByParity(history, points),
            xucXacLap:            detectDiceRepeat(history, dices),
            // Nhóm 4
            markov3:              detectMarkov3(history),
            phanMarkov:           detectAntiMarkov(history),
            contextXacSuatCao:    detectHighProbContext(history)
        };

        const all = detectAllSubPatterns(history, points, dices);

        res.json({
            status: 'success',
            type,
            phienHienTai: String(list[0].id),
            phienDuDoan: String(parseFloat(list[0].id) + 1),
            tongHop: all.hit ? {
                ten: all.name,
                probT: (all.probT * 100).toFixed(2) + '%',
                strength: all.confidence + '%',
                soCauKhop: all.hits.length,
                chiTiet: all.detail
            } : { message: 'Không có cầu phụ nào khớp' },
            chiTietTatCa: Object.fromEntries(
                Object.entries(raw).map(([k, v]) => [k, v.hit
                    ? { hit: true, ten: v.name, probT: (v.probT * 100).toFixed(2) + '%', detail: v.detail }
                    : { hit: false }
                ])
            )
        });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// Endpoint xem thống kê win/lose theo từng cầu phụ
app.get('/cauphu/stats', (req, res) => {
    const stats = {};
    for (const type of ['tx', 'md5']) {
        stats[type] = {};
        const s = memory[type].subPatternStats || {};
        for (const [name, wl] of Object.entries(s)) {
            const total = wl.win + wl.lose;
            stats[type][name] = {
                win: wl.win, lose: wl.lose,
                winrate: total > 0 ? ((wl.win / total) * 100).toFixed(1) + '%' : '—'
            };
        }
    }
    res.json({ status: 'ok', stats });
});

app.get('/stats', (req, res) => {
    const tx = memory.tx.statistics, md5 = memory.md5.statistics;
    res.json({
        taixiu: {
            win: tx.win, lose: tx.lose,
            winrate: (tx.win + tx.lose) > 0 ? ((tx.win / (tx.win + tx.lose)) * 100).toFixed(1) + '%' : '—',
            bankroll: tx.bankroll, maxDrawdown: tx.maxDrawdown
        },
        md5: {
            win: md5.win, lose: md5.lose,
            winrate: (md5.win + md5.lose) > 0 ? ((md5.win / (md5.win + md5.lose)) * 100).toFixed(1) + '%' : '—',
            bankroll: md5.bankroll, maxDrawdown: md5.maxDrawdown
        }
    });
});

app.post('/reset', (req, res) => {
    const { type } = req.body;
    if (type === 'tx' || type === 'all') { memory.tx = createDefaultMemory(); saveMemory('tx', memory.tx); }
    if (type === 'md5' || type === 'all') { memory.md5 = createDefaultMemory(); saveMemory('md5', memory.md5); }
    res.json({ status: 'success', message: `Reset ${type || 'all'}` });
});

app.get('/backtest', async (req, res) => {
    try {
        const type = req.query.type === 'md5' ? 'md5' : 'tx';
        const list = await fetchData(CONFIG.API[type]);
        if (!list.length) throw new Error('Không có data');
        const history = convertToSequence(list);
        const points = list.map(x => x.point).reverse();
        const dices = list.map(x => x.dices).reverse();
        const tempMem = createDefaultMemory();
        let win = 0, lose = 0, subWin = 0, subLose = 0;

        for (let i = CONFIG.MIN_PHIEN; i < history.length - 1; i++) {
            const sub = history.slice(0, i + 1);
            const subPoints = points.slice(0, i + 1);
            const subDices = dices.slice(0, i + 1);
            const pred = runPredictionEngine(sub, tempMem, 100, subPoints, subDices);
            const actual = history[i + 1] === 'T' ? 'TÀI' : 'XỈU';
            if (pred.predict === actual) win++; else lose++;
            if (pred.details.subPatterns && pred.details.subPatterns.hit) {
                if (pred.predict === actual) subWin++; else subLose++;
            }
            const d = pred.details;
            if ((d.vomProb > 0.5 ? 'TÀI' : 'XỈU') === actual) tempMem.models.vom.win++; else tempMem.models.vom.lose++;
            if ((d.ppmProb > 0.5 ? 'TÀI' : 'XỈU') === actual) tempMem.models.ppm.win++; else tempMem.models.ppm.lose++;
            if ((d.learnerProb > 0.5 ? 'TÀI' : 'XỈU') === actual) tempMem.models.learner.win++; else tempMem.models.learner.lose++;
        }
        const total = win + lose;
        const subTotal = subWin + subLose;
        res.json({
            status: 'success', type, totalPhiens: total, win, lose,
            winrate: ((win / total) * 100).toFixed(2) + '%',
            cauPhu: subTotal > 0 ? {
                total: subTotal, win: subWin, lose: subLose,
                winrate: ((subWin / subTotal) * 100).toFixed(2) + '%'
            } : { message: 'Không có cầu phụ nào khớp trong backtest' }
        });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/status', (req, res) => {
    res.json({
        status: 'online', uptime: process.uptime(),
        memory: process.memoryUsage(), version: 'V36.0.0-ultimate',
        warmup: {
            tx: { isReady: warmupState.tx.isReady, efs: warmupState.tx.efs },
            md5: { isReady: warmupState.md5.isReady, efs: warmupState.md5.efs }
        }
    });
});

// ==============================================================================
// PHẦN 15: KHỞI ĐỘNG
// ==============================================================================
app.listen(CONFIG.PORT, () => {
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    console.log(COLORS.green + `🔥 VIP GOD TIER V36 - ULTIMATE FULL EDITION` + COLORS.reset);
    console.log(COLORS.cyan + `🚀 Server port: ${CONFIG.PORT}` + COLORS.reset);
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    console.log(COLORS.yellow + `⚙️  Warm-up target EFS: ${CONFIG.WARMUP.TARGET_EFS}% | 18 cầu phụ cực chuẩn` + COLORS.reset);
    console.log(COLORS.yellow + 'Endpoints:' + COLORS.reset);
    console.log('  GET  /taixiu          -> Dự đoán TX (luôn trả, confidence thích ứng)');
    console.log('  GET  /md5             -> Dự đoán MD5');
    console.log('  GET  /cauphu          -> Xem 18 cầu phụ real-time');
    console.log('  GET  /cauphu/stats    -> Winrate theo từng cầu phụ');
    console.log('  GET  /warmup/status   -> Tiến độ làm quen');
    console.log('  POST /warmup/reset    -> Reset warm-up');
    console.log('  GET  /stats           -> Thống kê chung');
    console.log('  GET  /backtest        -> Test winrate + cầu phụ');
    console.log('  POST /reset           -> Reset bộ nhớ');
    console.log('  GET  /status          -> Trạng thái server');
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);

    startWarmup();
});
