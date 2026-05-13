// Production-safe structured JSON logger.
//
// Emits one JSON object per line on stdout/stderr so it stays
// drain-friendly for Vercel and any log aggregator. Avoid logging
// secrets, request bodies, raw card data, or anything outside the
// explicit `meta` argument here.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const minLevel = LEVELS[configuredLevel] ?? LEVELS.info;

type Meta = Record<string, unknown>;

function emit(level: Level, msg: string, meta?: Meta): void {
  if (LEVELS[level] < minLevel) return;

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, meta?: Meta) => emit("debug", msg, meta),
  info: (msg: string, meta?: Meta) => emit("info", msg, meta),
  warn: (msg: string, meta?: Meta) => emit("warn", msg, meta),
  error: (msg: string, meta?: Meta) => emit("error", msg, meta),
};

export function serializeError(error: unknown): Meta {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: process.env.NODE_ENV === "production" ? undefined : error.stack,
    };
  }
  return { error: String(error) };
}
