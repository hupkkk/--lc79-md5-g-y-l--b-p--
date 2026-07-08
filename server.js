const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Cho phép request từ mọi origin
app.use(cors());
app.use(express.json());

// ============================================
// Cấu hình
// ============================================
const API_URL = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=15766f58a95cb4f95975ffcf643f524c';
const POLL_INTERVAL = 3000; // 3 giây
const MAX_HISTORY = 1000;   // Lưu tối đa 1000 phiên

// ============================================
// Biến lưu trữ
// ============================================
let sessionHistory = [];
let currentSession = null;
let stats = {
    predictions: { total: 0, correct: 0, wrong: 0 },
    patternCounts: {},
};
let prediction = null;

// ============================================
// Hàm gọi API và cập nhật phiên
// ============================================
async function fetchSession() {
    try {
        console.log(`[${new Date().toISOString()}] Đang gọi API...`);
        const response = await axios.get(API_URL, { timeout: 10000 });
        const rawData = response.data;

        // Log dữ liệu thô để debug
        console.log('Dữ liệu thô:', JSON.stringify(rawData).substring(0, 1000));

        // Nếu là mảng, lấy phần tử đầu
        let data = rawData;
        if (Array.isArray(rawData) && rawData.length > 0) {
            data = rawData[0];
        }

        // Thử các tên trường khả dĩ
        const possiblePhien = ['phien', 'id', 'session_id', 'round', 'ma'];
        const possibleKetQua = ['ket_qua', 'result', 'ketqua', 'tai_xiu', 'kq'];
        const possibleXucXac = ['xuc_xac', 'dice', 'xucxac', 'mat'];

        let phien = null;
        let ketQua = null;
        let xucXac = '';

        // Tìm trường phiên
        for (const key of possiblePhien) {
            if (data[key] !== undefined) {
                phien = data[key];
                break;
            }
        }

        // Tìm trường kết quả
        for (const key of possibleKetQua) {
            if (data[key] !== undefined) {
                ketQua = data[key];
                break;
            }
        }

        // Tìm trường xúc xắc
        for (const key of possibleXucXac) {
            if (data[key] !== undefined) {
                xucXac = data[key];
                break;
            }
        }

        if (phien && ketQua) {
            const newSession = {
                phien: parseInt(phien) || 0,
                ket_qua: ketQua.toString().toLowerCase(),
                xuc_xac: xucXac.toString(),
            };

            console.log('Phiên mới:', JSON.stringify(newSession));

            // Kiểm tra trùng
            if (!currentSession || currentSession.phien !== newSession.phien) {
                currentSession = newSession;
                sessionHistory.push(newSession);

                if (sessionHistory.length > MAX_HISTORY) {
                    sessionHistory = sessionHistory.slice(-MAX_HISTORY);
                }

                // Dự đoán phiên tiếp theo
                predictNext();
            }
        } else {
            console.log('Không tìm thấy phiên/kết quả. Các key hiện có:', Object.keys(data));
            // Nếu lần đầu và chưa có gì, tạo prediction mặc định
            if (!currentSession && !prediction) {
                prediction = {
                    phien: 1,
                    ket_qua: null,
                    xuc_xac: null,
                    du_doan: 'chờ dữ liệu',
                    do_tin_cay: '0%',
                    loai_cau: 'chưa xác định',
                    thong_ke_dung_sai: { Dung: 0, Sai: 0 }
                };
            }
        }
    } catch (error) {
        console.error('Lỗi khi gọi API:', error.message);
        // Nếu lỗi mạng, tạo prediction mặc định để tránh null
        if (!prediction) {
            prediction = {
                phien: 1,
                ket_qua: null,
                xuc_xac: null,
                du_doan: 'lỗi kết nối',
                do_tin_cay: '0%',
                loai_cau: 'lỗi',
                thong_ke_dung_sai: { Dung: 0, Sai: 0 }
            };
        }
    }
}

