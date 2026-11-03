"use strict";
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  requestUrl,
  normalizePath,
  TFile,
} = require("obsidian");

const DEFAULTS = {
  link: "",
  intervalSec: 60,
  mirrorDeletes: false,
  cache: {},
  lastSync: "",
};
const MAX_CONTENT = 500000;
const BATCH = 50;

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Принимает ссылку коннектора целиком: https://.../obsidian-mcp?key=...
function parseLink(link) {
  const s = (link || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  const key = u.searchParams.get("key");
  if (!key) return null;
  return { base: u.origin + u.pathname.replace(/\/+$/, ""), key };
}

const isHidden = (path) => path.split("/").some((seg) => seg.startsWith("."));

module.exports = class VaultSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    if (!this.settings.cache) this.settings.cache = {};
    this.syncing = false;
    this.timer = null;
    this.debounce = null;

    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Sync vault with Claude", () => this.sync(true));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.sync(true),
    });

    this.registerEvent(this.app.vault.on("modify", (f) => this.onChange(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onChange(f)));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.sync(false);
    });

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.sync(false), 3000);
    });
    this.restartTimer();
  }

  onunload() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.debounce) window.clearTimeout(this.debounce);
  }

  restartTimer() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    const sec = Number(this.settings.intervalSec);
    if (sec > 0) {
      this.timer = window.setInterval(() => this.sync(false), Math.max(15, sec) * 1000);
      this.registerInterval(this.timer);
    }
  }

  onChange(f) {
    if (!(f instanceof TFile) || f.extension !== "md") return;
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.sync(false), 5000);
  }

  async persist() {
    await this.saveData(this.settings);
  }

  async api(cfg, path, body) {
    const res = await requestUrl({
      url: cfg.base + path,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + cfg.key,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (res.status === 401) throw new Error("неверный ключ в ссылке коннектора");
    if (res.status >= 400) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json;
  }

  async sync(manual) {
    if (this.syncing) {
      if (manual) new Notice("Vault Sync: синхронизация уже идёт");
      return;
    }
    const cfg = parseLink(this.settings.link);
    if (!cfg) {
      if (manual) new Notice("Vault Sync: вставь ссылку коннектора в настройках плагина");
      return;
    }
    this.syncing = true;
    try {
      const pulled = await this.pull(cfg);
      const r = await this.push(cfg);
      this.settings.lastSync = new Date().toLocaleString();
      await this.persist();
      if (manual || pulled || r.pushed || r.deleted) {
        new Notice(
          `Vault Sync: ← ${pulled}, → ${r.pushed}` + (r.deleted ? `, ✕ ${r.deleted}` : "")
        );
      }
    } catch (e) {
      console.error("Vault Sync", e);
      if (manual) new Notice("Vault Sync: " + (e && e.message ? e.message : e));
    } finally {
      this.syncing = false;
    }
  }

  // Забрать заметки, которые создал или дописал Claude.
  async pull(cfg) {
    const res = await this.api(cfg, "/sync/pending");
    const notes = (res && res.notes) || [];
    const acks = [];
    for (const n of notes) {
      const path = normalizePath(n.path);
      if (isHidden(path)) continue;
      let target = path;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const local = await this.app.vault.read(existing);
        const h = await sha256(local);
        if (h !== n.synced_hash && h !== n.content_hash) {
          // локально правили после последней синхронизации: версию Claude кладём рядом
          target = path.replace(/\.md$/i, "") + " (Claude).md";
          new Notice(`Vault Sync: конфликт в ${path}, версия Claude сохранена отдельно`);
        }
      }
      await this.writeNote(target, n.content);
      acks.push({ path: n.path, hash: n.content_hash });
    }
    for (let i = 0; i < acks.length; i += 200) {
      await this.api(cfg, "/sync/ack", { items: acks.slice(i, i + 200) });
    }
    return acks.length;
  }

  async writeNote(path, content) {
    const vault = this.app.vault;
    const f = vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      await vault.modify(f, content);
      return;
    }
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await this.ensureFolder(dir);
    await vault.create(path, content);
  }

  async ensureFolder(dir) {
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? cur + "/" + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          /* уже создана параллельно */
        }
      }
    }
  }

  // Отправить новые и изменённые заметки.
  async push(cfg) {
    const res = await this.api(cfg, "/sync/manifest");
    const serverNotes = (res && res.notes) || [];
    const manifest = new Map(serverNotes.map((n) => [n.path, n]));
    const files = this.app.vault.getMarkdownFiles().filter((f) => !isHidden(f.path));
    const cache = this.settings.cache;
    const seen = new Set();
    const todo = [];

    for (const f of files) {
      seen.add(f.path);
      const m = manifest.get(f.path);
      if (m && m.pending_pull) continue;

      let text = null;
      let hash;
      const c = cache[f.path];
      if (c && c.mtime === f.stat.mtime && c.size === f.stat.size) {
        hash = c.hash;
      } else {
        text = await this.app.vault.read(f);
        hash = await sha256(text);
        cache[f.path] = { mtime: f.stat.mtime, size: f.stat.size, hash };
      }
      if (m && m.content_hash === hash) continue;

      if (text === null) text = await this.app.vault.read(f);
      if (text.length > MAX_CONTENT) {
        console.warn("Vault Sync: слишком большая заметка, пропущена:", f.path);
        continue;
      }
      todo.push({
        path: f.path,
        content: text,
        mtime: new Date(f.stat.mtime).toISOString(),
      });
    }
    for (const p of Object.keys(cache)) if (!seen.has(p)) delete cache[p];

    let pushed = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const r = await this.api(cfg, "/sync/push", { notes: todo.slice(i, i + BATCH) });
      pushed += (r && r.saved) || 0;
    }

    let deleted = 0;
    if (this.settings.mirrorDeletes && files.length > 0) {
      const gone = serverNotes
        .filter((n) => !seen.has(n.path) && !n.pending_pull)
        .map((n) => n.path);
      // защита: не стираем на сервере больше половины заметок за раз
      if (gone.length && gone.length <= Math.max(5, Math.floor(serverNotes.length / 2))) {
        for (let i = 0; i < gone.length; i += 200) {
          await this.api(cfg, "/sync/delete", { paths: gone.slice(i, i + 200) });
        }
        deleted = gone.length;
      } else if (gone.length) {
        console.warn("Vault Sync: удаление пропущено, слишком много заметок:", gone.length);
      }
    }
    return { pushed, deleted };
  }
};

class SyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Ссылка коннектора")
      .setDesc("Вставь целиком: https://…/obsidian-mcp?key=…")
      .addText((t) =>
        t
          .setPlaceholder("https://…/obsidian-mcp?key=…")
          .setValue(s.link)
          .onChange(async (v) => {
            s.link = v.trim();
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("Интервал синхронизации, секунд")
      .setDesc("0 — только вручную, при открытии приложения и после правок. Минимум 15.")
      .addText((t) =>
        t.setValue(String(s.intervalSec)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.intervalSec = Number.isFinite(n) && n >= 0 ? n : 60;
          await this.plugin.persist();
          this.plugin.restartTimer();
        })
      );

    new Setting(containerEl)
      .setName("Переносить удаления")
      .setDesc("Если заметку удалили в Obsidian, удалять её и на сервере (для Claude).")
      .addToggle((t) =>
        t.setValue(s.mirrorDeletes).onChange(async (v) => {
          s.mirrorDeletes = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Синхронизировать сейчас")
      .setDesc("Последняя синхронизация: " + (s.lastSync || "ещё не было"))
      .addButton((b) =>
        b
          .setButtonText("Синхронизировать")
          .setCta()
          .onClick(() => this.plugin.sync(true))
      );
  }
}
