const util = require('util');

const LEVEL_TO_CONSOLE = {
    debug: 'log',
    info: 'log',
    warn: 'warn',
    error: 'error',
};

const normalizeScope = (scope) => (typeof scope === 'string' && scope.trim() ? scope.trim() : 'App');

const describeError = (error) => {
    if (!(error instanceof Error)) return error;
    return {
        name: error.name,
        message: error.message,
        code: error.code,
        signal: error.signal,
        stack: error.stack,
    };
};

const serializeMeta = (meta) => {
    if (meta === undefined) return '';
    const normalized = meta instanceof Error ? describeError(meta) : meta;
    return util.inspect(normalized, {
        depth: 4,
        breakLength: 140,
        compact: true,
        maxArrayLength: 20,
    });
};

const writeLog = (level, scope, message, meta) => {
    const consoleMethod = console[LEVEL_TO_CONSOLE[level]] || console.log;
    const suffix = meta !== undefined ? ` | ${serializeMeta(meta)}` : '';
    consoleMethod(`${new Date().toISOString()} [${level.toUpperCase()}] [${normalizeScope(scope)}] ${message}${suffix}`);
};

module.exports = {
    debug: (scope, message, meta) => writeLog('debug', scope, message, meta),
    info: (scope, message, meta) => writeLog('info', scope, message, meta),
    warn: (scope, message, meta) => writeLog('warn', scope, message, meta),
    error: (scope, message, meta) => writeLog('error', scope, message, meta),
    describeError,
};
