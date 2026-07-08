const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_URL = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=15766f58a95cb4f95975ffcf643f524c';
const POLL_INTERVAL = 3000;
const MAX_HISTORY = 1000;

let sessionHistory = [];
let currentSession = null;
let stats = { predictions: { total: 0, correct: 0, wrong: 0 } };
let prediction = null;

async function fetchSession() {
    try {
        console.log(`[${new Date().toISOString()}] Đang gọi API...`);
        const response = await axios.get(API_URL, { timeout: 10000 });
        const raw = response.data;

        if (!raw.list || !Array.isArray(raw.list) || raw.list.length === 0) {
            console.log('API trả về list rỗng hoặc không tồn tại');
            return;
        }

        // Sắp xếp các phiên theo thứ tự tăng dần (cũ → mới)
        const sorted = raw.list.slice().sort((a, b) => a.id - b.id);
        const currentPhien = currentSession ? currentSession.phien : null;

        // Lọc ra các phiên mới hơn phiên hiện tại
        const newSessions = sorted.filter(s => currentPhien === null || s.id > currentPhien);

        if (newSessions.length === 0) {
            console.log('Không có phiên mới');
            return;
        }

        console.log(`Phát hiện ${newSessions.length} phiên mới`);

        // Xử lý từng phiên mới theo thứ tự cũ → mới
        for (const s of newSessions) {
            const phien = parseInt(s.id);
            const ketQua = s.resultTruyenThong ? s.resultTruyenThong.toLowerCase() : null;
            const dices = s.dices;

            if (!phien || !ketQua || !dices) {
                console.log('Thiếu dữ liệu trong phiên:', s);
                continue;
            }

            const newSession = {
                phien: phien,
                ket_qua: ketQua,
                xuc_xac: dices.join(',')
            };

            // Kiểm tra dự đoán cho phiên này (nếu có dự đoán trước đó)
            if (currentSession) {
                validatePrediction(newSession);
            }

            // Cập nhật phiên hiện tại và lịch sử
            currentSession = newSession;
            sessionHistory.push(newSession);
            if (sessionHistory.length > MAX_HISTORY) {
                sessionHistory = sessionHistory.slice(-MAX_HISTORY);
            }

            // Tạo dự đoán cho phiên tiếp theo
            predictNext();
        }
    } catch (error) {
        console.error('Lỗi API:', error.message);
    }
}

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

    // Markov chain
    const transitions = { 'tài': { 'tài': 0, 'xỉu': 0 }, 'xỉu': { 'tài': 0, 'xỉu': 0 } };
    for (let i = 0; i < sessionHistory.length - 1; i++) {
        const from = sessionHistory[i].ket_qua;
        const to = sessionHistory[i+1].ket_qua;
        if (transitions[from]) transitions[from][to]++;
    }

    const lastResult = sessionHistory[sessionHistory.length - 1].ket_qua;
    const total = transitions[lastResult]['tài'] + transitions[lastResult]['xỉu'];
    let probTai = 0.5;
    if (total > 0) probTai = transitions[lastResult]['tài'] / total;

    // Loại cầu
    const recent = sessionHistory.slice(-5).map(s => s.ket_qua);
    let loaiCau = 'bệt';
    if (recent.length >= 3) {
        const isSingle = recent.slice(1).every((r, i) => r !== recent[i]);
        if (isSingle) loaiCau = 'đơn';
        else {
            const first = recent[0];
            const same = recent.every(r => r === first);
            if (same) loaiCau = 'bệt';
            else loaiCau = 'phức tạp';
        }
    }

    let conf = Math.round(Math.abs(probTai - 0.5) * 100);
    conf = Math.max(30, Math.min(95, conf));

    prediction = {
        phien: currentSession.phien + 1,
        ket_qua: null,
        xuc_xac: null,
        du_doan: probTai >= 0.5 ? 'tài' : 'xỉu',
        do_tin_cay: conf + '%',
        loai_cau: loaiCau,
        thong_ke_dung_sai: { Dung: stats.predictions.correct, Sai: stats.predictions.wrong }
    };
    console.log('Dự đoán:', JSON.stringify(prediction));
}

function validatePrediction(actual) {
    if (!prediction || !actual || actual.phien !== prediction.phien) return;
    const isCorrect = actual.ket_qua === prediction.du_doan;
    stats.predictions.total++;
    if (isCorrect) stats.predictions.correct++;
    else stats.predictions.wrong++;
    prediction.thong_ke_dung_sai = { Dung: stats.predictions.correct, Sai: stats.predictions.wrong };
}

// Tự động cập nhật theo chu kỳ
setInterval(async () => {
    await fetchSession();
}, POLL_INTERVAL);

// Gọi lần đầu khi khởi động
fetchSession();

// Các API endpoints
app.get('/', (req, res) => {
    res.json({ message: 'Server dự đoán tài/xỉu', endpoints: { current: '/current', predict: '/predict', history: '/history', stats: '/stats' } });
});

app.get('/current', (req, res) => {
    if (!currentSession) return res.json({ success: true, data: { message: 'Chưa có dữ liệu' } });
    res.json({ success: true, data: { id: 'S2KING', phien: currentSession.phien, ket_qua: currentSession.ket_qua, xuc_xac: currentSession.xuc_xac } });
});

app.get('/predict', (req, res) => {
    if (!prediction) return res.json({ success: true, data: { message: 'Chưa đủ dữ liệu' } });
    res.json({ success: true, data: { id: 'S2KING', phien: prediction.phien, ket_qua: prediction.ket_qua, xuc_xac: prediction.xuc_xac, du_doan: prediction.du_doan, do_tin_cay: prediction.do_tin_cay, loai_cau: prediction.loai_cau, thong_ke_dung_sai: prediction.thong_ke_dung_sai } });
});

app.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ success: true, data: sessionHistory.slice(-limit) });
});

app.get('/stats', (req, res) => {
    res.json({ success: true, data: { total_sessions: sessionHistory.length, ...stats, current_prediction: prediction ? { phien: prediction.phien, du_doan: prediction.du_doan, do_tin_cay: prediction.do_tin_cay, loai_cau: prediction.loai_cau } : null } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server chạy tại http://localhost:${PORT}`));