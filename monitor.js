"use strict";

const el = (id) => document.getElementById(id);
const connectButton = el("connect");
const wifiButton = el("connect-wifi");
const disconnectButton = el("disconnect");
const recordButton = el("record");
const saveButton = el("save");
const status = el("status");
const activity = el("activity");
const recordStatus = el("record-status");
const estimate = el("estimate");
const estimateValue = el("estimate-value");
const estimateDetail = el("estimate-detail");
const calibrateButton = el("calibrate");
const postureStatus = el("posture-status");
const charts = [
  { canvas: el("accel"), values: el("accel-values"), offset: 0, minRange: 12 },
  { canvas: el("gyro"), values: el("gyro-values"), offset: 3, minRange: 10 },
];
const axes = ["X", "Y", "Z"];
const colors = ["#0066cc", "#a45400", "#7d46bf"];
const windowMs = 10_000;
const sampleLine = /^IMU_x:([^,]+),IMU_y:([^,]+),IMU_z:([^,]+),IMU_gx:([^,]+),IMU_gy:([^,]+),IMU_gz:([^,]+)$/;

let connection;
let history = [];
let latest;
let recording = false;
let recordStart;
let rows = [];
let nextInference = 0;
let upright;
let lastScore = null;
const hasSerial = "serial" in navigator;
const hasLocalReceiver = location.protocol === "http:" && location.hostname === "127.0.0.1";

window.getMonitorContext = () => ({
  transport: connection?.kind ?? "not_connected",
  activity: activity.value,
});

async function configureSpresenseWifi({ ssid, password, receiver, port: receiverPort }) {
  if (!hasSerial) throw new Error("ChromeまたはEdgeで開いてください。");
  if (connection) throw new Error("先に現在のUSB/Wi-Fi接続を切断してください。");
  const port = await navigator.serial.requestPort();
  let reader;
  let writer;
  let saved = false;
  try {
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    const command = ["WIFICFG", encodeURIComponent(ssid), encodeURIComponent(password), receiver, receiverPort].join("\t") + "\n";
    await writer.write(new TextEncoder().encode(command));
    writer.releaseLock();
    writer = undefined;

    reader = port.readable.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("基板からの応答がタイムアウトしました。")), remaining)),
      ]);
      if (result.done) break;
      const lines = (pending + decoder.decode(result.value, { stream: true })).split("\n");
      pending = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (line === "WIFI_CFG_SAVED") saved = true;
        if (line === "WIFI_CFG_CONNECTED") return { connected: true };
        if (line === "WIFI_CFG_CONNECT_FAILED") return { connected: false };
        if (line.startsWith("WIFI_CFG_ERROR:")) throw new Error("基板が設定を受け付けませんでした。");
      }
    }
    if (saved) return { connected: false };
    throw new Error("基板から設定保存の応答がありませんでした。");
  } finally {
    writer?.releaseLock();
    if (reader) {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
    try { await port.close(); } catch {}
  }
}

window.configureSpresenseWifi = configureSpresenseWifi;

function acceptLine(line) {
  const match = sampleLine.exec(line.trim());
  if (!match) return;

  const fields = match.slice(1);
  const values = fields.map(Number);
  if (fields.some((field) => !field.trim()) || !values.every(Number.isFinite)) return;

  acceptSample(values, performance.now());
}

function acceptSample(values, time) {
  latest = { time, values };
  history.push(latest);
  if (recording && time >= recordStart) {
    const elapsedMs = (latest.time - recordStart).toFixed(1);
    const receivedAt = new Date(Date.now() - (performance.now() - time)).toISOString();
    rows.push([receivedAt, elapsedMs, activity.value, ...values].join(","));
  }
}

function scoreNewSamples() {
  if (latest.time < nextInference) return;
  nextInference = latest.time + 250;
  lastScore = fallScore(history);
  const threshold = Number(sensitivity.value);
  const postureFall = lastScore !== null && lastScore < threshold &&
    fallWithPostureChange(history, lastScore, threshold);
  observeFallScore(lastScore, postureFall, latest.time);
}

async function readSamples(session) {
  const decoder = new TextDecoder();
  let pending = "";
  while (!session.stopping) {
    const { value, done } = await session.reader.read();
    if (done) break;

    const lines = (pending + decoder.decode(value, { stream: true })).split("\n");
    pending = lines.pop();
    if (pending.length > 256) pending = "";
    for (const line of lines) acceptLine(line);
  }
}

function stopRecording() {
  recording = false;
  recordButton.textContent = "記録開始";
  saveButton.disabled = rows.length === 0;
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  wifiButton.disabled = true;
  status.textContent = "ポートを選択してください";
  let session;
  let message = "切断しました";
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    session = { port, reader: null, stopping: false, kind: "USB" };
    connection = session;
    history = [];
    latest = undefined;
    upright = undefined;
    nextInference = 0;
    lastScore = null;
    resetFallScores();
    session.reader = port.readable.getReader();
    disconnectButton.disabled = false;
    status.textContent = "接続済み · 受信待ち";
    await readSamples(session);
    if (!session.stopping) message = "USB接続が切れました";
  } catch (error) {
    if (session?.stopping) {
      message = "切断しました";
    } else if (error.name === "NotFoundError") {
      message = "ポート選択をキャンセルしました";
    } else {
      message = "接続または受信に失敗しました。USBとCOMポートの使用状況を確認してください";
    }
  } finally {
    if (session) {
      session.reader?.releaseLock();
      try {
        await session.port.close();
      } catch (error) {
        console.warn("Serial port close:", error);
      }
    }
    finishConnection(message);
  }
});

