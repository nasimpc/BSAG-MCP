import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

import { TZDate } from '@date-fns/tz';
import { load } from 'cheerio';

import type { ExternalImpact, SourceWarning } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import { sha256Text } from '../shared/hash.js';
import {
  SourceHttpClientError,
  type SourceHttpClient,
  type TextFetchPolicy,
} from './http-client.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const BREMEN_EVENTS_API_URL = new URL(
  'https://login.bremen.de/api/event-search/search',
);
const BREMEN_EVENTS_API_TIMEOUT_MS = 10_000;
const BREMEN_EVENTS_API_MAX_BYTES = 8_000_000;
const BREMEN_EVENTS_DEFAULT_LOOKAHEAD_DAYS = 7;
const BREMEN_EVENTS_CURL_FOOTER = '\n__BSAG_BREMEN_EVENTS_CURL__';
const BREMEN_EVENTS_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BREMEN_EVENTS_CATEGORY_IDS = [
  267, 273, 60, 2, 5, 8, 11, 17, 23, 289, 63, 26, 20, 29, 56, 38, 87, 41, 44,
  47, 277, 294, 280,
] as const;
const BREMEN_EVENTS_HTML_FETCH_POLICY: TextFetchPolicy = {
  expectedTypes: ['application/xhtml+xml', 'text/html', 'text/plain'],
  maxBytes: 2_000_000,
  timeoutMs: 10_000,
};
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const EVENT_DETAIL_PRIORITY = {
  api: 0,
  jsonld: 0,
  html: 1,
} as const;

type EventOrigin = keyof typeof EVENT_DETAIL_PRIORITY;

interface ParsedEventCandidate extends ExternalImpact {
  origin: EventOrigin;
  dedupe_key: string;
}

interface BremenEventsApiResponse {
  body: string;
  contentType: string;
  finalUrl: URL;
  statusCode: number;
}

interface BremenEventsApiFetchRequest {
  apiUrl: URL;
  maxBytes: number;
  payload: Record<string, unknown>;
  sourceUrl: URL;
  timeoutMs: number;
}

export type BremenEventsApiFetcher = (
  request: BremenEventsApiFetchRequest,
) => Promise<BremenEventsApiResponse>;

export async function fetchBremenEvents(options: {
  apiFetcher?: BremenEventsApiFetcher;
  client: Pick<SourceHttpClient, 'getText'>;
  clock: Clock;
  dateFrom?: string;
  dateTo?: string;
  url: URL;
}): Promise<SourceOutcome<ExternalImpact[]>> {
  const now = options.clock.now();
  const fetchedAt = now.toISOString();
  let apiError: Error | undefined;

  if (shouldUseBremenEventsApi(options.url)) {
    try {
      const response = await (options.apiFetcher ?? fetchBremenEventsApiJson)({
        apiUrl: BREMEN_EVENTS_API_URL,
        maxBytes: BREMEN_EVENTS_API_MAX_BYTES,
        payload: buildBremenEventsApiPayload(
          now,
          options.dateFrom,
          options.dateTo,
        ),
        sourceUrl: options.url,
        timeoutMs: BREMEN_EVENTS_API_TIMEOUT_MS,
      });

      return parseBremenEventsApiJson(response.body, options.url, fetchedAt);
    } catch (error) {
      apiError = toError(error);
    }
  }

  try {
    const response = await options.client.getText(
      options.url,
      BREMEN_EVENTS_HTML_FETCH_POLICY,
    );

    return parseBremenEventsHtml(response.body, response.finalUrl, fetchedAt);
  } catch (error) {
    if (apiError !== undefined) {
      throw apiError;
    }

    throw toError(error);
  }
}

