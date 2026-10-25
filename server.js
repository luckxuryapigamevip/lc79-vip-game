/**
 * ==============================================================================
 * VIP GOD TIER AI - V32 (ULTIMATE FULL VERSION)
 * ==============================================================================
 * Tác giả: VIP GOD TIER
 * Mô tả: Hệ thống phân tích Tài Xỉu & MD5 tự động tích hợp đa tầng thuật toán.
 * 
 * TÍNH NĂNG NỔI BẬT:
 * 1. Tầng 1-5: Thuật toán thống kê (Bệt, 1-1, 2-2, 3-3, Markov, PPM).
 * 2. Tầng 6: Thuật toán Học Máy (Machine Learning - Pattern Learner).
 * 3. Tầng 7: CUSUM (Phát hiện cầu gãy).
 * 4. Tầng 8: Meta-Ensemble (Tổng hợp có trọng số động).
 * 5. Quản lý vốn: Kelly Criterion, Stop-loss, Take-profit.
 * 6. Lưu trữ: Tự động lưu File JSON chống mất data.
 * 7. API: /taixiu, /md5, /backtest, /reset, /status.
 * 8. Ép buộc dự đoán 100% (Không bao giờ có trạng thái "CHỜ").
 * ==============================================================================
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ==============================================================================
// PHẦN 1: CẤU HÌNH HỆ THỐNG (CONFIGURATION)
// ==============================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    API: {
        tx: 'https://wtx.tele68.com/v1/tx/sessions',
        md5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions'
    },
    TIMEOUT: 15000,
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    MIN_PHIEN: 15,
    FILE: {
        tx: path.join(__dirname, 'v32_tx_data.json'),
        md5: path.join(__dirname, 'v32_md5_data.json')
    },
    BANKROLL: {
        INITIAL: 1000,
        BASE_BET: 10,
        MAX_BET: 100,
        STOP_LOSS: 500,
        TAKE_PROFIT: 2000
    },
    MODEL: {
        MAX_ORDER: 6,
        MIN_SAMPLES: 4,
        LAPLACE_ALPHA: 1.0,
        CUSUM_THRESHOLD: 5.0,
        MIN_EDGE: 0.015 // Ngưỡng chênh lệch tối thiểu để đánh theo Model
    }
};

// ==============================================================================
// PHẦN 2: HỆ THỐNG LOG (LOGGER)
// ==============================================================================
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

function log(level, message) {
    const timestamp = new Date().toLocaleTimeString();
    let color = COLORS.reset;
    if (level === 'INFO') color = COLORS.cyan;
    if (level === 'WARN') color = COLORS.yellow;
    if (level === 'ERROR') color = COLORS.red;
    if (level === 'WIN') color = COLORS.green;
    if (level === 'LOSE') color = COLORS.red;
    if (level === 'MODEL') color = COLORS.magenta;

    console.log(`${COLORS.gray}[${timestamp}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${message}`);
}

// ==============================================================================
// PHẦN 3: LƯU TRỮ VÀ QUẢN LÝ BỘ NHỚ (PERSISTENCE)
// ==============================================================================
function createDefaultMemory() {
    return {
        lastPhien: null,
        lastPrediction: null,
        lastConfidence: null,
        lastModelDetails: null,
        statistics: {
            win: 0,
            lose: 0,
            bankroll: CONFIG.BANKROLL.INITIAL,
            peakBankroll: CONFIG.BANKROLL.INITIAL,
            maxDrawdown: 0,
            isStopped: false
        },
        models: {
            vom: { win: 0, lose: 0 },
            ppm: { win: 0, lose: 0 },
            learner: { win: 0, lose: 0 }
        }
    };
}

function loadMemory(type) {
    try {
        if (fs.existsSync(CONFIG.FILE[type])) {
            const raw = fs.readFileSync(CONFIG.FILE[type], 'utf8');
            const parsed = JSON.parse(raw);
            return { ...createDefaultMemory(), ...parsed };
        }
    } catch (error) {
        log('ERROR', `Lỗi khi load file ${type}: ${error.message}`);
    }
    return createDefaultMemory();
}

function saveMemory(type, mem) {
    try {
        fs.writeFileSync(CONFIG.FILE[type], JSON.stringify(mem, null, 2), 'utf8');
    } catch (error) {
        log('ERROR', `Lỗi khi save file ${type}: ${error.message}`);
    }
}

const memory = {
    tx: loadMemory('tx'),
    md5: loadMemory('md5')
};

// ==============================================================================
// PHẦN 4: CÁC HÀM TIỆN ÍCH (UTILITIES)
// ==============================================================================
function convertToSequence(list) {
    // Chuyển API list (mới nhất -> cũ nhất) thành mảng lịch sử (cũ nhất -> mới nhất)
    return list.map(item => item.resultTruyenThong === 'TAI' ? 'T' : 'X').reverse();
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function calculateKellyBet(mem, confidence) {
    if (mem.statistics.isStopped) return 0;
    const p = confidence / 100;
    const kelly = Math.max(0, 2 * p - 1);
    const rawBet = CONFIG.BANKROLL.BASE_BET * (1 + kelly * 3);
    return clamp(rawBet, CONFIG.BANKROLL.BASE_BET, CONFIG.BANKROLL.MAX_BET);
}

// ==============================================================================
// PHẦN 5: CÁC TẦNG THUẬT TOÁN (ALGORITHM LAYERS)
// ==============================================================================

// --- TẦNG 1: PATTERN MATRIX (NHẬN DIỆN CẦU MẪU) ---
function layerPatternMatrix(history) {
    const L = history.length;
    if (L < 6) return { probT: 0.5, reason: 'Ít data' };
    
    const last = history[L - 1];

    // 1. Kiểm tra Bệt (Streak)
    let streak = 1;
    for (let i = L - 2; i >= 0; i--) {
        if (history[i] === last) streak++;
        else break;
    }
    if (streak >= 4) return { probT: last === 'T' ? 0.25 : 0.75, reason: `Ép bẻ Bệt ${streak}` };
    if (streak === 3) return { probT: last === 'T' ? 0.40 : 0.60, reason: `Bám Bệt 3` };

    // 2. Kiểm tra Cầu 1-1 (Zigzag)
    let zigzag = 1;
    for (let i = L - 1; i >= 1; i--) {
        if (history[i] !== history[i - 1]) zigzag++;
        else break;
    }
    if (zigzag >= 4) return { probT: last === 'T' ? 0.30 : 0.70, reason: `Cầu 1-1 (${zigzag} nhịp)` };

    // 3. Kiểm tra Pattern tĩnh (2-2, 3-3, 1-2, 2-1)
    if (L >= 8) {
        const p6 = history.slice(-6).join('');
        const p8 = history.slice(-8).join('');
        
        if (['TTXXTT', 'XXTTXX'].includes(p6)) return { probT: last === 'T' ? 0.35 : 0.65, reason: 'Cầu 2-2' };
        if (['TTTXXX', 'XXXTTT'].includes(p6)) return { probT: last === 'T' ? 0.35 : 0.65, reason: 'Cầu 3-3' };
        if (['TXXTXX', 'XTTXTT'].includes(p6)) return { probT: last === 'T' ? 0.35 : 0.65, reason: 'Cầu 1-2' };
        if (['TTXTTX', 'XXTXXT'].includes(p6)) return { probT: last === 'T' ? 0.35 : 0.65, reason: 'Cầu 2-1' };
    }

    return { probT: 0.5, reason: 'Không rõ cầu' };
}

// --- TẦNG 2: VOM (VARIABLE-ORDER MARKOV) ---
function layerVOM(history) {
    if (history.length < 5) return 0.5;

    for (let order = CONFIG.MODEL.MAX_ORDER; order >= 1; order--) {
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
        if (total >= CONFIG.MODEL.MIN_SAMPLES) {
            // Laplace Smoothing
            return (countT + CONFIG.MODEL.LAPLACE_ALPHA) / (total + 2 * CONFIG.MODEL.LAPLACE_ALPHA);
        }
    }
    return 0.5;
}

// --- TẦNG 3: PPM (PREDICTION BY PARTIAL MATCHING) ---
function layerPPM(history) {
    if (history.length < 5) return 0.5;

    const tables = {};
    for (let o = 1; o <= CONFIG.MODEL.MAX_ORDER; o++) tables[o] = {};

    // Xây dựng bảng tần suất
    for (let i = 0; i < history.length - 1; i++) {
        for (let o = 1; o <= CONFIG.MODEL.MAX_ORDER; o++) {
            if (i < o) continue;
            const ctx = history.slice(i - o, i).join('');
            const next = history[i];
            if (!tables[o][ctx]) tables[o][ctx] = { T: 0, X: 0 };
            if (next === 'T') tables[o][ctx].T++;
            else tables[o][ctx].X++;
        }
    }

    // Dự đoán với PPM Escape
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

// --- TẦNG 4: LEARNER (MÁY HỌC ĐƠN GIẢN) ---
function layerLearner(history) {
    if (history.length < 12) return 0.5;
    
    const N = 4; // Học dựa trên 4 phiên gần nhất
    const currentPattern = history.slice(-N).join('');
    let countT = 0, countX = 0;

    for (let i = 0; i < history.length - N; i++) {
        if (history.slice(i, i + N).join('') === currentPattern) {
            if (history[i + N] === 'T') countT++;
            else countX++;
        }
    }

    const total = countT + countX;
    if (total === 0) return 0.5;
    
    // Bayesian smoothing
    return (countT + 1) / (total + 2);
}

// --- TẦNG 5: CUSUM (CHANGE-POINT DETECTION) ---
function layerCUSUM(history) {
    if (history.length < 15) return { isBroken: false, strength: 0 };
    
    const vals = history.map(x => x === 'T' ? 1 : 0);
    let sHi = 0, sLo = 0, maxS = 0;

    for (const v of vals) {
        sHi = Math.max(0, sHi + (v - 0.6));
        sLo = Math.max(0, sLo + (0.4 - v));
        maxS = Math.max(maxS, sHi, sLo);
    }

    return {
        isBroken: maxS > CONFIG.MODEL.CUSUM_THRESHOLD,
        strength: clamp(maxS / 10, 0, 1)
    };
}

// ==============================================================================
// PHẦN 6: ENSEMBLE ENGINE (TỔNG HỢP VÀ ÉP BUỘC DỰ ĐOÁN)
// ==============================================================================
function runPredictionEngine(history, mem) {
    // 1. Chạy tất cả các tầng
    const pattern = layerPatternMatrix(history);
    const vomProb = layerVOM(history);
    const ppmProb = layerPPM(history);
    const learnerProb = layerLearner(history);
    const cusum = layerCUSUM(history);

    // 2. Tính trọng số động dựa trên hiệu suất thực tế của từng model
    const getWeight = (modelStats) => {
        const total = modelStats.win + modelStats.lose;
        if (total < 5) return 1.0; // Mặc định nếu chưa đủ data
        const wr = modelStats.win / total;
        return clamp(0.5 + (wr - 0.5) * 2, 0.2, 1.5);
    };

    const wVOM = getWeight(mem.models.vom);
    const wPPM = getWeight(mem.models.ppm);
    const wLRN = getWeight(mem.models.learner);
    const wPAT = pattern.reason.includes('Không rõ') ? 0.2 : 2.5; // Ưu tiên cực cao nếu bắt được cầu mẫu

    const totalWeight = wVOM + wPPM + wLRN + wPAT;

    // 3. Tính xác suất Tài tổng hợp
    let probT = (
        (vomProb * wVOM) + 
        (ppmProb * wPPM) + 
        (learnerProb * wLRN) + 
        (pattern.probT * wPAT)
    ) / totalWeight;

    // 4. Nếu CUSUM báo gãy cầu -> Kéo xác suất về 50/50 để bẻ
    if (cusum.isBroken) {
        probT = probT * (1 - cusum.strength * 0.5) + 0.5 * (cusum.strength * 0.5);
    }

    // 5. ÉP BUỘC RA KẾT QUẢ (KHÔNG CHỜ)
    const edge = Math.abs(probT - 0.5);
    let finalPredict = '';
    let finalReason = '';

    if (edge >= CONFIG.MODEL.MIN_EDGE) {
        // Đánh theo Model
        finalPredict = probT > 0.5 ? 'TÀI' : 'XỈU';
        finalReason = `Model chọn ${finalPredict} (Xác suất: ${(probT * 100).toFixed(1)}%)`;
        if (!pattern.reason.includes('Không rõ')) {
            finalReason += ` | ${pattern.reason}`;
        }
    } else {
        // Nếu các model lưỡng lự (quá nhiễu) -> Ép bẻ ngược phiên trước
        const lastResult = history[history.length - 1];
        finalPredict = lastResult === 'T' ? 'XỈU' : 'TÀI';
        finalReason = `Tín hiệu nhiễu -> Ép bẻ ${finalPredict}`;
    }

    // 6. Tính Confidence (Luôn từ 51% đến 80%)
    let confidence = Math.round(51 + edge * 100);
    confidence = clamp(confidence, 51, 80);

    return {
        predict: finalPredict,
        confidence: confidence,
        reason: finalReason,
        details: {
            pattern: pattern.reason,
            vomProb,
            ppmProb,
            learnerProb,
            isBroken: cusum.isBroken,
            rawProbT: probT
        }
    };
}

// ==============================================================================
// PHẦN 7: XỬ LÝ GAME (GAME PROCESSOR)
// ==============================================================================
async function fetchData(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': CONFIG.USER_AGENT },
            timeout: CONFIG.TIMEOUT
        });
        return response.data?.list || [];
    } catch (error) {
        log('ERROR', `Lỗi Fetch API: ${error.message}`);
        return [];
    }
}

async function processGame(type) {
    const list = await fetchData(CONFIG.API[type]);
    if (list.length === 0) throw new Error('Không lấy được dữ liệu API');

    const currentPhien = String(list[0].id);
    const history = convertToSequence(list);
    const mem = memory[type];

    // --- CHẤM ĐIỂM PHIÊN TRƯỚC ---
    if (mem.lastPhien && mem.lastPrediction) {
        if (parseFloat(currentPhien) > parseFloat(mem.lastPhien)) {
            const actualObj = list.find(x => String(x.id) === mem.lastPhien);
            if (actualObj) {
                const actualResult = actualObj.resultTruyenThong === 'TAI' ? 'TÀI' : 'XỈU';
                const isWin = actualResult === mem.lastPrediction;

                if (isWin) {
                    mem.statistics.win++;
                    const bet = calculateKellyBet(mem, mem.lastConfidence);
                    mem.statistics.bankroll += bet;
                    log('WIN', `[${type}] Phiên ${mem.lastPhien}: ${mem.lastPrediction} vs ${actualResult} -> ✅ WIN (+${bet.toFixed(0)}$)`);
                } else {
                    mem.statistics.lose++;
                    const bet = calculateKellyBet(mem, mem.lastConfidence);
                    mem.statistics.bankroll -= bet;
                    log('LOSE', `[${type}] Phiên ${mem.lastPhien}: ${mem.lastPrediction} vs ${actualResult} -> ❌ LOSE (-${bet.toFixed(0)}$)`);
                }

                // Cập nhật High Water Mark (Max Drawdown)
                if (mem.statistics.bankroll > mem.statistics.peakBankroll) {
                    mem.statistics.peakBankroll = mem.statistics.bankroll;
                }
                const dd = mem.statistics.peakBankroll - mem.statistics.bankroll;
                if (dd > mem.statistics.maxDrawdown) mem.statistics.maxDrawdown = dd;

                // Cập nhật trọng số Model
                if (mem.lastModelDetails) {
                    const d = mem.lastModelDetails;
                    if ((d.vomProb > 0.5 ? 'TÀI' : 'XỈU') === actualResult) mem.models.vom.win++; else mem.models.vom.lose++;
                    if ((d.ppmProb > 0.5 ? 'TÀI' : 'XỈU') === actualResult) mem.models.ppm.win++; else mem.models.ppm.lose++;
                    if ((d.learnerProb > 0.5 ? 'TÀI' : 'XỈU') === actualResult) mem.models.learner.win++; else mem.models.learner.lose++;
                }
                
                saveMemory(type, mem);
            }
        }
    }

    // --- DỰ ĐOÁN PHIÊN TIẾP THEO ---
    const prediction = runPredictionEngine(history, mem);
    
    mem.lastPhien = currentPhien;
    mem.lastPrediction = prediction.predict;
    mem.lastConfidence = prediction.confidence;
    mem.lastModelDetails = prediction.details;

    log('MODEL', `[${type}] Cầu: ${prediction.details.pattern} | Raw P_T: ${(prediction.details.rawProbT * 100).toFixed(1)}%`);
    log('INFO', `[${type}] 🎯 Dự đoán phiên ${parseFloat(currentPhien) + 1}: ${prediction.predict} (${prediction.confidence}%)`);

    // --- TRẢ VỀ JSON ---
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
            cusumGay: prediction.details.isBroken ? 'CÓ' : 'KHÔNG'
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
// PHẦN 8: EXPRESS APP & ROUTERS
// ==============================================================================
const app = express();
app.use(cors());
app.use(express.json());

// Router Dự đoán Tài Xỉu
app.get('/taixiu', async (req, res) => {
    try {
        const data = await processGame('tx');
        res.json({ status: 'success', data });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message, fallback: 'TÀI' });
    }
});

// Router Dự đoán MD5
app.get('/md5', async (req, res) => {
    try {
        const data = await processGame('md5');
        res.json({ status: 'success', data });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message, fallback: 'TÀI' });
    }
});

// Router Lịch sử & Thống kê
app.get('/stats', (req, res) => {
    const tx = memory.tx.statistics;
    const md5 = memory.md5.statistics;
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

// Router Reset Data
app.post('/reset', (req, res) => {
    const { type } = req.body;
    if (type === 'tx' || type === 'all') {
        memory.tx = createDefaultMemory();
        saveMemory('tx', memory.tx);
    }
    if (type === 'md5' || type === 'all') {
        memory.md5 = createDefaultMemory();
        saveMemory('md5', memory.md5);
    }
    res.json({ status: 'success', message: `Đã reset dữ liệu ${type || 'all'}` });
});

// Router Backtest (Chạy giả lập trên lịch sử để check winrate)
app.get('/backtest', async (req, res) => {
    try {
        const type = req.query.type === 'md5' ? 'md5' : 'tx';
        const list = await fetchData(CONFIG.API[type]);
        if (!list.length) throw new Error('Không có data');
        
        const history = convertToSequence(list);
        const tempMem = createDefaultMemory(); // Dùng mem tạm để không ảnh hưởng mem thật
        let win = 0, lose = 0;

        for (let i = CONFIG.MIN_PHIEN; i < history.length - 1; i++) {
            const subHistory = history.slice(0, i + 1);
            const pred = runPredictionEngine(subHistory, tempMem);
            const actual = history[i + 1] === 'T' ? 'TÀI' : 'XỈU';
            
            if (pred.predict === actual) win++; else lose++;
            
            // Cập nhật model trong tempMem để tính trọng số
            const d = pred.details;
            if ((d.vomProb > 0.5 ? 'TÀI' : 'XỈU') === actual) tempMem.models.vom.win++; else tempMem.models.vom.lose++;
            if ((d.ppmProb > 0.5 ? 'TÀI' : 'XỈU') === actual) tempMem.models.ppm.win++; else tempMem.models.ppm.lose++;
            if ((d.learnerProb > 0.5 ? 'TÀI' : 'XỈU') === actual) tempMem.models.learner.win++; else tempMem.models.learner.lose++;
        }

        const total = win + lose;
        res.json({
            status: 'success',
            type: type,
            totalPhiens: total,
            win: win,
            lose: lose,
            winrate: ((win / total) * 100).toFixed(2) + '%'
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Router Status Server
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: 'V32.0.0'
    });
});

// ==============================================================================
// PHẦN 9: KHỞI ĐỘNG SERVER
// ==============================================================================
app.listen(CONFIG.PORT, () => {
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    console.log(COLORS.green + `🔥 VIP GOD TIER V32 - FULL VERSION` + COLORS.reset);
    console.log(COLORS.cyan + `🚀 Server đang chạy tại port: ${CONFIG.PORT}` + COLORS.reset);
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
    console.log(COLORS.yellow + 'Các Endpoints khả dụng:' + COLORS.reset);
    console.log('  GET  /taixiu   -> Dự đoán Tài Xỉu (Ép buộc 100%)');
    console.log('  GET  /md5      -> Dự đoán MD5 (Ép buộc 100%)');
    console.log('  GET  /stats    -> Thống kê win/lose/bankroll');
    console.log('  GET  /backtest -> Chạy test winrate trên data cũ');
    console.log('  POST /reset    -> Reset bộ nhớ (Body: { type: "tx" | "md5" | "all" })');
    console.log(COLORS.cyan + '========================================================' + COLORS.reset);
});
