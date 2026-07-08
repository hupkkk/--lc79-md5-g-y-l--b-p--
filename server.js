/**
 * =====================================================================================
 *  TAI XIU PREDICTOR SERVER
 *  - Lấy phiên thật liên tục từ API gốc (polling)
 *  - Áp dụng nhiều thuật toán thống kê / phát hiện cầu để dự đoán TAI/XIU phiên kế tiếp
 *  - Không random đúng/sai: mọi thống kê Dung/Sai được tính bằng cách so sánh
 *    Du_doan (đã lưu trước đó cho 1 phiên) với Ket_qua thật của chính phiên đó khi
 *    phiên đó đã có kết quả trả về từ API gốc.
 *  - Cung cấp API để lấy dự đoán mới nhất + lịch sử + thống kê, sẵn sàng deploy Render.
 * =====================================================================================
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CẤU HÌNH
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const SOURCE_API_URL =
  process.env.SOURCE_API_URL ||
  'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=15766f58a95cb4f95975ffcf643f524c';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const BOT_ID = process.env.BOT_ID || 'S2KING';

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PREDICTIONS_FILE = path.join(DATA_DIR, 'predictions.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// STORAGE HELPERS (đọc / ghi file JSON, lưu không giới hạn số lượng)
// ---------------------------------------------------------------------------
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim().length === 0) return fallback;
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error(`Lỗi đọc file ${file}:`, e.message);
  }
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Lỗi ghi file ${file}:`, e.message);
  }
}

// state trong bộ nhớ, đồng bộ ra file định kỳ
let sessions = loadJSON(SESSIONS_FILE, []); // [{id, ket_qua: 'TAI'|'XIU', dices:[..], point}] sắp xếp tăng dần theo id
let predictions = loadJSON(PREDICTIONS_FILE, []); // lịch sử toàn bộ dự đoán đã chốt (có kết quả thật để so sánh)
let stats = loadJSON(STATS_FILE, { dung: 0, sai: 0 });
let pendingPrediction = null; // dự đoán đang chờ phiên đó ra kết quả: {phien, du_doan, do_tin_cay, loai_cau, created_at}

// nếu đã có pending dự đoán được lưu từ trước (restart), khôi phục lại
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
pendingPrediction = loadJSON(PENDING_FILE, null);

function persistAll() {
  saveJSON(SESSIONS_FILE, sessions);
  saveJSON(PREDICTIONS_FILE, predictions);
  saveJSON(STATS_FILE, stats);
  saveJSON(PENDING_FILE, pendingPrediction);
}

// ---------------------------------------------------------------------------
// TIỆN ÍCH CHUYỂN ĐỔI TAI/XIU
// ---------------------------------------------------------------------------
function toVN(v) {
  return v === 'TAI' ? 'tài' : 'xỉu';
}
function opposite(v) {
  return v === 'TAI' ? 'XIU' : 'TAI';
}

// ---------------------------------------------------------------------------
// LẤY DỮ LIỆU TỪ API GỐC
// ---------------------------------------------------------------------------
async function fetchSourceSessions() {
  const res = await fetch(SOURCE_API_URL, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`API gốc trả về status ${res.status}`);
  }
  const json = await res.json();
  if (!json || !Array.isArray(json.list)) {
    throw new Error('Cấu trúc dữ liệu API gốc không hợp lệ (thiếu list[])');
  }
  // API trả về mới -> cũ, ta chuẩn hoá & đảo thành cũ -> mới để dễ xử lý chuỗi
  const normalized = json.list
    .map((item) => ({
      id: item.id,
      ket_qua: item.resultTruyenThong, // 'TAI' | 'XIU'
      dices: item.dices,
      point: item.point,
    }))
    .sort((a, b) => a.id - b.id); // tăng dần
  return normalized;
}

// ---------------------------------------------------------------------------
// CÁC THUẬT TOÁN DỰ ĐOÁN (mỗi thuật toán trả về {predict, confidence, label} hoặc null)
// results: mảng kết quả 'TAI'/'XIU' sắp xếp MỚI NHẤT ĐỨNG ĐẦU (results[0] = phiên gần nhất)
// ---------------------------------------------------------------------------

// 1) Thuật toán cầu bệt (streak)
function algoStreak(results) {
  if (results.length < 2) return null;
  const head = results[0];
  let streakLen = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === head) streakLen++;
    else break;
  }
  if (streakLen < 2) return null;

  let predict, confidence, tag;
  if (streakLen <= 4) {
    // Bệt ngắn -> nhiều khả năng còn tiếp tục theo cầu
    predict = head;
    confidence = Math.min(80, 52 + streakLen * 6);
    tag = `Bệt ${streakLen} (theo cầu)`;
  } else {
    // Bệt dài -> tăng khả năng bẻ cầu
    predict = opposite(head);
    confidence = Math.min(88, 55 + (streakLen - 4) * 5);
    tag = `Bệt ${streakLen} (bẻ cầu)`;
  }
  return { predict, confidence, label: tag, weight: 1.2 };
}

// 2) Thuật toán cầu đảo 1-1 (alternating)
function algoAlternating(results) {
  if (results.length < 4) return null;
  // kiểm tra pattern đảo liên tục từ đầu
  let altLen = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] !== results[i - 1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;
  // dự đoán tiếp tục đảo -> khác với kết quả gần nhất
  const predict = opposite(results[0]);
  const confidence = Math.min(85, 55 + (altLen - 4) * 4);
  return { predict, confidence, label: `Đảo 1-1 (chuỗi ${altLen})`, weight: 1.3 };
}

// 3) Chuỗi Markov bậc k (dùng toàn bộ lịch sử để xây bảng chuyển trạng thái)
function buildMarkovTable(chronoResults, order) {
  // chronoResults: cũ -> mới
  const table = {};
  for (let i = order; i < chronoResults.length; i++) {
    const key = chronoResults.slice(i - order, i).join(',');
    const next = chronoResults[i];
    if (!table[key]) table[key] = { TAI: 0, XIU: 0 };
    table[key][next]++;
  }
  return table;
}

function algoMarkov(chronoResults, results, order, minSamples) {
  if (chronoResults.length <= order) return null;
  const table = buildMarkovTable(chronoResults, order);
  const currentKey = results.slice(0, order).reverse().join(','); // chuyển results (mới->cũ) thành cũ->mới đúng thứ tự order gần nhất
  const entry = table[currentKey];
  if (!entry) return null;
  const total = entry.TAI + entry.XIU;
  if (total < minSamples) return null;
  const predict = entry.TAI >= entry.XIU ? 'TAI' : 'XIU';
  const majorityCount = Math.max(entry.TAI, entry.XIU);
  const confidence = Math.min(92, Math.round((majorityCount / total) * 100));
  return {
    predict,
    confidence,
    label: `Markov bậc ${order} (mẫu ${total} lần)`,
    weight: order === 3 ? 1.6 : order === 2 ? 1.3 : 0.9,
  };
}

// 4) Thống kê tần suất tổng (hồi quy về trung bình)
function algoFrequency(chronoResults) {
  if (chronoResults.length < 10) return null;
  const totalTAI = chronoResults.filter((r) => r === 'TAI').length;
  const totalXIU = chronoResults.length - totalTAI;
  const ratioTAI = totalTAI / chronoResults.length;
  const deviation = ratioTAI - 0.5;
  if (Math.abs(deviation) < 0.03) return null; // quá cân bằng, không đủ tín hiệu
  // Nếu TAI đang ra nhiều hơn hẳn -> dự đoán hồi quy về XIU và ngược lại
  const predict = deviation > 0 ? 'XIU' : 'TAI';
  const confidence = Math.min(70, Math.round(50 + Math.abs(deviation) * 120));
  return { predict, confidence, label: 'Thống kê tần suất tổng (hồi quy)', weight: 0.7 };
}

// 5) Trung bình động tổng điểm xúc xắc (moving average of "point")
function algoMovingAverage(chronoSessions) {
  const N = 10;
  if (chronoSessions.length < N) return null;
  const lastN = chronoSessions.slice(-N);
  const avg = lastN.reduce((s, x) => s + x.point, 0) / N;
  const deviation = avg - 10.5; // 10.5 là trung tâm lý thuyết của tổng 3 xúc xắc (3-18)
  if (Math.abs(deviation) < 0.4) return null;
  const predict = deviation > 0 ? 'TAI' : 'XIU';
  const confidence = Math.min(75, Math.round(50 + Math.abs(deviation) * 8));
  return {
    predict,
    confidence,
    label: `Trung bình tổng xúc xắc ${avg.toFixed(1)} điểm`,
    weight: 0.9,
  };
}

// ---------------------------------------------------------------------------
// ENSEMBLE: TỔNG HỢP TẤT CẢ THUẬT TOÁN THÀNH 1 DỰ ĐOÁN CUỐI CÙNG
// ---------------------------------------------------------------------------
function generatePrediction() {
  if (sessions.length < 3) {
    // chưa đủ dữ liệu, dự đoán mặc định trung lập nhẹ dựa theo phiên gần nhất
    const last = sessions[sessions.length - 1];
    const predict = last ? opposite(last.ket_qua) : 'TAI';
    return {
      predict,
      confidence: 50,
      label: 'Khởi tạo (chưa đủ dữ liệu lịch sử)',
    };
  }

  const chronoResults = sessions.map((s) => s.ket_qua); // cũ -> mới
  const results = [...chronoResults].reverse(); // mới -> cũ (results[0] = gần nhất)

  const subPredictions = [
    algoStreak(results),
    algoAlternating(results),
    algoMarkov(chronoResults, results, 3, 4),
    algoMarkov(chronoResults, results, 2, 6),
    algoMarkov(chronoResults, results, 1, 8),
    algoFrequency(chronoResults),
    algoMovingAverage(sessions),
  ].filter(Boolean);

  if (subPredictions.length === 0) {
    const last = sessions[sessions.length - 1];
    return {
      predict: opposite(last.ket_qua),
      confidence: 50,
      label: 'Không đủ tín hiệu rõ ràng (mặc định bẻ cầu nhẹ)',
    };
  }

  // Bỏ phiếu có trọng số
  let score = 0; // >0 nghiêng TAI, <0 nghiêng XIU
  let totalWeight = 0;
  let dominant = subPredictions[0];
  let dominantContribution = 0;

  for (const sp of subPredictions) {
    const direction = sp.predict === 'TAI' ? 1 : -1;
    const contribution = sp.weight * (sp.confidence / 100);
    score += direction * contribution;
    totalWeight += sp.weight;

    if (contribution > dominantContribution) {
      dominantContribution = contribution;
      dominant = sp;
    }
  }

  const finalPredict = score >= 0 ? 'TAI' : 'XIU';
  const normalized = totalWeight > 0 ? Math.abs(score) / totalWeight : 0;
  const finalConfidence = Math.max(50, Math.min(96, Math.round(50 + normalized * 90)));

  // Kiểm tra đồng thuận: nếu nhiều thuật toán cùng hướng thì gắn nhãn tổng hợp
  const agreeCount = subPredictions.filter((sp) => sp.predict === finalPredict).length;
  let loaiCau;
  if (agreeCount >= 3) {
    loaiCau = `Tổng hợp đa thuật toán (${agreeCount}/${subPredictions.length} đồng thuận: ${subPredictions
      .map((s) => s.label)
      .join(' | ')})`;
  } else {
    loaiCau = dominant.label;
  }

  return { predict: finalPredict, confidence: finalConfidence, label: loaiCau };
}

// ---------------------------------------------------------------------------
// VÒNG LẶP CẬP NHẬT PHIÊN THẬT + CHỐT KẾT QUẢ DỰ ĐOÁN + TẠO DỰ ĐOÁN MỚI
// ---------------------------------------------------------------------------
let isPolling = false;
let lastError = null;
let lastSyncedAt = null;

async function pollAndProcess() {
  if (isPolling) return;
  isPolling = true;
  try {
    const latest = await fetchSourceSessions(); // cũ -> mới
    lastError = null;
    lastSyncedAt = new Date().toISOString();

    const knownIds = new Set(sessions.map((s) => s.id));
    const newOnes = latest.filter((s) => !knownIds.has(s.id));

    if (newOnes.length > 0) {
      // thêm vào lịch sử, giữ sắp xếp tăng dần theo id, không giới hạn số lượng lưu trữ
      sessions.push(...newOnes);
      sessions.sort((a, b) => a.id - b.id);

      // với từng phiên mới xuất hiện, kiểm tra xem có khớp với pendingPrediction không
      for (const newSession of newOnes) {
        if (pendingPrediction && pendingPrediction.phien === newSession.id) {
          const isCorrect = pendingPrediction.du_doan === newSession.ket_qua;
          if (isCorrect) stats.dung += 1;
          else stats.sai += 1;

          predictions.push({
            phien: newSession.id,
            du_doan: pendingPrediction.du_doan,
            ket_qua_thuc: newSession.ket_qua,
            dices: newSession.dices,
            point: newSession.point,
            do_tin_cay: pendingPrediction.do_tin_cay,
            loai_cau: pendingPrediction.loai_cau,
            dung_sai: isCorrect ? 'Dung' : 'Sai',
            created_at: pendingPrediction.created_at,
            resolved_at: new Date().toISOString(),
          });

          pendingPrediction = null;
        }
      }

      // sinh dự đoán mới cho phiên kế tiếp (dựa trên phiên mới nhất vừa cập nhật)
      const nextPhien = sessions[sessions.length - 1].id + 1;
      // chỉ tạo dự đoán mới nếu chưa có pending cho đúng phiên này
      if (!pendingPrediction || pendingPrediction.phien !== nextPhien) {
        const result = generatePrediction();
        pendingPrediction = {
          phien: nextPhien,
          du_doan: result.predict,
          do_tin_cay: result.confidence,
          loai_cau: result.label,
          created_at: new Date().toISOString(),
        };
      }

      persistAll();
      console.log(
        `[${new Date().toLocaleTimeString('vi-VN')}] Cập nhật ${newOnes.length} phiên mới. Tổng lịch sử: ${sessions.length} phiên. Dự đoán kế tiếp: Phiên ${pendingPrediction.phien} -> ${toVN(pendingPrediction.du_doan)} (${pendingPrediction.do_tin_cay}%)`
      );
    } else if (!pendingPrediction && sessions.length > 0) {
      // trường hợp chưa có pending (ví dụ mới khởi động) -> tạo luôn
      const nextPhien = sessions[sessions.length - 1].id + 1;
      const result = generatePrediction();
      pendingPrediction = {
        phien: nextPhien,
        du_doan: result.predict,
        do_tin_cay: result.confidence,
        loai_cau: result.label,
        created_at: new Date().toISOString(),
      };
      persistAll();
    }
  } catch (err) {
    lastError = err.message;
    console.error('Lỗi khi lấy dữ liệu từ API gốc:', err.message);
  } finally {
    isPolling = false;
  }
}

// ---------------------------------------------------------------------------
// EXPRESS SERVER
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// CORS đơn giản để front-end khác có thể gọi được
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function buildFormattedText() {
  const lastSession = sessions[sessions.length - 1];
  if (!lastSession || !pendingPrediction) {
    return 'Chưa có đủ dữ liệu phiên, vui lòng thử lại sau vài giây...';
  }
  const xucXac = Array.isArray(lastSession.dices) ? lastSession.dices.join('-') : '';
  return [
    `Id: ${BOT_ID}`,
    `Phien: ${lastSession.id}`,
    `Ket_qua: ${toVN(lastSession.ket_qua)}`,
    `Xuc_xac: ${xucXac}`,
    `Du_doan: ${toVN(pendingPrediction.du_doan)}`,
    `Do_tin_cay: ${pendingPrediction.do_tin_cay}%`,
    `Loai_cau: ${pendingPrediction.loai_cau}`,
    `Thong_ke_dung_sai: Dung: ${stats.dung} Sai:${stats.sai}`,
  ].join('\n');
}

function buildResponsePayload() {
  const lastSession = sessions[sessions.length - 1];
  if (!lastSession || !pendingPrediction) {
    return {
      Id: BOT_ID,
      message: 'Đang đồng bộ dữ liệu từ API gốc, vui lòng thử lại sau vài giây...',
    };
  }
  return {
    Id: BOT_ID,
    Phien: lastSession.id,
    Ket_qua: toVN(lastSession.ket_qua),
    Xuc_xac: Array.isArray(lastSession.dices) ? lastSession.dices.join('-') : '',
    Du_doan: toVN(pendingPrediction.du_doan),
    Do_tin_cay: `${pendingPrediction.do_tin_cay}%`,
    Loai_cau: pendingPrediction.loai_cau,
    Thong_ke_dung_sai: `Dung: ${stats.dung} Sai:${stats.sai}`,
    Phien_du_doan_ke_tiep: pendingPrediction.phien,
  };
}

// ---- ROUTES ----

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Tai Xiu Predictor',
    bot_id: BOT_ID,
    last_sync: lastSyncedAt,
    last_error: lastError,
    total_sessions_luu: sessions.length,
    total_predictions_da_cham: predictions.length,
    endpoints: {
      du_doan_json: '/api/predict',
      du_doan_text: '/api/predict/text',
      lich_su: '/api/history?limit=50',
      thong_ke: '/api/stats',
      phien_goc: '/api/sessions?limit=50',
    },
  });
});

app.get('/api/predict', (req, res) => {
  res.json(buildResponsePayload());
});

app.get('/api/predict/text', (req, res) => {
  res.type('text/plain').send(buildFormattedText());
});

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const data = predictions.slice(-limit).reverse();
  res.json({ total: predictions.length, data });
});

app.get('/api/stats', (req, res) => {
  const total = stats.dung + stats.sai;
  const tyLe = total > 0 ? ((stats.dung / total) * 100).toFixed(2) : '0.00';
  res.json({ Dung: stats.dung, Sai: stats.sai, Tong: total, Ty_le_dung: `${tyLe}%` });
});

app.get('/api/sessions', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const data = sessions.slice(-limit).reverse();
  res.json({ total: sessions.length, data });
});

// ---------------------------------------------------------------------------
// KHỞI ĐỘNG SERVER + VÒNG LẶP POLLING
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Tai Xiu Predictor đang chạy tại cổng ${PORT}`);
  console.log(`📡 Nguồn dữ liệu: ${SOURCE_API_URL}`);
  console.log(`⏱️  Chu kỳ polling: ${POLL_INTERVAL_MS}ms`);
  // gọi ngay lần đầu, sau đó lặp định kỳ
  pollAndProcess();
  setInterval(pollAndProcess, POLL_INTERVAL_MS);
});
