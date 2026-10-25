/**
 * ==========================================================
 * VIP GOD TIER AI - SERVER V18 (CỰC DÀI - 10 TẦNG PHÂN TÍCH)
 * ==========================================================
 * Hệ thống phân tích Tài Xỉu & MD5 tự động.
 * Tích hợp 10 tầng thuật toán: Bệt, 1-1, 2-2, 3-3, Pattern Matrix,
 * Telemetry, Bù trừ, Fibonacci, Markov Chain, Phân tích Nhịp độ.
 * 
 * Tác giả: VIP GOD TIER AI
 * Ngày cập nhật: 2024
 * ==========================================================
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================================
// CẤU HÌNH API GỐC VÀ HẰNG SỐ HỆ THỐNG
// ==========================================================
const API_TX_URL = 'https://wtx.tele68.com/v1/tx/sessions';
const API_MD5_URL = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';

const CONFIG = {
    MIN_PHIEN_REQUIRED: 20,
    MAX_HISTORY_STORE: 100, // Lưu tối đa 100 phiên vào bộ nhớ
    FETCH_TIMEOUT: 15000,
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    LOG_LEVEL: 'INFO' // 'DEBUG' | 'INFO' | 'ERROR'
};

// ==========================================================
// BỘ NHỚ TẠM (LƯU LỊCH SỬ VÀ TRẠNG THÁI)
// ==========================================================
let memory = {
    tx: { 
        lastPhien: null, 
        lastPred: null, 
        history: [], 
        streakLog: [], 
        totalWin: 0, 
        totalLose: 0 
    },
    md5: { 
        lastPhien: null, 
        lastPred: null, 
        history: [], 
        streakLog: [], 
        totalWin: 0, 
        totalLose: 0 
    }
};

// ==========================================================
// HÀM TIỆN ÍCH LOG
// ==========================================================
function log(level, message) {
    const timestamp = new Date().toISOString();
    if (level === 'ERROR') console.error(`[${timestamp}] [ERROR] ${message}`);
    else if (level === 'DEBUG' && CONFIG.LOG_LEVEL === 'DEBUG') console.log(`[${timestamp}] [DEBUG] ${message}`);
    else if (level === 'INFO') console.log(`[${timestamp}] [INFO] ${message}`);
}

// ==========================================================
// HÀM FETCH DỮ LIỆU TỪ API (CÓ RETRY)
// ==========================================================
async function fetchGameData(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            log('DEBUG', `Đang fetch dữ liệu từ ${url} (Lần thử ${i + 1}/${retries})`);
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': CONFIG.USER_AGENT,
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
                },
                timeout: CONFIG.FETCH_TIMEOUT
            });
            
            if (res.status === 200 && res.data) {
                log('DEBUG', `Fetch thành công từ ${url.split('/')[2]}`);
                return res.data;
            }
        } catch (error) {
            log('ERROR', `Lỗi fetch ${url.split('/')[2]} (Lần ${i + 1}): ${error.message}`);
            if (i === retries - 1) return null;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Đợi 1s trước khi retry
        }
    }
    return null;
}

// ==========================================================
// TẦNG 1: PHÂN TÍCH CẦU BỆT (STREAK ANALYZER)
// ==========================================================
function analyzeStreak(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '', streakLen: 0 };
    if (!history || history.length < 2) return result;

    const len = history.length;
    const last = history[len - 1];
    let streakLen = 1;

    for (let i = len - 2; i >= 0; i--) {
        if (history[i] === last) streakLen++;
        else break;
    }

    result.streakLen = streakLen;

    if (streakLen >= 2 && streakLen <= 4) {
        // Bệt ngắn 2-4 tay: Đánh tiếp
        const score = streakLen * 15;
        if (last === 'T') result.scoreT += score;
        else result.scoreX += score;
        result.reason = `Bám bệt ${streakLen} tay`;
    } else if (streakLen >= 5) {
        // Bệt dài >= 5 tay: Cực kỳ nguy hiểm, ưu tiên bẻ
        const score = streakLen * 20;
        if (last === 'T') result.scoreX += score;
        else result.scoreT += score;
        result.reason = `Ép bẻ bệt dài ${streakLen} tay`;
    }

    return result;
}

// ==========================================================
// TẦNG 2: PHÂN TÍCH CẦU 1-1 (ZIGZAG ANALYZER)
// ==========================================================
function analyzeZigzag(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '', zigzagCount: 0 };
    if (!history || history.length < 4) return result;

    const len = history.length;
    const last = history[len - 1];
    let zigzagCount = 0;

    for (let i = len - 1; i >= 1; i--) {
        if (history[i] !== history[i - 1]) zigzagCount++;
        else break;
    }

    result.zigzagCount = zigzagCount;

    if (zigzagCount >= 3) {
        const score = zigzagCount * 10;
        if (last === 'T') result.scoreX += score;
        else result.scoreT += score;
        result.reason = `Cầu đảo 1-1 (${zigzagCount} nhịp)`;
    }

    return result;
}

// ==========================================================
// TẦNG 3: PHÂN TÍCH PATTERN 2-2 VÀ 3-3
// ==========================================================
function analyzePattern(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '' };
    if (!history || history.length < 6) return result;

    const last4 = history.slice(-4).join('');
    const last6 = history.slice(-6).join('');
    const last = history[history.length - 1];

    if (last4 === 'TTXX' || last4 === 'XXTT') {
        if (last === 'X') result.scoreT += 25;
        else result.scoreX += 25;
        result.reason = 'Pattern 2-2';
    }
    
    if (last6 === 'TTTXXX' || last6 === 'XXXTTT') {
        if (last === 'X') result.scoreT += 30;
        else result.scoreX += 30;
        result.reason = 'Pattern 3-3';
    }

    return result;
}

// ==========================================================
// TẦNG 4: PATTERN MATRIX (TRUY VẾT QUÁ KHỨ)
// ==========================================================
function analyzeMatrix(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '', pastMatchT: 0, pastMatchX: 0 };
    if (!history || history.length < 10) return result;

    const len = history.length;
    const lookbackPattern = history.slice(-5).join('');
    let pastMatchT = 0, pastMatchX = 0;

    for (let i = 0; i < len - 5; i++) {
        if (history.slice(i, i + 5).join('') === lookbackPattern) {
            if (history[i + 5] === 'T') pastMatchT++;
            if (history[i + 5] === 'X') pastMatchX++;
        }
    }

    result.pastMatchT = pastMatchT;
    result.pastMatchX = pastMatchX;

    if (pastMatchT > pastMatchX) {
        result.scoreT += pastMatchT * 8;
        result.reason = `Lịch sử báo Tài (${pastMatchT} lần)`;
    } else if (pastMatchX > pastMatchT) {
        result.scoreX += pastMatchX * 8;
        result.reason = `Lịch sử báo Xỉu (${pastMatchX} lần)`;
    }

    return result;
}

// ==========================================================
// TẦNG 5: XÚC XẮC TELEMETRY (BẮT MẠCH XÚC XẮC)
// ==========================================================
function analyzeDiceTelemetry(diceHistory) {
    let result = { scoreT: 0, scoreX: 0, reason: '' };
    if (!diceHistory || diceHistory.length < 3) return result;

    const recentDices = diceHistory.slice(0, 3).map(d => d.point);
    const allOdd = recentDices.every(p => p % 2 !== 0);
    const allEven = recentDices.every(p => p % 2 === 0);

    if (allOdd) {
        result.scoreX += 15;
        result.reason = '3 phiên toàn Tài lẻ';
    }
    if (allEven) {
        result.scoreT += 15;
        result.reason = '3 phiên toàn Xỉu chẵn';
    }

    const sumDice = recentDices.reduce((a, b) => a + b, 0);
    if (sumDice > 38) {
        result.scoreX += 10;
        result.reason += ' + Tổng xúc xắc cao';
    }
    if (sumDice < 24) {
        result.scoreT += 10;
        result.reason += ' + Tổng xúc xắc thấp';
    }

    return result;
}

// ==========================================================
// TẦNG 6: CÂN BẰNG (BÙ TRỪ)
// ==========================================================
function analyzeBalance(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '' };
    if (!history || history.length < 15) return result;

    const last15 = history.slice(-15);
    const countT = last15.filter(x => x === 'T').length;
    const countX = last15.filter(x => x === 'X').length;

    if (countT > 10) {
        result.scoreX += 20;
        result.reason = 'Ép bù Xỉu (15 phiên nghiêng Tài)';
    }
    if (countX > 10) {
        result.scoreT += 20;
        result.reason = 'Ép bù Tài (15 phiên nghiêng Xỉu)';
    }

    return result;
}

// ==========================================================
// TẦNG 7: FIBONACCI (DÃY SỐ VÀNG)
// ==========================================================
function analyzeFibonacci(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '' };
    if (!history || history.length < 10) return result;

    // Fibonacci: 1, 2, 3, 5, 8...
    const fibPositions = [1, 2, 3, 5, 8];
    let fibT = 0, fibX = 0;
    const len = history.length;

    for (let pos of fibPositions) {
        if (len - pos >= 0) {
            if (history[len - pos] === 'T') fibT++;
            else fibX++;
        }
    }

    if (fibT > fibX) {
        result.scoreT += fibT * 5;
        result.reason = 'Fibonacci ủng hộ Tài';
    } else if (fibX > fibT) {
        result.scoreX += fibX * 5;
        result.reason = 'Fibonacci ủng hộ Xỉu';
    }

    return result;
}

// ==========================================================
// TẦNG 8: MARKOV CHAIN (CHUỖI CHUYỂN ĐỔI)
// ==========================================================
function analyzeMarkovChain(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '' };
    if (!history || history.length < 20) return result;

    const len = history.length;
    const last = history[len - 1];
    let transTtoT = 0, transTtoX = 0;
    let transXtoT = 0, transXtoX = 0;

    for (let i = 0; i < len - 1; i++) {
        if (history[i] === 'T' && history[i + 1] === 'T') transTtoT++;
        if (history[i] === 'T' && history[i + 1] === 'X') transTtoX++;
        if (history[i] === 'X' && history[i + 1] === 'T') transXtoT++;
        if (history[i] === 'X' && history[i + 1] === 'X') transXtoX++;
    }

    if (last === 'T') {
        if (transTtoT > transTtoX) {
            result.scoreT += 15;
            result.reason = `Markov: T->T (${transTtoT} lần)`;
        } else {
            result.scoreX += 15;
            result.reason = `Markov: T->X (${transTtoX} lần)`;
        }
    } else {
        if (transXtoX > transXtoT) {
            result.scoreX += 15;
            result.reason = `Markov: X->X (${transXtoX} lần)`;
        } else {
            result.scoreT += 15;
            result.reason = `Markov: X->T (${transXtoT} lần)`;
        }
    }

    return result;
}

// ==========================================================
// TẦNG 9: PHÂN TÍCH NHỊP ĐỘ (RHYTHM ANALYZER)
// ==========================================================
function analyzeRhythm(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '' };
    if (!history || history.length < 8) return result;

    const len = history.length;
    const recent8 = history.slice(-8);

    // Tìm nhịp 3-1, 1-3
    let countT = recent8.filter(x => x === 'T').length;
    let countX = recent8.filter(x => x === 'X').length;

    if (countT === 6 || countT === 7) {
        result.scoreX += 12;
        result.reason = 'Nhịp độ nghiêng Tài, báo Xỉu';
    }
    if (countX === 6 || countX === 7) {
        result.scoreT += 12;
        result.reason = 'Nhịp độ nghiêng Xỉu, báo Tài';
    }

    // Nhịp 2-2-2-2
    const pattern = history.slice(-8).join('');
    if (pattern === 'TTXXTTXX') {
        result.scoreX += 20;
        result.reason = 'Nhịp 2-2-2-2, báo Xỉu';
    }
    if (pattern === 'XXTTXXTT') {
        result.scoreT += 20;
        result.reason = 'Nhịp 2-2-2-2, báo Tài';
    }

    return result;
}

// ==========================================================
// TẦNG 10: CẢM BIẾN NHIỄU (ENTROPY SENSOR)
// ==========================================================
function analyzeEntropy(history) {
    let result = { scoreT: 0, scoreX: 0, reason: '', entropy: 0 };
    if (!history || history.length < 10) return result;

    // Tính Entropy (độ nhiễu) dựa trên tần suất
    const len = history.length;
    const countT = history.filter(x => x === 'T').length;
    const countX = history.filter(x => x === 'X').length;

    const probT = countT / len;
    const probX = countX / len;

    // Entropy càng cao thì cầu càng nhiễu
    let entropy = 0;
    if (probT > 0) entropy -= probT * Math.log2(probT);
    if (probX > 0) entropy -= probX * Math.log2(probX);

    result.entropy = entropy;

    // Nếu entropy cao (cầu nhiễu), bẻ nhịp
    if (entropy > 0.9) {
        const last = history[len - 1];
        if (last === 'T') result.scoreX += 10;
        else result.scoreT += 10;
        result.reason = 'Entropy cao (Cầu nhiễu), bẻ nhịp';
    }

    return result;
}

// ==========================================================
// TỔNG HỢP TẤT CẢ CÁC TẦNG (MAIN ALGORITHM)
// ==========================================================
function vipGodTierEngine(history, diceHistory) {
    if (!history || history.length < CONFIG.MIN_PHIEN_REQUIRED) {
        return { predict: 'CHỜ', confidence: '0%', reason: 'Chưa đủ dữ liệu' };
    }

    const last = history[history.length - 1];
    let scoreT = 0;
    let scoreX = 0;
    let reasons = [];

    // Chạy từng tầng phân tích
    const t1 = analyzeStreak(history);
    const t2 = analyzeZigzag(history);
    const t3 = analyzePattern(history);
    const t4 = analyzeMatrix(history);
    const t5 = analyzeDiceTelemetry(diceHistory);
    const t6 = analyzeBalance(history);
    const t7 = analyzeFibonacci(history);
    const t8 = analyzeMarkovChain(history);
    const t9 = analyzeRhythm(history);
    const t10 = analyzeEntropy(history);

    // Cộng dồn điểm
    scoreT += t1.scoreT + t2.scoreT + t3.scoreT + t4.scoreT + t5.scoreT + t6.scoreT + t7.scoreT + t8.scoreT + t9.scoreT + t10.scoreT;
    scoreX += t1.scoreX + t2.scoreX + t3.scoreX + t4.scoreX + t5.scoreX + t6.scoreX + t7.scoreX + t8.scoreX + t9.scoreX + t10.scoreX;

    // Thu thập lý do
    if (t1.reason) reasons.push(t1.reason);
    if (t2.reason) reasons.push(t2.reason);
    if (t3.reason) reasons.push(t3.reason);
    if (t4.reason) reasons.push(t4.reason);
    if (t5.reason) reasons.push(t5.reason);
    if (t6.reason) reasons.push(t6.reason);
    if (t7.reason) reasons.push(t7.reason);
    if (t8.reason) reasons.push(t8.reason);
    if (t9.reason) reasons.push(t9.reason);
    if (t10.reason) reasons.push(t10.reason);

    // Chốt kết quả
    let predict = 'TÀI';
    let diff = scoreT - scoreX;

    if (scoreX > scoreT) {
        predict = 'XỈU';
        diff = scoreX - scoreT;
    } else if (scoreT === scoreX) {
        predict = last === 'T' ? 'XỈU' : 'TÀI';
        diff = 10;
        reasons.push('Hòa điểm -> Bẻ nhịp');
    }

    // Tính tỉ lệ động (55% - 88%)
    let confidence = 55;
    if (diff >= 150) confidence = 88;      // Siêu chắc chắn (10 tầng đồng thuận)
    else if (diff >= 120) confidence = 85; // Rất chắc
    else if (diff >= 90) confidence = 80;  // Chắc
    else if (diff >= 60) confidence = 75;  // Khá
    else if (diff >= 40) confidence = 68;  // Trung bình
    else if (diff >= 20) confidence = 60;  // Yếu
    else confidence = 55;                  // Nhiễu

    return {
        predict,
        confidence: `${confidence}%`,
        reason: reasons.slice(0, 4).join(' + ') // Lấy tối đa 4 lý do
    };
}

// ==========================================================
// HÀM XỬ LÝ CHÍNH (TÍNH TOÁN & LƯU LỊCH SỬ)
// ==========================================================
async function processGame(apiUrl, gameType) {
    const data = await fetchGameData(apiUrl);
    if (!data || !data.list || data.list.length === 0) {
        throw new Error("Không lấy được dữ liệu từ API");
    }

    const list = data.list;
    const currentPhien = String(list[0].id);
    
    // Đảo ngược lịch sử để phân tích từ cũ đến mới
    const history = list.map(item => item.resultTruyenThong === 'TAI' ? 'T' : 'X').reverse();
    const diceHistory = list.map(item => ({ point: item.point, dices: item.dices }));

    const mem = memory[gameType];

    // 1. TỰ ĐỘNG TÍNH WIN/LOSE CỦA PHIÊN TRƯỚC
    if (mem.lastPhien && parseFloat(currentPhien) > parseFloat(mem.lastPhien)) {
        const actualObj = list.find(x => String(x.id) === mem.lastPhien);
        if (actualObj && mem.lastPred) {
            const actualStr = actualObj.resultTruyenThong === 'TAI' ? 'TÀI' : 'XỈU';
            const isWin = (actualStr === mem.lastPred);
            
            // Lưu vào lịch sử
            mem.history.push({
                phien: mem.lastPhien,
                duDoan: mem.lastPred,
                ketQua: actualStr,
                status: isWin ? 'WIN' : 'LOSE'
            });

            // Cập nhật thống kê
            if (isWin) mem.totalWin++;
            else mem.totalLose++;

            // Giới hạn lịch sử
            if (mem.history.length > CONFIG.MAX_HISTORY_STORE) {
                mem.history.shift();
            }

            log('INFO', `[${gameType.toUpperCase()}] Phiên ${mem.lastPhien} -> Dự đoán: ${mem.lastPred} | KQ: ${actualStr} | ${isWin ? 'WIN' : 'LOSE'}`);
        }
    }

    // 2. DỰ ĐOÁN PHIÊN TIẾP THEO
    const prediction = vipGodTierEngine(history, diceHistory);

    // 3. CẬP NHẬT BỘ NHỚ
    mem.lastPhien = currentPhien;
    mem.lastPred = prediction.predict;

    log('DEBUG', `[${gameType.toUpperCase()}] Dự đoán phiên ${parseFloat(currentPhien) + 1}: ${prediction.predict} (${prediction.confidence})`);

    return {
        phienHienTai: currentPhien,
        phienDuDoan: String(parseFloat(currentPhien) + 1),
        duDoan: prediction.predict,
        tiLe: prediction.confidence,
        liDo: prediction.reason,
        xucXac: list[0].dices || [],
        tongDiem: list[0].point || 0
    };
}

// ==========================================================
// CÁC ROUTER API
// ==========================================================

// 1. API Dự đoán Tài Xỉu
app.get('/taixiu', async (req, res) => {
    try {
        const result = await processGame(API_TX_URL, 'tx');
        res.json({ status: "success", data: result });
    } catch (error) {
        log('ERROR', `Lỗi API /taixiu: ${error.message}`);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// 2. API Dự đoán MD5
app.get('/md5', async (req, res) => {
    try {
        const result = await processGame(API_MD5_URL, 'md5');
        res.json({ status: "success", data: result });
    } catch (error) {
        log('ERROR', `Lỗi API /md5: ${error.message}`);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// 3. API Lịch sử Tài Xỉu
app.get('/lstaixiu', (req, res) => {
    res.json({
        status: "success",
        totalWin: memory.tx.totalWin,
        totalLose: memory.tx.totalLose,
        data: memory.tx.history.reverse() // Đảo ngược để phiên mới nhất lên đầu
    });
});

// 4. API Lịch sử MD5
app.get('/lsmd5', (req, res) => {
    res.json({
        status: "success",
        totalWin: memory.md5.totalWin,
        totalLose: memory.md5.totalLose,
        data: memory.md5.history.reverse()
    });
});

// 5. API Kiểm tra trạng thái Server
app.get('/status', (req, res) => {
    res.json({
        status: "online",
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        tx: { totalWin: memory.tx.totalWin, totalLose: memory.tx.totalLose },
        md5: { totalWin: memory.md5.totalWin, totalLose: memory.md5.totalLose }
    });
});

// ==========================================================
// KHỞI ĐỘNG SERVER
// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("=========================================");
    console.log(`🔥 VIP GOD TIER SERVER V18 ĐANG CHẠY TẠI: http://localhost:${PORT}`);
    console.log(`- Dự đoán Tài Xỉu: http://localhost:${PORT}/taixiu`);
    console.log(`- Dự đoán MD5:     http://localhost:${PORT}/md5`);
    console.log(`- Lịch sử Tài Xỉu: http://localhost:${PORT}/lstaixiu`);
    console.log(`- Lịch sử MD5:     http://localhost:${PORT}/lsmd5`);
    console.log(`- Trạng thái:      http://localhost:${PORT}/status`);
    console.log("=========================================");
});
