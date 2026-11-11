"use strict";

const alertStorageKey = "spresense.fall-history.v2";
const legacyAlertStorageKey = "spresense.fall-history.v1";
const sensitivity = document.getElementById("sensitivity");
const scorePeak = document.getElementById("score-peak");
const acknowledgeButton = document.getElementById("acknowledge-fall");
const decisionPanel = document.getElementById("decision-panel");
const proposalContainer = document.getElementById("action-proposals");
const decisionCompletion = document.getElementById("decision-completion");
const decisionOutcome = document.getElementById("decision-outcome");
const decisionStatus = document.getElementById("decision-status");
const historyList = document.getElementById("fall-history");
const exportAlerts = document.getElementById("export-falls");
const storageStatus = document.getElementById("fall-storage-status");
const localTime = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short", timeStyle: "medium",
});

let fallEvents = [];
let aboveThreshold = false;
let quietSince = null;
let peakScore = null;

const actionProposals = [
  {
    id: "voice_check",
    label: "本人へ声掛け",
    reason: "まず低負担な確認を行い、返答・痛み・動けるかを確かめます。",
  },
  {
    id: "nearby_check",
    label: "周囲へ確認依頼",
    reason: "本人へ直接確認できない、または応答が不明なとき、近くの人に状況確認を依頼します。",
  },
  {
    id: "emergency_contact",
    label: "救援連絡",
    reason: "意識がない、けがや危険が疑われる、動けない場合に救援を要請します。",
  },
];

const outcomeLabels = {
  safe: "異常なし",
  assisted: "声掛け・介助で対応",
  nearby_support: "周囲の人が対応",
  rescue_requested: "救援連絡を実施",
  unknown: "未確認のまま終了",
};

