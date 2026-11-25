/** Minimal injectable logger. Library default is silent; CLI/MCP log to stderr only. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

export function createStderrLogger(verbose = false): Logger {
  const write = (level: string, message: string): void => {
    process.stderr.write(`[semantic-code-index] ${level}: ${message}\n`);
  };
  return {
    debug: (m) => {
      if (verbose) write('debug', m);
    },
    info: (m) => {
      if (verbose) write('info', m);
    },
    warn: (m) => write('warn', m),
    error: (m) => write('error', m)
  };
}
