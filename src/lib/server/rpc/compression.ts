const minimumBytes = 1024;

// Require the named encoding: a wildcard must not override an explicit refusal.
const acceptsGzip = (header: string | null) => {
  let accepted = false;
  for (const entry of header?.split(',') ?? []) {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(';');
    if (encoding.trim() !== 'gzip') continue;
    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split('=');
      if (name.trim() !== 'q') continue;
      const quality = value?.trim() ?? '';
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) || Number(quality) === 0) return false;
    }
    accepted = true;
  }
  return accepted;
};

// Unary RPC results arrive in one large NDJSON chunk. Inspect only that chunk,
// then stream through native gzip; small replies keep their original bytes.
export const compressRpcResponse = async (request: Request, response: Response) => {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    !response.body ||
    request.method === 'HEAD' ||
    response.status === 206 ||
    response.headers.has('content-range') ||
    response.headers.has('content-encoding') ||
    /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '') ||
    !/^(?:application\/(?:json|x-ndjson|ndjson)|application\/[^;]+\+json)$/.test(contentType)
  )
    return response;

  const headers = new Headers(response.headers);
  const vary = headers.get('vary');
  if (!vary?.split(',').some((value) => ['*', 'accept-encoding'].includes(value.trim().toLowerCase())))
    headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  const init = { status: response.status, statusText: response.statusText, headers };
  const contentLength = headers.get('content-length');
  if (
    !acceptsGzip(request.headers.get('accept-encoding')) ||
    (contentLength !== null && Number(contentLength) < minimumBytes)
  )
    return new Response(response.body, init);

  const reader = response.body.getReader();
  let released = false;
  let streamController: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    streamController = undefined;
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  };
  const cancel = async (reason: unknown) => {
    if (released) return;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const abort = () => {
    streamController?.error(request.signal.reason);
    void cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener('abort', abort, { once: true });

  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    request.signal.throwIfAborted();
    first = await reader.read();
    request.signal.throwIfAborted();
  } catch (error) {
    await cancel(error).catch(() => undefined);
    throw error;
  }
  if (first.done) {
    release();
    return new Response(null, init);
  }
  let prefix: Uint8Array<ArrayBuffer> | undefined = first.value;
  const compress = prefix.byteLength >= minimumBytes;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        try {
          const next = prefix === undefined ? await reader.read() : { done: false, value: prefix };
          prefix = undefined;
          if (released) return;
          if (next.done) {
            release();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  if (!compress) return new Response(source, init);
  headers.set('content-encoding', 'gzip');
  headers.delete('content-length');
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
  return new Response(source.pipeThrough(new CompressionStream('gzip'), { signal: request.signal }), init);
};
