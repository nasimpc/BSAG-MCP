import { MockAgent, errors } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/shared/logger.js';
import { SourceHttpClient } from '../../src/sources/http-client.js';

describe('SourceHttpClient', () => {
  const agents: MockAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.map(async (agent) => agent.close()));
    agents.length = 0;
  });

  function createAgent(): MockAgent {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agents.push(agent);
    return agent;
  }

  it('rejects requests whose host is not allow-listed', async () => {
    const agent = createAgent();
    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async () => {},
      jitter: () => 0,
    });

    await expect(
      client.getText('https://denied.example/feed.txt', {
        sourceId: 'bsag',
        timeoutMs: 250,
        maxBytes: 1024,
        expectedMimeTypes: ['text/plain'],
      }),
    ).rejects.toThrow(/allow-listed host/i);
  });

  it('retries transient failures at most twice with deterministic backoff', async () => {
    const agent = createAgent();
    const pool = agent.get('https://allowed.example');
    const sleepCalls: number[] = [];

    pool
      .intercept({ path: '/flaky', method: 'GET' })
      .reply(503, 'unavailable', {
        headers: { 'content-type': 'text/plain' },
      });

    pool
      .intercept({ path: '/flaky', method: 'GET' })
      .replyWithError(new errors.SocketError('socket closed'));

    pool
      .intercept({ path: '/flaky', method: 'GET' })
      .reply(200, 'ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });

    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
      jitter: () => 0,
    });

    const response = await client.getText('https://allowed.example/flaky', {
      sourceId: 'bsag',
      timeoutMs: 250,
      maxBytes: 1024,
      expectedMimeTypes: ['text/plain'],
    });

    expect(response.text).toBe('ok');
    expect(response.mimeType).toBe('text/plain');
    expect(response.attempts).toBe(3);
    expect(sleepCalls).toEqual([100, 200]);
  });

  it('rejects unexpected mime types after normalization', async () => {
    const agent = createAgent();
    const pool = agent.get('https://allowed.example');

    pool.intercept({ path: '/rss', method: 'GET' }).reply(200, '<rss />', {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    });

    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async () => {},
      jitter: () => 0,
    });

    await expect(
      client.getText('https://allowed.example/rss', {
        sourceId: 'vmz_rss',
        timeoutMs: 250,
        maxBytes: 1024,
        expectedMimeTypes: ['text/html'],
      }),
    ).rejects.toThrow(/unexpected mime/i);
  });

  it('rejects responses whose content-length exceeds the configured limit', async () => {
    const agent = createAgent();
    const pool = agent.get('https://allowed.example');

    pool.intercept({ path: '/large-header', method: 'GET' }).reply(200, 'abcd', {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '4',
      },
    });

    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async () => {},
      jitter: () => 0,
    });

    await expect(
      client.getBytes('https://allowed.example/large-header', {
        sourceId: 'vbn_realtime',
        timeoutMs: 250,
        maxBytes: 3,
        expectedMimeTypes: ['application/octet-stream'],
      }),
    ).rejects.toThrow(/content-length/i);
  });

  it('rejects streamed bodies that exceed the configured byte limit', async () => {
    const agent = createAgent();
    const pool = agent.get('https://allowed.example');

    pool.intercept({ path: '/large-stream', method: 'GET' }).reply(200, 'abcdef', {
      headers: {
        'content-type': 'application/octet-stream',
      },
    });

    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async () => {},
      jitter: () => 0,
    });

    await expect(
      client.getBytes('https://allowed.example/large-stream', {
        sourceId: 'vbn_realtime',
        timeoutMs: 250,
        maxBytes: 3,
        expectedMimeTypes: ['application/octet-stream'],
      }),
    ).rejects.toThrow(/byte limit/i);
  });

  it('follows redirects up to three hops and validates redirect hosts', async () => {
    const agent = createAgent();
    const pool = agent.get('https://allowed.example');

    pool.intercept({ path: '/one', method: 'GET' }).reply(302, '', {
      headers: { location: 'https://allowed.example/two' },
    });
    pool.intercept({ path: '/two', method: 'GET' }).reply(302, '', {
      headers: { location: '/three' },
    });
    pool.intercept({ path: '/three', method: 'GET' }).reply(200, 'done', {
      headers: { 'content-type': 'text/plain' },
    });

    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async () => {},
      jitter: () => 0,
    });

    const response = await client.getText('https://allowed.example/one', {
      sourceId: 'bsag',
      timeoutMs: 250,
      maxBytes: 1024,
      expectedMimeTypes: ['text/plain'],
    });

    expect(response.text).toBe('done');
    expect(response.url).toBe('https://allowed.example/three');
    expect(response.redirectCount).toBe(2);
  });

  it('rejects redirects that leave the allow-listed host or exceed three hops', async () => {
    const agent = createAgent();
    const allowedPool = agent.get('https://allowed.example');
    const deniedPool = agent.get('https://denied.example');

    allowedPool.intercept({ path: '/escape', method: 'GET' }).reply(302, '', {
      headers: { location: 'https://denied.example/blocked' },
    });
    deniedPool.intercept({ path: '/blocked', method: 'GET' }).reply(200, 'nope', {
      headers: { 'content-type': 'text/plain' },
    });

    allowedPool.intercept({ path: '/hop1', method: 'GET' }).reply(302, '', {
      headers: { location: '/hop2' },
    });
    allowedPool.intercept({ path: '/hop2', method: 'GET' }).reply(302, '', {
      headers: { location: '/hop3' },
    });
    allowedPool.intercept({ path: '/hop3', method: 'GET' }).reply(302, '', {
      headers: { location: '/hop4' },
    });
    allowedPool.intercept({ path: '/hop4', method: 'GET' }).reply(302, '', {
      headers: { location: '/hop5' },
    });

    const client = new SourceHttpClient({
      allowedHost: 'allowed.example',
      dispatcher: agent,
      logger: createLogger(),
      sleeper: async () => {},
      jitter: () => 0,
    });

    await expect(
      client.getText('https://allowed.example/escape', {
        sourceId: 'bsag',
        timeoutMs: 250,
        maxBytes: 1024,
        expectedMimeTypes: ['text/plain'],
      }),
    ).rejects.toThrow(/redirect host/i);

    await expect(
      client.getText('https://allowed.example/hop1', {
        sourceId: 'bsag',
        timeoutMs: 250,
        maxBytes: 1024,
        expectedMimeTypes: ['text/plain'],
      }),
    ).rejects.toThrow(/too many redirects/i);
  });
});