export function parseBremenEventsApiJson(
  json: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ExternalImpact[]> {
  const parsed = JSON.parse(json) as unknown;

  if (!Array.isArray(parsed)) {
    throw new SourceHttpClientError(
      'Bremen events API response was not an array',
      'SOURCE_RESPONSE_SCHEMA',
      false,
    );
  }

  const warnings: SourceWarning[] = [];
  const candidates: ParsedEventCandidate[] = [];

  for (const rawEvent of parsed) {
    if (!isRecord(rawEvent)) {
      continue;
    }

    const candidate = toApiCandidate(rawEvent, sourceUrl, fetchedAt);

    if (candidate === undefined) {
      warnings.push(
        warning(
          'bremen_events',
          'MISSING_EFFECTIVE_DATE',
          `Skipping Bremen event API item without usable start date: ${stringValue(rawEvent.title) || 'unknown'}`,
          {
            occurredAt: fetchedAt,
            retryable: false,
          },
        ),
      );
      continue;
    }

    candidates.push(candidate);
  }

  return {
    data: deduplicateCandidates(candidates).map(stripOrigin),
    sources: [
      {
        source: 'bremen_events',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

export function parseBremenEventsHtml(
  html: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ExternalImpact[]> {
  const $ = load(html);
  const warnings: SourceWarning[] = [];
  const candidates: ParsedEventCandidate[] = [];

  for (const rawScript of $('script[type="application/ld+json"]').toArray()) {
    const payload = $(rawScript).text();
    const events = parseJsonLdEvents(payload);

    for (const rawEvent of events) {
      const candidate = toJsonLdCandidate(rawEvent, sourceUrl, fetchedAt);

      if (candidate === undefined) {
        warnings.push(
          warning(
            'bremen_events',
            'MISSING_EFFECTIVE_DATE',
            `Skipping Bremen event without usable start date: ${stringValue(rawEvent.name) || 'unknown'}`,
            {
              occurredAt: fetchedAt,
              retryable: false,
            },
          ),
        );
        continue;
      }

      candidates.push(candidate);
    }
  }

  for (const element of $(
    'article, .event-card, [data-event-card]',
  ).toArray()) {
    const candidate = toHtmlCandidate($, element, sourceUrl, fetchedAt);

    if (candidate === undefined) {
      continue;
    }

    candidates.push(candidate);
  }

  return {
    data: deduplicateCandidates(candidates).map(stripOrigin),
    sources: [
      {
        source: 'bremen_events',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

function toApiCandidate(
  rawEvent: Record<string, unknown>,
  sourceUrl: URL,
  fetchedAt: string,
): ParsedEventCandidate | undefined {
  const title = normalizeWhitespace(stringValue(rawEvent.title));
  const startsAt = epochMillisecondsIso(rawEvent.nextDate);
  const endsAt = epochMillisecondsIso(rawEvent.end, startsAt);

  if (title === '' || startsAt === undefined) {
    return undefined;
  }

  const absoluteUrl = apiEventUrl(rawEvent, sourceUrl);
  const location = apiLocationText(rawEvent);
  const categories = apiCategoryTitles(rawEvent.categories);
  const summary = buildEventSummary(title, location);
  const contentHash = sha256Text(
    [
      stringValue(rawEvent.id),
      title,
      startsAt,
      endsAt,
      location,
      categories.join(','),
    ].join('|'),
  );

  return {
    id: stableId('bremen_events', absoluteUrl.toString(), title, contentHash),
    title,
    summary,
    ...(location === '' ? {} : { details: location }),
    corridor_ids: [],
    starts_at: startsAt,
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    category: 'event',
    severity: eventSeverity(title, categories),
    provenance: {
      source: 'bremen_events',
      sourceUrl: absoluteUrl.toString(),
      fetchedAt,
      contentHash,
    },
    origin: 'api',
    dedupe_key: dedupeKey(title, startsAt, endsAt, location),
  };
}

function parseJsonLdEvents(payload: string): JsonLdEvent[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return [];
  }

  return flattenJsonLd(parsed)
    .filter(isRecord)
    .filter((value): value is JsonLdEvent => isEventType(value['@type']));
}

function flattenJsonLd(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenJsonLd(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  const graph = value['@graph'];

  return [value, ...flattenJsonLd(graph)];
}

function toJsonLdCandidate(
  rawEvent: JsonLdEvent,
  sourceUrl: URL,
  fetchedAt: string,
): ParsedEventCandidate | undefined {
  const title = normalizeWhitespace(stringValue(rawEvent.name));
  const startsAt = normalizeEventDate(stringValue(rawEvent.startDate), false);
  const endsAt = normalizeEventDate(
    stringValue(rawEvent.endDate),
    true,
    startsAt,
  );

  if (title === '' || startsAt === undefined) {
    return undefined;
  }

  const absoluteUrl = new URL(
    stringValue(rawEvent.url) || sourceUrl.toString(),
    sourceUrl,
  );
  const location = locationText(rawEvent.location);
  const summary = buildEventSummary(title, location);
  const contentHash = sha256Text([title, startsAt, endsAt, location].join('|'));

  return {
    id: stableId('bremen_events', absoluteUrl.toString(), title, contentHash),
    title,
    summary,
    ...(location === '' ? {} : { details: location }),
    corridor_ids: [],
    starts_at: startsAt,
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    category: 'event',
    severity: eventSeverity(title),
    provenance: {
      source: 'bremen_events',
      sourceUrl: absoluteUrl.toString(),
      fetchedAt: fetchedAt,
      contentHash,
    },
    origin: 'jsonld',
    dedupe_key: dedupeKey(title, startsAt, endsAt, location),
  };
}

function toHtmlCandidate(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
  sourceUrl: URL,
  fetchedAt: string,
): ParsedEventCandidate | undefined {
  const article = $(element);
  const link = article.find('a[href]').first();
  const title = normalizeWhitespace(link.text() || article.find('h2').text());
  const timeElements = article.find('time').toArray();
  const startRaw =
    timeElements[0] === undefined
      ? ''
      : ($(timeElements[0]).attr('datetime') ?? '');
  const endRaw =
    timeElements[1] === undefined
      ? ''
      : ($(timeElements[1]).attr('datetime') ?? '');
  const startsAt = normalizeEventDate(startRaw, false);
  const endsAt = normalizeEventDate(endRaw, true, startsAt);

  if (title === '' || startsAt === undefined) {
    return undefined;
  }

  const absoluteUrl = new URL(
    link.attr('href') ?? sourceUrl.toString(),
    sourceUrl,
  );
  const location = normalizeWhitespace(
    article.find('.location').first().text() ||
      article.find('[data-location]').first().text(),
  );
  const summary = normalizeWhitespace(
    article.find('.summary').first().text() ||
      buildEventSummary(title, location),
  );
  const contentHash = sha256Text(
    [title, startsAt, endsAt, location, summary].join('|'),
  );

  return {
    id: stableId('bremen_events', absoluteUrl.toString(), title, contentHash),
    title,
    summary,
    ...(location === '' ? {} : { details: location }),
    corridor_ids: [],
    starts_at: startsAt,
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    category: 'event',
    severity: eventSeverity(title),
    provenance: {
      source: 'bremen_events',
      sourceUrl: absoluteUrl.toString(),
      fetchedAt: fetchedAt,
      contentHash,
    },
    origin: 'html',
    dedupe_key: dedupeKey(title, startsAt, endsAt, location),
  };
}

function deduplicateCandidates(
  candidates: ParsedEventCandidate[],
): ParsedEventCandidate[] {
  const deduplicated = new Map<string, ParsedEventCandidate>();

  for (const candidate of candidates) {
    const existing = deduplicated.get(candidate.dedupe_key);

    if (
      existing === undefined ||
      EVENT_DETAIL_PRIORITY[candidate.origin] <
        EVENT_DETAIL_PRIORITY[existing.origin]
    ) {
      deduplicated.set(candidate.dedupe_key, candidate);
    }
  }

  return [...deduplicated.values()];
}

function stripOrigin(candidate: ParsedEventCandidate): ExternalImpact {
  return {
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
    corridor_ids: candidate.corridor_ids,
    ...(candidate.starts_at === undefined
      ? {}
      : { starts_at: candidate.starts_at }),
    ...(candidate.ends_at === undefined ? {} : { ends_at: candidate.ends_at }),
    category: candidate.category,
    severity: candidate.severity,
    provenance: candidate.provenance,
  };
}

function normalizeEventDate(
  value: string,
  endOfDay: boolean,
  fallbackStart?: string,
): string | undefined {
  const trimmed = normalizeWhitespace(value);

  if (trimmed === '') {
    return fallbackStart;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    const [yearText, monthText, dayText] = trimmed.split('-');

    return toBerlinIso(
      Number(yearText),
      Number(monthText),
      Number(dayText),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
  }

  const parsed = Date.parse(trimmed);

  if (Number.isNaN(parsed)) {
    return fallbackStart;
  }

  return new Date(parsed).toISOString();
}

function toBerlinIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): string {
  return new Date(
    new TZDate(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond,
      BERLIN_TIMEZONE,
    ).getTime(),
  ).toISOString();
}

function buildEventSummary(title: string, location: string): string {
  return location === '' ? title : `${title} at ${location}`;
}

function eventSeverity(
  title: string,
  categories: readonly string[] = [],
): ExternalImpact['severity'] {
  const text = [title, ...categories].join(' ');

  return /festival|konzert|musik|messe|freimarkt|woche/iu.test(text)
    ? 'moderate'
    : 'low';
}

function dedupeKey(
  title: string,
  startsAt: string,
  endsAt: string | undefined,
  location: string,
): string {
  void location;

  return [normalizeKey(title), startsAt, endsAt ?? ''].join('|');
}

function locationText(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }

  const name = stringValue(value.name);
  const address = isRecord(value.address)
    ? [
        stringValue(value.address.name),
        stringValue(value.address.streetAddress),
        stringValue(value.address.addressLocality),
      ]
    : [];

  return normalizeWhitespace([name, ...address].filter(Boolean).join(', '));
}

function apiEventUrl(rawEvent: Record<string, unknown>, sourceUrl: URL): URL {
  const redirectUrl = stringValue(rawEvent.redirectUrl);

  if (/^https?:\/\//iu.test(redirectUrl)) {
    return new URL(redirectUrl);
  }

  const slug = normalizeWhitespace(stringValue(rawEvent.slug));

  if (slug !== '') {
    return new URL(`/veranstaltung/${slug}#/`, sourceUrl.origin);
  }

  return sourceUrl;
}

function apiLocationText(rawEvent: Record<string, unknown>): string {
  const address = isRecord(rawEvent.address) ? rawEvent.address : undefined;
  const venue = isRecord(address?.venue) ? address.venue : undefined;
  const parts = [
    stringValue(rawEvent.address_name),
    stringValue(venue?.address),
    stringValue(rawEvent.custom_district),
  ];

  return uniqueNormalizedParts(parts).join(', ');
}

function apiCategoryTitles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueNormalizedParts(
    value.filter(isRecord).map((category) => stringValue(category.title)),
  );
}

function uniqueNormalizedParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const part of parts) {
    const normalized = normalizeWhitespace(part);
    const key = normalizeKey(normalized);

    if (normalized === '' || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

function epochMillisecondsIso(
  value: unknown,
  fallback?: string,
): string | undefined {
  const rawTimestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(rawTimestamp)) {
    return fallback;
  }

  const timestampMs =
    Math.abs(rawTimestamp) < 10_000_000_000
      ? rawTimestamp * 1000
      : rawTimestamp;

  return new Date(timestampMs).toISOString();
}

function shouldUseBremenEventsApi(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/u, '');

  return (
    (host === 'www.bremen.de' || host === 'bremen.de') &&
    path === '/kultur/veranstaltungen'
  );
}

function buildBremenEventsApiPayload(
  now: Date,
  dateFromInput: string | undefined,
  dateToInput: string | undefined,
): Record<string, unknown> {
  const dateFrom = dateFromInput ?? berlinDateString(now);
  const dateTo =
    dateToInput ??
    berlinDateString(
      new Date(
        now.getTime() + BREMEN_EVENTS_DEFAULT_LOOKAHEAD_DAYS * 86_400_000,
      ),
    );

  return {
    tags: [...BREMEN_EVENTS_CATEGORY_IDS],
    dates: [dateFrom, dateTo],
    is_date_search: 1,
    ignore_geo_box: 0,
    locale: 'de',
    free_of_charge: 0,
    navigator_id: 63,
    navigator_type: 'event_teaser',
  };
}

function berlinDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: BERLIN_TIMEZONE,
    year: 'numeric',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';

  return `${year}-${month}-${day}`;
}

function fetchBremenEventsApiJson(
  request: BremenEventsApiFetchRequest,
): Promise<BremenEventsApiResponse> {
  const payload = JSON.stringify(request.payload);
  const timeoutSeconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
  const child = spawn(
    'curl',
    [
      '--silent',
      '--show-error',
      '--location',
      '--compressed',
      '--http1.1',
      '--connect-timeout',
      String(timeoutSeconds),
      '--max-time',
      String(timeoutSeconds),
      '--user-agent',
      BREMEN_EVENTS_BROWSER_USER_AGENT,
      '--header',
      'Accept: application/json',
      '--header',
      'Accept-Language: de-DE,de;q=0.9,en;q=0.8',
      '--header',
      'Content-Type: application/json',
      '--header',
      'Origin: https://www.bremen.de',
      '--header',
      `Referer: ${request.sourceUrl.toString()}`,
      '--data-binary',
      '@-',
      '--write-out',
      `${BREMEN_EVENTS_CURL_FOOTER}%{http_code}\t%{content_type}\t%{url_effective}`,
      request.apiUrl.toString(),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let tooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, request.timeoutMs + 500);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;

      if (stdoutBytes > request.maxBytes + 4096) {
        tooLarge = true;
        child.kill('SIGTERM');
        return;
      }

      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;

      if (stderrBytes <= 4096) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', (error: unknown) => {
      clearTimeout(timer);

      if (isNodeError(error) && error.code === 'ENOENT') {
        reject(
          new SourceHttpClientError(
            'curl is required for the Bremen events API fetcher',
            'SOURCE_CURL_UNAVAILABLE',
            false,
            { cause: error },
          ),
        );
        return;
      }

      reject(
        new SourceHttpClientError(
          error instanceof Error ? error.message : 'curl failed to start',
          'SOURCE_NETWORK_ERROR',
          true,
          { cause: error },
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new SourceHttpClientError(
            'Request timed out',
            'SOURCE_TIMEOUT',
            true,
          ),
        );
        return;
      }

      if (tooLarge) {
        reject(
          new SourceHttpClientError(
            'Response byte limit ' + String(request.maxBytes) + ' exceeded',
            'SOURCE_RESPONSE_TOO_LARGE',
            false,
          ),
        );
        return;
      }

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

        reject(
          new SourceHttpClientError(
            stderr === '' ? 'curl request failed' : stderr,
            'SOURCE_NETWORK_ERROR',
            true,
          ),
        );
        return;
      }

      try {
        resolve(parseCurlResponse(Buffer.concat(stdoutChunks), request));
      } catch (error) {
        reject(toError(error));
      }
    });

    child.stdin.end(payload);
  });
}

function parseCurlResponse(
  output: Buffer,
  request: BremenEventsApiFetchRequest,
): BremenEventsApiResponse {
  const text = output.toString('utf8');
  const footerIndex = text.lastIndexOf(BREMEN_EVENTS_CURL_FOOTER);

  if (footerIndex === -1) {
    throw new SourceHttpClientError(
      'curl response did not include status metadata',
      'SOURCE_RESPONSE_SCHEMA',
      false,
    );
  }

  const body = text.slice(0, footerIndex);
  const metadata = text
    .slice(footerIndex + BREMEN_EVENTS_CURL_FOOTER.length)
    .split('\t');
  const statusCode = Number(metadata[0]);
  const contentType = normalizeMimeType(metadata[1]);
  const finalUrl = new URL(metadata[2] ?? request.apiUrl.toString());

  if (!Number.isInteger(statusCode)) {
    throw new SourceHttpClientError(
      'curl response status metadata was invalid',
      'SOURCE_RESPONSE_SCHEMA',
      false,
    );
  }

  if (TRANSIENT_STATUS_CODES.has(statusCode)) {
    throw new SourceHttpClientError(
      'Transient upstream status ' + String(statusCode),
      'SOURCE_HTTP_STATUS',
      true,
      { statusCode },
    );
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new SourceHttpClientError(
      'Unexpected upstream status ' + String(statusCode),
      'SOURCE_HTTP_STATUS',
      false,
      { statusCode },
    );
  }

  if (contentType !== 'application/json') {
    throw new SourceHttpClientError(
      `Unexpected content type "${contentType}"`,
      'SOURCE_CONTENT_TYPE',
      false,
    );
  }

  if (Buffer.byteLength(body) > request.maxBytes) {
    throw new SourceHttpClientError(
      'Response byte limit ' + String(request.maxBytes) + ' exceeded',
      'SOURCE_RESPONSE_TOO_LARGE',
      false,
    );
  }

  return {
    body,
    contentType,
    finalUrl,
    statusCode,
  };
}

function normalizeMimeType(value: string | undefined): string {
  const [mimeType = 'application/octet-stream'] = (
    value ?? 'application/octet-stream'
  ).split(';', 1);

  return mimeType.trim().toLowerCase();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function stableId(
  source: 'bremen_events',
  sourceUrl: string,
  title: string,
  contentHash: string,
): string {
  return sha256Text([source, sourceUrl, title, contentHash].join('|')).slice(
    0,
    24,
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isEventType(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === 'Event';
  }

  return Array.isArray(value) && value.some((entry) => entry === 'Event');
}

interface JsonLdEvent extends Record<string, unknown> {
  '@type'?: unknown;
  name?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  url?: unknown;
  location?: unknown;
}
