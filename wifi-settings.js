"use strict";

if (location.protocol === "http:" && location.hostname === "127.0.0.1") {
  const panel = document.getElementById("wifi-settings");
  const form = document.getElementById("wifi-config-form");
  const ssid = document.getElementById("wifi-ssid");
  const password = document.getElementById("wifi-password");
  const networks = document.getElementById("wifi-known-networks");
  const status = document.getElementById("wifi-settings-status");
  const button = document.getElementById("wifi-config-save");
  const storageKey = "spresense.wifi-ssids.v1";
  const lastSsidKey = "spresense.wifi-last-ssid.v1";
  panel.hidden = false;

  function updateNetworks(current) {
    let choices = current ? [current] : [];
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(saved)) choices = [...new Set([...choices, ...saved.filter(name => typeof name === "string")])];
      choices = choices.slice(0, 12);
      localStorage.setItem(storageKey, JSON.stringify(choices));
    } catch {
      // The currently configured SSID remains available without browser storage.
    }
    networks.replaceChildren(...choices.map((name) => new Option(name, name)));
  }

  function showSettings(settings) {
    const lastSsid = localStorage.getItem(lastSsidKey) || settings.ssid;
    ssid.value = lastSsid;
    updateNetworks(lastSsid);
    form.hidden = false;
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
      if (!password.value) throw new Error("Wi-Fiパスワードを入力してください。");
      status.textContent = "COMポートを選択し、基板への保存と接続確認を待っています…";
      const result = await window.configureSpresenseWifi({
        ssid: ssid.value,
        password: password.value,
        receiver: form.dataset.receiver,
        port: Number(form.dataset.port),
      });
      updateNetworks(ssid.value);
      localStorage.setItem(lastSsidKey, ssid.value);
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

  loadSettings();
}
