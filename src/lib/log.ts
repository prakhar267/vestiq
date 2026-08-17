/** Structured JSON logging. One line per event, always carrying request_id. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(
    private readonly requestId: string,
    private readonly minLevel: Level = 'info',
    private readonly base: Record<string, unknown> = {},
  ) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.requestId, this.minLevel, { ...this.base, ...fields });
  }

  private emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const line = {
      level,
      msg,
      request_id: this.requestId,
      ts: new Date().toISOString(),
      ...this.base,
      ...fields,
    };
    const out = JSON.stringify(line);
    if (level === 'error') console.error(out);
    else if (level === 'warn') console.warn(out);
    else console.log(out);
  }

  debug = (m: string, f?: Record<string, unknown>) => this.emit('debug', m, f);
  info = (m: string, f?: Record<string, unknown>) => this.emit('info', m, f);
  warn = (m: string, f?: Record<string, unknown>) => this.emit('warn', m, f);

  /** Errors are serialised explicitly — a raw Error JSON-stringifies to `{}`. */
  error(msg: string, err?: unknown, fields: Record<string, unknown> = {}): void {
    this.emit('error', msg, {
      ...fields,
      error:
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err === undefined
            ? undefined
            : String(err),
    });
  }

  /** Time an async span and log its duration. Rethrows on failure. */
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await fn();
      this.debug(`span.${name}`, { ms: Date.now() - started, ok: true });
      return out;
    } catch (err) {
      this.error(`span.${name} failed`, err, { ms: Date.now() - started });
      throw err;
    }
  }
}

export function makeLogger(requestId: string, level = 'info'): Logger {
  const lvl = (['debug', 'info', 'warn', 'error'] as Level[]).includes(level as Level)
    ? (level as Level)
    : 'info';
  return new Logger(requestId, lvl);
}
