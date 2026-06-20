import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseBremenEventsHtml } from '../../src/sources/bremen-events.js';

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
});
