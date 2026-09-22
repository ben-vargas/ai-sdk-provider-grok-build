export function abortError(
  signal: AbortSignal,
  fallbackMessage: string,
): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(fallbackMessage);
  error.name = "AbortError";
  return error;
}

export async function waitAbortably<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw abortError(signal, fallbackMessage);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal, fallbackMessage));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
