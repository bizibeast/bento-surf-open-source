/** Relay native Worker streams with write backpressure and cancellation in either direction. */
export async function streamFrameResponse(
  body: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  length: number,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const writer = destination.getWriter();
  let shutdown: Promise<unknown> | undefined;
  const stop = (reason: unknown) => {
    shutdown ??= Promise.allSettled([reader.cancel(reason), writer.abort(reason)]);
    return shutdown;
  };
  const abort = () => {
    void stop(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  // A disconnect can occur while the pump is blocked on its next upstream read.
  void writer.closed.catch(stop);
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > length) throw new Error("Frame response exceeds declared length.");
      await writer.write(next.value);
    }
    if (received !== length) throw new Error("Incomplete frame response.");
    await writer.close();
  } catch (error) {
    await stop(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
    writer.releaseLock();
  }
}