function newEventId() {
  return crypto.randomUUID?.() ?? `fall-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFallHistory() {
  try {
    const current = localStorage.getItem(alertStorageKey);
    const isLegacyMigration = current === null;
    const data = JSON.parse(current ?? localStorage.getItem(legacyAlertStorageKey) ?? "[]");
    if (!Array.isArray(data)) throw new Error("Invalid fall history");
    // Old trial alerts predate the Level 1 decision flow. Keep completed logs,
    // but do not reopen an unfinished trial every time the app starts.
    const migrated = isLegacyMigration ? data.filter((event) => event.confirmedAt) : data;
    fallEvents = migrated.map((event) => ({
      eventId: event.eventId ?? newEventId(),
      recognizedState: event.recognizedState ?? "fall_candidate",
      proposals: event.proposals ?? actionProposals,
      ...event,
    }));
    if (isLegacyMigration) saveFallHistory();
  } catch {
    storageStatus.textContent = "ブラウザの履歴を読み込めません。";
  }
}

function saveFallHistory() {
  try {
    localStorage.setItem(alertStorageKey, JSON.stringify(fallEvents));
    storageStatus.textContent = "履歴はこのブラウザに保存されます。";
  } catch {
    storageStatus.textContent = "ブラウザに履歴を保存できません。ページを閉じる前にCSVを保存してください。";
  }
}

function pendingFall() {
  return fallEvents.findLast((event) => event.confirmedAt === null);
}

function displayFallTime(timestamp) {
  return localTime.format(new Date(timestamp));
}

function renderFallHistory() {
  const pending = pendingFall();
  decisionPanel.hidden = !pending;
  decisionCompletion.hidden = !pending?.selectedAction;
  proposalContainer.replaceChildren();
  if (pending) {
    for (const proposal of actionProposals) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "proposal";
      button.dataset.action = proposal.id;
      button.setAttribute("aria-pressed", String(pending.selectedAction === proposal.id));
      const label = document.createElement("strong");
      label.textContent = proposal.label;
      const reason = document.createElement("span");
      reason.textContent = proposal.reason;
      button.append(label, reason);
      proposalContainer.append(button);
    }
    const selected = actionProposals.find(({ id }) => id === pending.selectedAction);
    decisionStatus.textContent = selected
      ? `「${selected.label}」を選択しました。確認結果を記録してください。`
      : "行動を選ぶまでは、救援連絡などを自動実行しません。";
  }
  exportAlerts.disabled = fallEvents.length === 0;
  historyList.replaceChildren();
  if (!fallEvents.length) {
    const empty = document.createElement("li");
    empty.textContent = "検知履歴はまだありません。";
    historyList.append(empty);
    return;
  }
  for (const event of fallEvents) {
    const row = document.createElement("li");
    const detection = document.createElement("strong");
    detection.textContent = `${displayFallTime(event.detectedAt)} に検知`;
    const confirmation = document.createElement("span");
    const selected = actionProposals.find(({ id }) => id === event.selectedAction);
    confirmation.textContent = event.confirmedAt
      ? `${selected?.label ?? "従来の確認"} → ${outcomeLabels[event.outcome] ?? "確認完了"}`
      : event.decidedAt ? `${selected?.label ?? "行動選択済み"} · 結果待ち` : "行動選択待ち";
    row.append(detection, confirmation);
    historyList.append(row);
  }
}

function observeFallScore(score, postureFall, sampleTime) {
  if (score === null) return;
  peakScore = Math.max(peakScore ?? score, score);
  scorePeak.textContent = `接続中の最高スコア ${peakScore.toFixed(2)}`;
  const threshold = Number(sensitivity.value);
  if (score < threshold && !postureFall) {
    quietSince ??= sampleTime;
    if (sampleTime - quietSince >= 1000) aboveThreshold = false;
    return;
  }
  quietSince = null;
  if (!aboveThreshold) {
    fallEvents.unshift({
      eventId: newEventId(), detectedAt: new Date().toISOString(), confirmedAt: null, score, threshold,
      trigger: postureFall ? "motion_posture" : "model",
      recognizedState: "fall_candidate",
      context: window.getMonitorContext?.() ?? {},
      proposals: actionProposals,
      uncertainty: "センサー推定のため、本人の意識・けが・周辺状況は未確認",
    });
    saveFallHistory();
    renderFallHistory();
  }
  aboveThreshold = true;
}

function resetFallScores() {
  aboveThreshold = false;
  quietSince = null;
  peakScore = null;
  scorePeak.textContent = "接続中の最高スコア —";
}

proposalContainer.addEventListener("click", (clickEvent) => {
  const button = clickEvent.target.closest("button[data-action]");
  const event = pendingFall();
  if (!button || !event) return;
  const proposal = actionProposals.find(({ id }) => id === button.dataset.action);
  event.selectedAction = proposal.id;
  event.selectedActionLabel = proposal.label;
  event.selectedRationale = proposal.reason;
  event.decidedAt = new Date().toISOString();
  saveFallHistory();
  renderFallHistory();
});

acknowledgeButton.addEventListener("click", () => {
  const event = pendingFall();
  if (!event?.selectedAction) return;
  event.outcome = decisionOutcome.value;
  event.confirmedAt = new Date().toISOString();
  saveFallHistory();
  renderFallHistory();
});

exportAlerts.addEventListener("click", () => {
  const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = "event_id,detected_at_utc,recognized_state,score,threshold,trigger,context,proposals,uncertainty,selected_action,selected_rationale,decided_at_utc,outcome,completed_at_utc";
  const rows = fallEvents.map((event) => [
    event.eventId, event.detectedAt, event.recognizedState, event.score, event.threshold,
    event.trigger ?? "model", JSON.stringify(event.context ?? {}),
    (event.proposals ?? actionProposals).map(({ label }) => label).join(" / "), event.uncertainty,
    event.selectedActionLabel, event.selectedRationale, event.decidedAt,
    outcomeLabels[event.outcome] ?? event.outcome, event.confirmedAt,
  ].map(csv).join(","));
  const url = URL.createObjectURL(new Blob([[header, ...rows].join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "decision-log.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

window.addEventListener("storage", (event) => {
  if (event.key !== alertStorageKey) return;
  readFallHistory();
  renderFallHistory();
});

readFallHistory();
renderFallHistory();
