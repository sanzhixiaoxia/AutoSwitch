import * as qoder from "./qoder.mjs";
import * as trae from "./trae.mjs";
import * as workbuddy from "./workbuddy.mjs";
import { detectQoder, detectTrae, detectWorkBuddy } from "../win/paths.mjs";

export const PROVIDERS = [
  { id: "trae", label: "Trae CN", short: "Trae", color: "#2f6fed", order: 0 },
  { id: "workbuddy", label: "WorkBuddy", short: "WorkBuddy", color: "#0d9488", order: 1 },
  { id: "qoder-cn", label: "Qoder 国内版", short: "Qoder CN", color: "#0f9d76", order: 2 },
  { id: "qoder", label: "Qoder 国际版", short: "Qoder", color: "#7c5cff", order: 3 },
];

export const PROVIDER_IDS = PROVIDERS.map((item) => item.id);
export const providerMeta = (provider) => PROVIDERS.find((item) => item.id === provider) || null;

const adapters = {
  qoder,
  "qoder-cn": qoder,
  trae,
  workbuddy,
};

export function adapterFor(accountOrProvider) {
  const provider = typeof accountOrProvider === "string" ? accountOrProvider : accountOrProvider?.provider;
  return adapters[provider] || null;
}

export function importAll(store) {
  const qoderResult = qoder.importLocal(store);
  const traeResult = trae.importLocal(store);
  const workbuddyResult = workbuddy.importLocal(store);
  const merged = {
    imported: qoderResult.imported + traeResult.imported + workbuddyResult.imported,
    updated: qoderResult.updated + traeResult.updated + workbuddyResult.updated,
    skipped: [...qoderResult.skipped, ...traeResult.skipped, ...workbuddyResult.skipped],
    errors: [...qoderResult.errors, ...traeResult.errors, ...workbuddyResult.errors],
  };
  return merged;
}

export function syncAll(store) {
  qoder.syncActive(store);
  trae.syncActive(store);
  workbuddy.syncActive(store);
}

export function detectClients() {
  const rows = [];
  for (const provider of ["qoder", "qoder-cn"]) {
    try {
      const app = detectQoder(provider);
      rows.push({
        provider,
        label: qoder.QODER_LABEL[provider],
        installed: app.installed,
        signedIn: app.signedIn,
        running: app.running,
        version: app.version,
        exe: app.exe,
        dataDir: app.dataDir,
      });
    } catch (error) {
      rows.push({ provider, label: qoder.QODER_LABEL[provider], installed: false, error: error.message });
    }
  }
  try {
    const app = detectTrae();
    rows.push({
      provider: "trae",
      label: trae.TRAE_LABEL,
      installed: Boolean(app.exe || app.dataExists),
      signedIn: app.signedIn,
      running: app.running,
      version: null,
      exe: app.exe,
      dataDir: app.dataDir,
      name: app.name,
    });
  } catch (error) {
    rows.push({ provider: "trae", label: trae.TRAE_LABEL, installed: false, error: error.message });
  }
  try {
    const app = detectWorkBuddy();
    rows.push({
      provider: "workbuddy",
      label: workbuddy.WORKBUDDY_LABEL,
      installed: app.installed,
      signedIn: app.signedIn || app.switchVaultExists,
      running: app.running,
      version: null,
      exe: app.exe,
      dataDir: app.switchDir,
      switchVault: app.switchVaultExists,
    });
  } catch (error) {
    rows.push({ provider: "workbuddy", label: workbuddy.WORKBUDDY_LABEL, installed: false, error: error.message });
  }
  return rows;
}
