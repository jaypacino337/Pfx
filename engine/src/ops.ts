import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

const LEASE_MS = 120_000;

/**
 * One engine per state dir; two would double-buy and double-airdrop. The lock
 * is a lease the owner renews every 30s. A fresh lease is never taken over,
 * unless it belongs to a dead process on this same machine. A crashed engine's
 * lease expires after 2 minutes, so restarts recover on their own.
 */
export function acquireLock(cfg: Config): () => void {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const file = path.join(cfg.stateDir, "engine.lock");
  const id = randomUUID();
  let held: { host?: string; pid?: number; id?: string; at?: number } | null = null;
  try {
    held = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    held = null; // missing or unreadable: free
  }
  if (held?.at && Date.now() - held.at < LEASE_MS) {
    const provablyDead = held.host === os.hostname() && held.pid !== process.pid && !alive(held.pid ?? 0);
    if (!provablyDead) {
      throw new Error(
        `Another PFX engine (${held.host} pid ${held.pid}) holds ${file}. Stop it first, or wait 2 minutes if it crashed.`,
      );
    }
  }
  const write = () => fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), pid: process.pid, id, at: Date.now() }));
  write();
  const renew = setInterval(() => {
    try {
      write();
    } catch (e) {
      console.error("[lock] renew failed:", (e as Error).message);
    }
  }, 30_000);
  renew.unref();
  return () => {
    clearInterval(renew);
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).id === id) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill switch: PAUSED=true or a file named PAUSE in the state dir. */
export function isPaused(cfg: Config): boolean {
  return cfg.paused || fs.existsSync(path.join(cfg.stateDir, "PAUSE"));
}

export function heartbeat(cfg: Config): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.stateDir, "heartbeat"), String(Date.now()));
}

/** Post to Discord and/or Telegram if configured. Never throws. */
export async function notify(cfg: Config, text: string): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (cfg.discordWebhook) {
    jobs.push(
      fetch(cfg.discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, 1_900) }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
  }
  if (cfg.telegramToken && cfg.telegramChatId) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text: text.slice(0, 3_900), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
  }
  await Promise.allSettled(jobs);
}
