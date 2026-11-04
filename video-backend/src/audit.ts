/**
 * Audit Logging System for Meeting Events
 *
 * Records join/leave/chat events with timestamps, user info, and room context.
 * Logs are stored in memory (ring buffer) and optionally persisted to disk.
 */

import fs from "fs";
import path from "path";

export type AuditEventType =
  | "room_joined"
  | "room_left"
  | "room_disconnected"
  | "chat_message"
  | "private_message"
  | "host_changed"
  | "meeting_expired"
  | "admin_terminated_room";

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  event: AuditEventType;
  userId: string;
  userName: string;
  roomId: string;
  metadata?: Record<string, unknown>;
}

const MAX_MEMORY_ENTRIES = 5000;
const auditLogs: AuditLogEntry[] = [];
let logIdCounter = 0;

// Disk persistence config
const AUDIT_DIR = path.join(__dirname, "../data/audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit-log.jsonl");
let diskEnabled = false;

/**
 * Initialize the audit logging system
 */
export function initAuditLog(dataDir?: string) {
  const dir = dataDir || path.join(__dirname, "../data");
  const auditDir = path.join(dir, "audit");

  try {
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
    diskEnabled = true;

    // Load recent entries from disk on startup
    const diskFile = path.join(auditDir, "audit-log.jsonl");
    if (fs.existsSync(diskFile)) {
      const lines = fs.readFileSync(diskFile, "utf8").split("\n").filter(Boolean);
      // Load last 1000 entries
      const recentLines = lines.slice(-1000);
      for (const line of recentLines) {
        try {
          const entry = JSON.parse(line) as AuditLogEntry;
          auditLogs.push(entry);
          logIdCounter = Math.max(logIdCounter, entry.id.charCodeAt(0) + 1);
        } catch {
          // Skip malformed lines
        }
      }
      // Keep only last MAX_MEMORY_ENTRIES in memory
      while (auditLogs.length > MAX_MEMORY_ENTRIES) {
        auditLogs.shift();
      }
    }

    console.log(`Audit logging initialized (${auditLogs.length} entries loaded from disk)`);
  } catch (error) {
    console.warn("Audit disk logging disabled (data directory not writable):", error);
    diskEnabled = false;
  }
}

/**
 * Record an audit event
 */
export function logAuditEvent(
  event: AuditEventType,
  userId: string,
  userName: string,
  roomId: string,
  metadata?: Record<string, unknown>
): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: `audit-${Date.now()}-${(++logIdCounter).toString(36)}`,
    timestamp: Date.now(),
    event,
    userId,
    userName,
    roomId,
    metadata,
  };

  // Add to memory ring buffer
  auditLogs.push(entry);
  while (auditLogs.length > MAX_MEMORY_ENTRIES) {
    auditLogs.shift();
  }

  // Persist to disk (async, non-blocking)
  if (diskEnabled) {
    try {
      fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
    } catch {
      // Disk write failed, ignore
    }
  }

  // Console log for debugging
  console.log(`[AUDIT] ${event} | user=${userName}(${userId}) room=${roomId}`, metadata || "");

  return entry;
}

/**
 * Query audit logs with filters
 */
export function queryAuditLogs(options: {
  roomId?: string;
  userId?: string;
  event?: AuditEventType;
  since?: number;   // timestamp
  until?: number;   // timestamp
  limit?: number;
  offset?: number;
} = {}): { entries: AuditLogEntry[]; total: number } {
  let filtered = [...auditLogs];

  if (options.roomId) {
    filtered = filtered.filter(e => e.roomId === options.roomId);
  }
  if (options.userId) {
    filtered = filtered.filter(e => e.userId === options.userId);
  }
  if (options.event) {
    filtered = filtered.filter(e => e.event === options.event);
  }
  if (options.since) {
    filtered = filtered.filter(e => e.timestamp >= options.since!);
  }
  if (options.until) {
    filtered = filtered.filter(e => e.timestamp <= options.until!);
  }

  const total = filtered.length;

  // Sort by timestamp descending (newest first)
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  // Apply pagination
  const offset = options.offset || 0;
  const limit = options.limit || 100;
  filtered = filtered.slice(offset, offset + limit);

  return { entries: filtered, total };
}

/**
 * Get audit summary statistics
 */
export function getAuditStats(): {
  totalEvents: number;
  eventsByType: Record<string, number>;
  activeRooms: Set<string>;
  uniqueUsers: Set<string>;
} {
  const eventsByType: Record<string, number> = {};
  const activeRooms = new Set<string>();
  const uniqueUsers = new Set<string>();

  for (const entry of auditLogs) {
    eventsByType[entry.event] = (eventsByType[entry.event] || 0) + 1;
    activeRooms.add(entry.roomId);
    uniqueUsers.add(entry.userId);
  }

  return {
    totalEvents: auditLogs.length,
    eventsByType,
    activeRooms,
    uniqueUsers,
  };
}
