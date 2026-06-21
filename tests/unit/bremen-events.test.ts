import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  fetchBremenEvents,
  parseBremenEventsApiJson,
  parseBremenEventsHtml,
  type BremenEventsApiFetcher,
} from '../../src/sources/bremen-events.js';

const fixture = readFileSync(
  new URL('../fixtures/bremen-events.html', import.meta.url),
  'utf8',
);
const sourceUrl = new URL('https://www.bremen.de/kultur/veranstaltungen');
const fetchedAt = '2026-06-20T05:00:00Z';

describe('parseBremenEventsHtml', () => {
  it('prefers JSON-LD over duplicate HTML cards, resolves relative links, and warns on missing dates', () => {
    const first = parseBremenEventsHtml(fixture, sourceUrl, fetchedAt);
    const second = parseBremenEventsHtml(fixture, sourceUrl, fetchedAt);
    const osterdeich = first.data.find((impact) =>
      impact.title.includes('Osterdeich Festival'),
    );
    const maritime = first.data.find((impact) =>
      impact.title.includes('Maritime Woche'),
    );
    const jazzNight = first.data.find((impact) =>
      impact.title.includes('Jazz Night at Schlachthof'),
    );

    expect(first.data).toHaveLength(3);
    expect(first.data.map((impact) => impact.id)).toEqual(
      second.data.map((impact) => impact.id),
    );

    expect(osterdeich).toBeDefined();
    expect(osterdeich?.starts_at).toBe('2026-06-20T16:00:00.000Z');
    expect(osterdeich?.ends_at).toBe('2026-06-20T21:00:00.000Z');
    expect(osterdeich?.provenance.sourceUrl).toBe(
      'https://www.bremen.de/events/osterdeich-festival',
    );

    expect(maritime).toBeDefined();
    expect(maritime?.starts_at).toBe('2026-06-20T22:00:00.000Z');
    expect(maritime?.ends_at).toBe('2026-06-22T21:59:59.999Z');

    expect(jazzNight).toBeDefined();
    expect(jazzNight?.provenance.sourceUrl).toBe(
      'https://www.bremen.de/events/jazz-night',
    );

    expect(first.warnings).toContainEqual(
      expect.objectContaining({
        source: 'bremen_events',
        code: 'MISSING_EFFECTIVE_DATE',
      }),
    );
  });

  it('parses JSON-LD address objects and HTML fallback cards with invalid JSON-LD safely ignored', () => {
    const outcome = parseBremenEventsHtml(
      [
        '<main>',
        '  <script type="application/ld+json">{invalid json</script>',
        '  <script type="application/ld+json">',
        '    {',
        '      "@graph": [',
        '        {',
        '          "@type": ["Thing", "Event"],',
        '          "name": "Neighbourhood market",',
        '          "startDate": "2026-06-21",',
        '          "location": {',
        '            "name": "Marktplatz",',
        '            "address": {',
        '              "streetAddress": "Markt 1",',
        '              "addressLocality": "Bremen"',
        '            }',
        '          }',
        '        }',
        '      ]',
        '    }',
        '  </script>',
        '  <article data-event-card>',
        '    <h2>Harbour walk</h2>',
        '    <time datetime="2026-06-21T09:30:00Z"></time>',
        '    <span data-location>Vegesack</span>',
        '  </article>',
        '  <article data-event-card>',
        '    <h2>Draft card without time</h2>',
        '  </article>',
        '</main>',
      ].join('\n'),
      sourceUrl,
      fetchedAt,
    );
    const market = outcome.data.find(
      (impact) => impact.title === 'Neighbourhood market',
    );
    const harbourWalk = outcome.data.find(
      (impact) => impact.title === 'Harbour walk',
    );

    expect(market).toMatchObject({
      title: 'Neighbourhood market',
      summary: 'Neighbourhood market at Marktplatz, Markt 1, Bremen',
      details: 'Marktplatz, Markt 1, Bremen',
      starts_at: '2026-06-20T22:00:00.000Z',
      ends_at: '2026-06-20T22:00:00.000Z',
      severity: 'low',
    });
    expect(market?.provenance.sourceUrl).toBe(sourceUrl.toString());
    expect(harbourWalk).toMatchObject({
      title: 'Harbour walk',
      summary: 'Harbour walk at Vegesack',
      details: 'Vegesack',
      starts_at: '2026-06-21T09:30:00.000Z',
      ends_at: '2026-06-21T09:30:00.000Z',
    });
    expect(harbourWalk?.provenance.sourceUrl).toBe(sourceUrl.toString());
  });
});

