export function logError(context: string, err: unknown): void {
    console.error(`Claude Developer: ${context}:`, err);
}
