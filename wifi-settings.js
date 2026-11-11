"use strict";

if (location.protocol === "http:" && location.hostname === "127.0.0.1") {
  const panel = document.getElementById("wifi-settings");
  const form = document.getElementById("wifi-config-form");
  const password = document.getElementById("wifi-password");
  const networkSelect = document.getElementById("wifi-network-select");
  const refreshNetworks = document.getElementById("wifi-networks-refresh");
  const status = document.getElementById("wifi-settings-status");
  const button = document.getElementById("wifi-config-save");
  const storageKey = "spresense.wifi-ssids.v1";
  const lastSsidKey = "spresense.wifi-last-ssid.v1";
  panel.hidden = false;

  function savedNetworks(current) {
    let choices = current ? [current] : [];
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(saved)) choices = [...new Set([...choices, ...saved.filter(name => typeof name === "string")])];
      choices = choices.slice(0, 12);
      localStorage.setItem(storageKey, JSON.stringify(choices));
    } catch {
      // The currently configured SSID remains available without browser storage.
    }
    return choices;
  }

  function showNetworks(visible, current) {
    const choices = [...new Set([...visible, ...savedNetworks(current)])];
    networkSelect.replaceChildren(
      new Option("Wi-Fiを選択してください", ""),
      ...choices.map((name) => new Option(name, name)),
    );
    networkSelect.value = choices.includes(current) ? current : "";
  }

  async function scanNetworks(current = networkSelect.value) {
    refreshNetworks.disabled = true;
    networkSelect.disabled = true;
    networkSelect.replaceChildren(new Option("周囲のWi-Fiを検索しています…", ""));
    try {
      const response = await fetch("/api/wifi-networks", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      showNetworks(Array.isArray(data.networks) ? data.networks : [], current);
      if (!data.networks?.length) status.textContent = "周囲のWi-Fiが見つかりません。SSIDは手入力できます。";
    } catch {
      showNetworks([], current);
      status.textContent = "Wi-Fi一覧を取得できません。SSIDは手入力できます。";
    } finally {
      refreshNetworks.disabled = false;
      networkSelect.disabled = false;
    }
  }

  function showSettings(settings) {
    const lastSsid = localStorage.getItem(lastSsidKey) || settings.ssid;
    form.hidden = false;
    scanNetworks(lastSsid);
  }

  async function loadSettings() {
    try {
      const response = await fetch("/api/wifi-settings", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const settings = await response.json();
      showSettings(settings);
      form.dataset.receiver = settings.receiver;
      form.dataset.port = settings.port;
      status.textContent = `設定時はSpresenseをUSB接続します。送信先: ${settings.receiver}:${settings.port}`;
    } catch {
      status.textContent = "設定を読み込めません。PCの受信プログラムを確認してください。";
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      if (!networkSelect.value) throw new Error("接続するWi-Fiを一覧から選択してください。");
      if (!password.value) throw new Error("Wi-Fiパスワードを入力してください。");
      status.textContent = "COMポートを選択し、基板への保存と接続確認を待っています…";
      const result = await window.configureSpresenseWifi({
        ssid: networkSelect.value,
        password: password.value,
        receiver: form.dataset.receiver,
        port: Number(form.dataset.port),
      });
      savedNetworks(networkSelect.value);
      localStorage.setItem(lastSsidKey, networkSelect.value);
      password.value = "";
      status.textContent = result.connected
        ? "基板に保存し、新しいWi-Fiへ接続しました。「Wi-Fiで受信」を押してください。"
        : "基板に保存しましたが、Wi-Fi接続を確認できません。SSID、パスワード、2.4GHz接続を確認してください。";
    } catch (error) {
      status.textContent = error.message || "Wi-Fi設定を保存できませんでした。";
    } finally {
      button.disabled = false;
    }
  });

  refreshNetworks.addEventListener("click", () => scanNetworks());

  loadSettings();
}