// ============================================
// Thuật toán dự đoán (cải tiến)
// ============================================
function predictNext() {
    if (sessionHistory.length < 2) {
        prediction = {
            phien: currentSession ? currentSession.phien + 1 : 1,
            ket_qua: null,
            xuc_xac: null,
            du_doan: Math.random() < 0.5 ? 'tài' : 'xỉu',
            do_tin_cay: '50%',
            loai_cau: 'chưa xác định',
            thong_ke_dung_sai: { Dung: stats.predictions.correct, Sai: stats.predictions.wrong }
        };
        return;
    }

    // Markov chain bậc 1
    const transitions = { 'tài': { 'tài': 0, 'xỉu': 0 }, 'xỉu': { 'tài': 0, 'xỉu': 0 } };
    for (let i = 0; i < sessionHistory.length - 1; i++) {
        const from = sessionHistory[i].ket_qua;
        const to = sessionHistory[i+1].ket_qua;
        if (transitions[from] && transitions[from][to] !== undefined) {
            transitions[from][to]++;
        }
    }

    const lastResult = sessionHistory[sessionHistory.length - 1].ket_qua;
    const totalFromLast = transitions[lastResult]['tài'] + transitions[lastResult]['xỉu'];
    let probTai = 0.5, probXiu = 0.5;
    if (totalFromLast > 0) {
        probTai = transitions[lastResult]['tài'] / totalFromLast;
        probXiu = transitions[lastResult]['xỉu'] / totalFromLast;
    }

    // Phân loại cầu
    const recent = sessionHistory.slice(-5).map(s => s.ket_qua);
    let loaiCau = 'bệt';
    if (recent.length >= 3) {
        let isSingle = true;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] === recent[i-1]) { isSingle = false; break; }
        }
        if (isSingle) loaiCau = 'đơn';
        else {
            const first = recent[0];
            const same = recent.every(r => r === first);
            if (same) loaiCau = 'bệt';
            else loaiCau = 'phức tạp';
        }
    }

    let confidence = Math.round(Math.abs(probTai - 0.5) * 100);
    confidence = Math.max(30, Math.min(95, confidence));
    const duDoan = probTai >= 0.5 ? 'tài' : 'xỉu';

    prediction = {
        phien: currentSession.phien + 1,
        ket_qua: null,
        xuc_xac: null,
        du_doan: duDoan,
        do_tin_cay: confidence + '%',
        loai_cau: loaiCau,
        thong_ke_dung_sai: {
            Dung: stats.predictions.correct,
            Sai: stats.predictions.wrong
        }
    };

    console.log('Dự đoán mới:', JSON.stringify(prediction));
}

function validatePrediction(actualSession) {
    if (!prediction || !actualSession) return;
    if (actualSession.phien === prediction.phien) {
        const isCorrect = actualSession.ket_qua === prediction.du_doan;
        stats.predictions.total++;
        if (isCorrect) stats.predictions.correct++;
        else stats.predictions.wrong++;
        prediction.thong_ke_dung_sai = {
            Dung: stats.predictions.correct,
            Sai: stats.predictions.wrong
        };
    }
}

// ============================================
// Polling
// ============================================
setInterval(async () => {
    await fetchSession();
    if (currentSession) validatePrediction(currentSession);
}, POLL_INTERVAL);

// Gọi ngay lần đầu
fetchSession();

// ============================================
// API Endpoints
// ============================================

app.get('/', (req, res) => {
    res.json({
        message: 'Server dự đoán tài/xỉu đang chạy',
        endpoints: {
            current: '/current',
            predict: '/predict',
            history: '/history',
            stats: '/stats'
        }
    });
});

app.get('/current', (req, res) => {
    if (!currentSession) {
        return res.json({ success: true, data: { message: 'Chưa có dữ liệu phiên nào' } });
    }
    res.json({
        success: true,
        data: {
            id: 'S2KING',
            phien: currentSession.phien,
            ket_qua: currentSession.ket_qua,
            xuc_xac: currentSession.xuc_xac,
        }
    });
});

app.get('/predict', (req, res) => {
    if (!prediction) {
        return res.json({ success: true, data: { message: 'Chưa đủ dữ liệu để dự đoán' } });
    }
    res.json({
        success: true,
        data: {
            id: 'S2KING',
            phien: prediction.phien,
            ket_qua: prediction.ket_qua,
            xuc_xac: prediction.xuc_xac,
            du_doan: prediction.du_doan,
            do_tin_cay: prediction.do_tin_cay,
            loai_cau: prediction.loai_cau,
            thong_ke_dung_sai: prediction.thong_ke_dung_sai
        }
    });
});

app.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = sessionHistory.slice(-limit);
    res.json({ success: true, data: history });
});

app.get('/stats', (req, res) => {
    res.json({
        success: true,
        data: {
            total_sessions: sessionHistory.length,
            ...stats,
            current_prediction: prediction ? {
                phien: prediction.phien,
                du_doan: prediction.du_doan,
                do_tin_cay: prediction.do_tin_cay,
                loai_cau: prediction.loai_cau
            } : null
        }
    });
});

// ============================================
// Khởi động
// ============================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server chạy tại http://localhost:${PORT}`);
});