function finishConnection(message) {
  connection = undefined;
  connectButton.disabled = !hasSerial;
  wifiButton.disabled = !hasLocalReceiver;
  disconnectButton.disabled = true;
  recordButton.disabled = true;
  stopRecording();
  status.textContent = message;
}

wifiButton.addEventListener("click", async () => {
  if (location.protocol === "file:") {
    location.href = "http://127.0.0.1:8766/";
    return;
  }

  const controller = new AbortController();
  const session = { controller, stopping: false, kind: "Wi-Fi", startedAt: performance.now() };
  connection = session;
  connectButton.disabled = true;
  wifiButton.disabled = true;
  disconnectButton.disabled = false;
  history = [];
  latest = undefined;
  upright = undefined;
  resetFallScores();
  status.textContent = "Wi-Fi · センサーの送信待ち";
  let cursor = 0;
  let stream = "";
  let message = "切断しました";
  try {
    while (!session.stopping) {
      const response = await fetch(`/api/samples?after=${cursor}&stream=${stream}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Wi-Fi receiver unavailable");
      const batch = await response.json();
      if (session.stopping) break;
      if (stream !== batch.stream) {
        stream = batch.stream;
        cursor = 0;
        history = [];
        latest = undefined;
        upright = undefined;
        nextInference = 0;
        lastScore = null;
        resetFallScores();
        status.textContent = "Wi-Fi · センサーの送信待ち";
      }
      const last = batch.rows.at(-1);
      if (last) {
        const newest = performance.now() - batch.ageMs;
        for (const [sequence, deviceTime, values] of batch.rows) {
          const time = newest - (last[1] - deviceTime);
          acceptSample(values, Math.max(time, latest?.time ?? time));
          if (latest.time >= session.startedAt) scoreNewSamples();
          cursor = sequence;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (!session.stopping) message = "PCのWi-Fi受信を開始してから再接続してください";
  } finally {
    finishConnection(message);
  }
});

disconnectButton.addEventListener("click", async () => {
  const session = connection;
  if (!session) return;
  session.stopping = true;
  disconnectButton.disabled = true;
  recordButton.disabled = true;
  stopRecording();
  if (session.controller) {
    session.controller.abort();
    return;
  }
  try {
    await session.reader.cancel();
  } catch (error) {
    console.warn("Serial read cancel:", error);
  }
});

recordButton.addEventListener("click", () => {
  if (recording) {
    stopRecording();
    return;
  }
  if (rows.length && !window.confirm("新しい記録を始めると、画面上の前の記録が消えます。開始しますか？")) return;
  rows = [];
  recordStart = performance.now();
  recording = true;
  recordButton.textContent = "記録停止";
  saveButton.disabled = true;
});

saveButton.addEventListener("click", () => {
  const header = "received_at_utc,elapsed_ms,activity,ax_m_s2,ay_m_s2,az_m_s2,gx_deg_s,gy_deg_s,gz_deg_s\r\n";
  const url = URL.createObjectURL(new Blob([header, rows.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `imu-${new Date().toISOString().replaceAll(":", "-")}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function drawChart({ canvas, values, offset, minRange }, now) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }

  const context = canvas.getContext("2d");
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  const left = 48;
  const plotWidth = width - left - 9;
  const plotHeight = height - 34;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  let range = minRange;
  for (const sample of history) {
    range = Math.max(range, ...sample.values.slice(offset, offset + 3).map(Math.abs));
  }
  const step = Math.ceil(range / 4);
  range = step * 4;
  const y = (value) => 10 + (range - value) * plotHeight / (2 * range);
  const x = (time) => left + (time - now + windowMs) * plotWidth / windowMs;
  context.font = "11px monospace";
  context.fillStyle = "#66666e";
  context.strokeStyle = "#e6e6ec";
  context.lineWidth = 1;

  for (let i = -2; i <= 2; i++) {
    const label = i * step * 2;
    const lineY = y(label);
    context.beginPath();
    context.moveTo(left, lineY);
    context.lineTo(left + plotWidth, lineY);
    context.stroke();
    context.textAlign = "right";
    context.fillText(label, left - 6, lineY + 4);
  }
  for (let seconds = -10; seconds <= 0; seconds += 2) {
    context.textAlign = seconds === 0 ? "right" : "center";
    context.fillText(`${seconds}s`, x(now + seconds * 1000), height - 5);
  }
  for (let axis = 0; axis < axes.length; axis++) {
    context.beginPath();
    context.strokeStyle = colors[axis];
    context.lineWidth = 1.5;
    for (const [index, sample] of history.entries()) {
      const sampleX = x(sample.time);
      const sampleY = y(sample.values[offset + axis]);
      if (index === 0) context.moveTo(sampleX, sampleY);
      else context.lineTo(sampleX, sampleY);
    }
    context.stroke();
  }
  values.textContent = axes.map((axis, i) => `${axis} ${latest ? latest.values[offset + i].toFixed(2) : "—"}`).join("　");
}

function showEstimate(state, value, detail) {
  if (estimate.dataset.state === state && estimateValue.textContent === value &&
      estimateDetail.textContent === detail) return;
  estimate.dataset.state = state;
  estimateValue.textContent = value;
  estimateDetail.textContent = detail;
}

function updateEstimate(now) {
  if (connection && !connection.stopping && latest &&
      now - latest.time <= freshnessLimit() && connection.kind !== "Wi-Fi") {
    scoreNewSamples();
  }
  const event = pendingFall();
  if (event) {
    showEstimate("fall", "転倒の可能性があります", `${displayFallTime(event.detectedAt)} に検知。判断理由を確認し、次の行動を選んでください。`);
    return;
  }
  if (!connection || connection.stopping) {
    showEstimate("waiting", "接続を待っています", "腰に装着したセンサーの直近2秒から、転倒の兆候を推定します。");
    return;
  }
  if (!latest || now - latest.time > freshnessLimit()) {
    showEstimate("waiting", "データを待っています", `${connection.kind}からのデータ受信を確認しています。`);
    return;
  }
  if (lastScore === null) {
    showEstimate("waiting", "推定の準備中", "連続したセンサーデータが約2秒分そろうと推定を始めます。");
    return;
  }
  showEstimate("regular", "転倒の兆候は見られません", "直近2秒のセンサーデータをブラウザで推定しています。");
}

function freshnessLimit() {
  return connection?.kind === "Wi-Fi" ? 1500 : 500;
}

function stationaryGravity() {
  if (!latest) return null;
  const start = latest.time - 1000;
  const first = history.findIndex(({ time }) => time >= start);
  if (first < 0 || history[first].time - start > 50) return null;
  const samples = history.slice(first);
  if (samples.length < 40 || samples.some(({ time, values }, i) =>
    Math.hypot(...values.slice(3)) > 15 || (i > 0 && time - samples[i - 1].time > 250))) return null;
  const direction = [0, 1, 2].map((axis) => mean(samples.map(({ values }) => values[axis])));
  const magnitude = Math.hypot(...direction);
  if (Math.abs(magnitude - gravity) > 1.5) return null;
  return direction.map((axis) => axis / magnitude);
}

calibrateButton.addEventListener("click", () => {
  const reference = stationaryGravity();
  if (reference) upright = reference;
});

function updatePosture(receiving) {
  const direction = receiving ? stationaryGravity() : null;
  calibrateButton.disabled = !direction;
  if (upright && !receiving) {
    postureStatus.textContent = "受信再開を待っています";
  } else if (!upright) {
    postureStatus.textContent = receiving ? "直立して約1秒静止すると、基準を設定できます" : "基準姿勢は未設定";
  } else if (direction) {
    const dot = direction.reduce((sum, axis, i) => sum + axis * upright[i], 0);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    postureStatus.textContent = `基準からの傾き 約 ${Math.round(angle)}°`;
  } else {
    postureStatus.textContent = "静止すると基準からの傾きを表示します";
  }
}

function refresh() {
  const now = performance.now();
  const firstVisible = history.findIndex((sample) => sample.time >= now - windowMs);
  history = firstVisible < 0 ? [] : history.slice(firstVisible);
  updateEstimate(now);
  for (const chart of charts) drawChart(chart, now);
  recordStatus.textContent = recording ? `記録中 · ${rows.length}行` : (rows.length ? `${rows.length}行` : "記録なし");
  const receiving = Boolean(connection && !connection.stopping && latest && now - latest.time < freshnessLimit());
  updatePosture(receiving);
  status.dataset.live = receiving;
  if (!connection || connection.stopping || !latest) return;

  const transport = connection.kind === "USB" ? "115200 baud" : "Wi-Fi";
  const message = receiving ? `受信中 · ${transport}` : "受信が止まっています";
  if (status.textContent !== message) status.textContent = message;
  recordButton.disabled = !receiving && !recording;
}

if (!hasSerial) {
  connectButton.disabled = true;
  connectButton.hidden = true;
  el("usb-hint").hidden = true;
}
if (!hasLocalReceiver) {
  wifiButton.hidden = true;
  el("usb-hint").textContent = hasSerial
    ? "公開版はUSB接続で利用できます。CP210xを選び、Arduino IDEのシリアルモニターを閉じてください。データとDecision Logはこのブラウザ内に保存されます。"
    : "USB接続にはChromeまたはEdgeを使用してください。Decision Logはこのブラウザ内に保存されます。";
  document.querySelector(".local").textContent = "公開WEBアプリ";
}
refresh();
setInterval(refresh, 100);
