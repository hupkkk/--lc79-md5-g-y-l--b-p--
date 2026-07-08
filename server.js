const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

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
let sessionHistory = [];          // Lịch sử các phiên đã thu thập
let currentSession = null;        // Phiên hiện tại
let stats = {
    predictions: { total: 0, correct: 0, wrong: 0 },
    patternCounts: {},
};
let prediction = null;            // Kết quả dự đoán cho phiên tiếp theo

// ============================================
// Hàm gọi API và cập nhật phiên
// ============================================
async function fetchSession() {
    try {
        const response = await axios.get(API_URL, { timeout: 5000 });
        const data = response.data;

        // Giả sử API trả về dạng { id, phien, ket_qua, xuc_xac }
        // Nếu cấu trúc khác, cần ánh xạ
        const newSession = {
            id: data.id || 'S2KING',
            phien: parseInt(data.phien) || 0,
            ket_qua: data.ket_qua ? data.ket_qua.toLowerCase() : null,
            xuc_xac: data.xuc_xac || '',
        };

        // Chỉ cập nhật nếu có phiên mới (tránh trùng)
        if (newSession.phien && newSession.ket_qua) {
            if (!currentSession || currentSession.phien !== newSession.phien) {
                currentSession = newSession;
                sessionHistory.push(newSession);

                // Giới hạn kích thước lịch sử
                if (sessionHistory.length > MAX_HISTORY) {
                    sessionHistory = sessionHistory.slice(-MAX_HISTORY);
                }

                // Sau khi có phiên mới, thực hiện dự đoán cho phiên tiếp theo
                predictNext();
            }
        }
    } catch (error) {
        console.error('Lỗi khi gọi API:', error.message);
    }
}

// ============================================
// Thuật toán dự đoán siêu nét
// ============================================
function predictNext() {
    if (sessionHistory.length < 2) {
        // Chưa đủ dữ liệu, dự đoán ngẫu nhiên với độ tin cậy thấp
        prediction = {
            id: 'S2KING',
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

    // ---- 1. Phân tích Markov bậc 1 ----
    // Đếm số lần chuyển tiếp từ kết quả hiện tại sang kết quả tiếp theo
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

    let probTai = 0.5;
    let probXiu = 0.5;
    if (totalFromLast > 0) {
        probTai = transitions[lastResult]['tài'] / totalFromLast;
        probXiu = transitions[lastResult]['xỉu'] / totalFromLast;
    }

    // ---- 2. Phân tích chuỗi (cầu) ----
    // Phân loại loại cầu dựa trên 3-5 phiên gần nhất
    const recent = sessionHistory.slice(-5).map(s => s.ket_qua);
    let loaiCau = 'bệt';
    if (recent.length >= 3) {
        // Cầu đơn (1-1): kiểm tra xen kẽ
        let isSingle = true;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] === recent[i-1]) { isSingle = false; break; }
        }
        if (isSingle) {
            loaiCau = 'đơn';
        } else {
            // Cầu bệt: các kết quả giống nhau
            const first = recent[0];
            const same = recent.every(r => r === first);
            if (same) {
                loaiCau = 'bệt';
            } else {
                // Cầu 1-2, 2-1, v.v. – đơn giản gọi là 'phức tạp'
                loaiCau = 'phức tạp';
            }
        }
    }

    // ---- 3. Kết hợp và tính độ tin cậy ----
    // Độ tin cậy dựa trên số lần quan sát và độ lệch so với 50%
    let confidence = Math.round(Math.abs(probTai - 0.5) * 100);
    // Tối thiểu 30%, tối đa 95%
    confidence = Math.max(30, Math.min(95, confidence));

    // Lựa chọn dự đoán
    const duDoan = probTai >= 0.5 ? 'tài' : 'xỉu';

    // Cập nhật thống kê dự đoán
    // Lưu ý: Chưa thể cập nhật đúng/sai vì chưa có kết quả thực tế của phiên dự đoán
    // Phần này sẽ được cập nhật khi phiên tiếp theo xuất hiện

    prediction = {
        id: 'S2KING',
        phien: currentSession.phien + 1,  // Dự đoán cho phiên tiếp theo
        ket_qua: null,                     // Chưa có kết quả
        xuc_xac: null,                     // Chưa có xúc xắc
        du_doan: duDoan,
        do_tin_cay: confidence + '%',
        loai_cau: loaiCau,
        thong_ke_dung_sai: {
            Dung: stats.predictions.correct,
            Sai: stats.predictions.wrong
        }
    };
}

// Hàm kiểm tra dự đoán đúng/sai ngay khi có phiên mới thực tế
function validatePrediction(actualSession) {
    if (!prediction || !actualSession) return;
    // Nếu phiên thực tế trùng với phiên dự đoán
    if (actualSession.phien === prediction.phien) {
        const isCorrect = actualSession.ket_qua === prediction.du_doan;
        stats.predictions.total++;
        if (isCorrect) {
            stats.predictions.correct++;
        } else {
            stats.predictions.wrong++;
        }
        // Cập nhật lại thống kê trong prediction object
        prediction.thong_ke_dung_sai = {
            Dung: stats.predictions.correct,
            Sai: stats.predictions.wrong
        };
    }
}

// ============================================
// Polling tự động
// ============================================
setInterval(async () => {
    await fetchSession();
    // Kiểm tra và validate dự đoán
    if (currentSession) {
        validatePrediction(currentSession);
    }
}, POLL_INTERVAL);

// Gọi ngay lần đầu
fetchSession();

// ============================================
// API endpoints
// ============================================

// Lấy thông tin phiên hiện tại
app.get('/current', (req, res) => {
    res.json({
        success: true,
        data: currentSession ? {
            id: currentSession.id,
            phien: currentSession.phien,
            ket_qua: currentSession.ket_qua,
            xuc_xac: currentSession.xuc_xac,
        } : null
    });
});

// Lấy dự đoán cho phiên tiếp theo
app.get('/predict', (req, res) => {
    res.json({
        success: true,
        data: prediction
    });
});

// Lấy toàn bộ lịch sử phiên (có thể giới hạn)
app.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = sessionHistory.slice(-limit);
    res.json({
        success: true,
        data: history
    });
});

// Lấy thống kê tổng quan
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
// Khởi động server
// ============================================
app.listen(PORT, () => {
    console.log(`Server chạy tại http://localhost:${PORT}`);
    console.log('Đang thu thập dữ liệu phiên...');
});