describe('parseBremenEventsApiJson', () => {
  it('maps the public event-search API payload into external impacts', () => {
    const outcome = parseBremenEventsApiJson(
      JSON.stringify([
        {
          id: 36322,
          title: 'Stefanie Heinzmann - Circles Tour 2026',
          slug: 'stefanie-heinzmann-circles-tour-2026',
          address_name: 'Metropol Theater Bremen',
          address: {
            venue: {
              address: 'Richtweg 7-13, 28195 Bremen',
            },
          },
          custom_district: 'Mitte',
          categories: [{ title: 'Musik & Konzerte' }],
          nextDate: 1793905200000,
          end: 1793914200000,
        },
        {
          id: 1,
          title: 'Draft event without date',
          slug: 'draft-event-without-date',
        },
      ]),
      sourceUrl,
      fetchedAt,
    );
    const event = outcome.data[0];

    expect(outcome.data).toHaveLength(1);
    expect(event).toMatchObject({
      title: 'Stefanie Heinzmann - Circles Tour 2026',
      summary:
        'Stefanie Heinzmann - Circles Tour 2026 at Metropol Theater Bremen, Richtweg 7-13, 28195 Bremen, Mitte',
      details: 'Metropol Theater Bremen, Richtweg 7-13, 28195 Bremen, Mitte',
      starts_at: '2026-11-05T19:00:00.000Z',
      ends_at: '2026-11-05T21:30:00.000Z',
      category: 'event',
      severity: 'moderate',
    });
    expect(event?.provenance.sourceUrl).toBe(
      'https://www.bremen.de/veranstaltung/stefanie-heinzmann-circles-tour-2026#/',
    );
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'bremen_events',
        code: 'MISSING_EFFECTIVE_DATE',
      }),
    );
  });
});

describe('fetchBremenEvents', () => {
  const clock = {
    now: () => new Date(fetchedAt),
  };

  it('uses the public event-search API for the configured bremen.de calendar URL', async () => {
    let htmlFetchCount = 0;
    const client = {
      getText() {
        htmlFetchCount += 1;
        return Promise.reject(new Error('unexpected HTML fetch'));
      },
    };
    const apiRequests: Array<Parameters<BremenEventsApiFetcher>[0]> = [];
    const apiFetcher: BremenEventsApiFetcher = (request) => {
      apiRequests.push(request);
      expect(request.apiUrl.toString()).toBe(
        'https://login.bremen.de/api/event-search/search',
      );
      expect(request.payload).toEqual(
        expect.objectContaining({
          navigator_id: 63,
          navigator_type: 'event_teaser',
          locale: 'de',
          dates: ['2026-06-21', '2026-06-22'],
        }),
      );

      return Promise.resolve({
        body: JSON.stringify([
          {
            id: 10,
            title: 'Public API event',
            slug: 'public-api-event',
            nextDate: 1782028800000,
            end: 1782032400000,
          },
        ]),
        contentType: 'application/json',
        finalUrl: request.apiUrl,
        statusCode: 200,
      });
    };

    const outcome = await fetchBremenEvents({
      apiFetcher,
      client,
      clock,
      dateFrom: '2026-06-21',
      dateTo: '2026-06-22',
      url: sourceUrl,
    });

    expect(outcome.data.map((impact) => impact.title)).toEqual([
      'Public API event',
    ]);
    expect(apiRequests).toHaveLength(1);
    expect(htmlFetchCount).toBe(0);
  });

  it('keeps the HTML parser path for non-bremen fixture URLs', async () => {
    const fixtureUrl = new URL('http://127.0.0.1:4567/bremen-events');
    let htmlFetchCount = 0;
    let apiFetchCount = 0;
    const client = {
      getText() {
        htmlFetchCount += 1;
        return Promise.resolve({
          body: fixture,
          contentType: 'text/html',
          finalUrl: fixtureUrl,
          statusCode: 200,
          attempts: 1,
          redirectCount: 0,
        });
      },
    };
    const apiFetcher: BremenEventsApiFetcher = () => {
      apiFetchCount += 1;
      return Promise.reject(new Error('unexpected API fetch'));
    };

    const outcome = await fetchBremenEvents({
      apiFetcher,
      client,
      clock,
      url: fixtureUrl,
    });

    expect(outcome.data).toHaveLength(3);
    expect(apiFetchCount).toBe(0);
    expect(htmlFetchCount).toBe(1);
  });
});
