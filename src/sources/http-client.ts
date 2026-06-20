import { Buffer } from 'node:buffer';

import { request, type Dispatcher } from 'undici';

import type { SourceId } from '../domain/models.js';
import { logger as defaultLogger } from '../shared/logger.js';

const MAX_TRANSIENT_RETRIES = 2;
const MAX_REDIRECTS = 3;
const BACKOFF_BASE_MS = 100;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface SourceFetchPolicy {
  sourceId: SourceId;
  timeoutMs: number;
  maxBytes: number;
  expectedMimeTypes: readonly string[];
}

export interface SourceBytesResponse {
  url: string;
  mimeType: string;
  bytes: Uint8Array;
  attempts: number;
  redirectCount: number;
  statusCode: number;
}

export interface SourceTextResponse extends SourceBytesResponse {
  text: string;
}

export class SourceHttpClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SourceHttpClientError';
  }
}

export class SourceHttpClient {
  constructor(
    private readonly options: {
      allowedHost: string;
      dispatcher: Dispatcher;
      logger?: typeof defaultLogger;
      sleeper?: (delayMs: number) => Promise<void>;
      jitter?: () => number;
    },
  ) {}

  async getText(
    url: string,
    policy: SourceFetchPolicy,
  ): Promise<SourceTextResponse> {
    const result = await this.fetch(url, policy);

    return {
      ...result,
      text: new TextDecoder().decode(result.bytes),
    };
  }

  async getBytes(
    url: string,
    policy: SourceFetchPolicy,
  ): Promise<SourceBytesResponse> {
    return this.fetch(url, policy);
  }

  private async fetch(
    url: string,
    policy: SourceFetchPolicy,
  ): Promise<SourceBytesResponse> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= MAX_TRANSIENT_RETRIES) {
      attempt += 1;

      try {
        const response = await this.fetchWithRedirects(url, policy);

        this.log().info({
          event: 'source_http_success',
          sourceId: policy.sourceId,
          url: response.url,
          statusCode: response.statusCode,
          mimeType: response.mimeType,
          byteCount: response.bytes.byteLength,
          attempts: attempt,
          redirectCount: response.redirectCount,
        });

        return {
          ...response,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;

        if (!this.isRetryable(error) || attempt > MAX_TRANSIENT_RETRIES) {
          this.log().warn({
            event: 'source_http_failure',
            sourceId: policy.sourceId,
            url,
            attempts: attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }

        const delayMs =
          BACKOFF_BASE_MS * 2 ** (attempt - 1) + this.jitterValue();

        this.log().warn({
          event: 'source_http_retry',
          sourceId: policy.sourceId,
          url,
          attempts: attempt,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(delayMs);
      }
    }

    throw this.wrapError(lastError, 'Request failed');
  }

  private async fetchWithRedirects(
    initialUrl: string,
    policy: SourceFetchPolicy,
  ): Promise<Omit<SourceBytesResponse, 'attempts'>> {
    let currentUrl = new URL(initialUrl);
    let redirectCount = 0;

    this.assertAllowedHost(currentUrl, 'Requested URL must use the allow-listed host');

    while (true) {
      const response = await request(currentUrl, {
        dispatcher: this.options.dispatcher,
        method: 'GET',
        signal: AbortSignal.timeout(policy.timeoutMs),
        headers: {
          accept: policy.expectedMimeTypes.join(', '),
        },
      });

      if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
        if (redirectCount >= MAX_REDIRECTS) {
          throw new SourceHttpClientError(
            'Too many redirects',
            'TOO_MANY_REDIRECTS',
            false,
          );
        }

        const location = getHeader(response.headers.location);

        if (!location) {
          throw new SourceHttpClientError(
            'Redirect response did not include a location header',
            'REDIRECT_LOCATION_MISSING',
            false,
          );
        }

        const nextUrl = new URL(location, currentUrl);
        this.assertAllowedHost(nextUrl, 'Redirect host must stay on the allow-listed host');
        currentUrl = nextUrl;
        redirectCount += 1;
        continue;
      }

      if (TRANSIENT_STATUS_CODES.has(response.statusCode)) {
        throw new SourceHttpClientError(
          `Transient upstream status ${response.statusCode}`,
          'TRANSIENT_STATUS',
          true,
        );
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new SourceHttpClientError(
          `Unexpected upstream status ${response.statusCode}`,
          'UNEXPECTED_STATUS',
          false,
        );
      }

      const mimeType = normalizeMimeType(getHeader(response.headers['content-type']));
      this.assertExpectedMimeType(mimeType, policy.expectedMimeTypes);
      this.assertContentLength(getHeader(response.headers['content-length']), policy.maxBytes);

      const bytes = await this.readBody(response.body, policy.maxBytes);

      return {
        url: currentUrl.toString(),
        mimeType,
        bytes,
        redirectCount,
        statusCode: response.statusCode,
      };
    }
  }

  private assertAllowedHost(url: URL, message: string): void {
    if (url.host !== this.options.allowedHost) {
      throw new SourceHttpClientError(
        message,
        'HOST_NOT_ALLOWED',
        false,
      );
    }
  }

  private assertExpectedMimeType(
    mimeType: string,
    expectedMimeTypes: readonly string[],
  ): void {
    const normalizedExpected = expectedMimeTypes.map((value) =>
      normalizeMimeType(value),
    );

    if (!normalizedExpected.includes(mimeType)) {
      throw new SourceHttpClientError(
        `Unexpected mime type "${mimeType}"`,
        'UNEXPECTED_MIME',
        false,
      );
    }
  }

  private assertContentLength(
    contentLengthHeader: string | undefined,
    maxBytes: number,
  ): void {
    if (!contentLengthHeader) {
      return;
    }

    const declaredBytes = Number(contentLengthHeader);

    if (!Number.isFinite(declaredBytes)) {
      return;
    }

    if (declaredBytes > maxBytes) {
      throw new SourceHttpClientError(
        `Response content-length ${declaredBytes} exceeds limit ${maxBytes}`,
        'CONTENT_LENGTH_LIMIT',
        false,
      );
    }
  }

  private async readBody(
    body: AsyncIterable<Buffer>,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of body) {
      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        throw new SourceHttpClientError(
          `Response byte limit ${maxBytes} exceeded`,
          'BYTE_LIMIT_EXCEEDED',
          false,
        );
      }

      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof SourceHttpClientError) {
      return error.retryable;
    }

    if (error instanceof Error) {
      return (
        error.name === 'AbortError' ||
        /socket|connect|timeout|reset|econn/i.test(error.message)
      );
    }

    return false;
  }

  private wrapError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    return new SourceHttpClientError(
      fallbackMessage,
      'REQUEST_FAILED',
      false,
      error,
    );
  }

  private async sleep(delayMs: number): Promise<void> {
    const sleeper =
      this.options.sleeper ??
      (async (value: number) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, value);
        });
      });

    await sleeper(delayMs);
  }

  private jitterValue(): number {
    return Math.max(0, Math.floor((this.options.jitter ?? (() => Math.random() * 25))()));
  }

  private log() {
    return this.options.logger ?? defaultLogger;
  }
}

function getHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function normalizeMimeType(value: string | undefined): string {
  return (value ?? 'application/octet-stream').split(';', 1)[0]!.trim().toLowerCase();
}
