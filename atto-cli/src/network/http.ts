export interface BoundedTextOptions {
  maxBytes: number;
  fatalUtf8?: boolean;
  firstLineOnly?: boolean;
  onEmptyBody?: () => never;
  onInvalidUtf8?: () => never;
  onTooLarge: () => never;
}

/** Read a bounded UTF-8 response body while always cancelling and releasing its stream reader. */
export async function readBoundedText(response: Response, options: BoundedTextOptions): Promise<string> {
  if (!response.body) {
    if (options.onEmptyBody) options.onEmptyBody();
    return '';
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (!options.firstLineOnly && contentLength > options.maxBytes) {
    await response.body.cancel().catch(() => undefined);
    options.onTooLarge();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: options.fatalUtf8 === true });
  const decode = (bytes?: Uint8Array, decodeOptions?: TextDecodeOptions): string => {
    try { return decoder.decode(bytes, decodeOptions); }
    catch (error) {
      if (options.onInvalidUtf8 && error instanceof TypeError) options.onInvalidUtf8();
      throw error;
    }
  };
  let size = 0;
  try {
    if (options.firstLineOnly) {
      let body = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) options.onTooLarge();
        body += decode(value, { stream: true });
        const newline = body.indexOf('\n');
        if (newline >= 0) return body.slice(0, newline);
      }
      return body + decode();
    }
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) options.onTooLarge();
      chunks.push(value);
    }
    return decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
