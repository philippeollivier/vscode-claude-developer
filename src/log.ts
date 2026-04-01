export function logError(context: string, err: unknown): void {
    console.error(`Claude Developer [ERROR] ${context}:`, err);
}

export function logWarn(context: string, msg: string): void {
    console.warn(`Claude Developer [WARN] ${context}: ${msg}`);
}

export function logInfo(context: string, msg: string): void {
    console.log(`Claude Developer [INFO] ${context}: ${msg}`);
}
