# BSAG Internal Operations Intelligence MCP Server

An MVP for internal operations staff that combines public BSAG/VBN service information, VBN GTFS-Realtime observations, VMZ Bremen traffic impacts, and Bremen event information (Currently only avilable on stdio runs not in cloud run because Google Cloud egress IPs are blocked or challenged by their WAF / bot protection). The server identifies service risk for BSAG bus and tram lines, explains the evidence behind each assessment, and drafts concise passenger information.

This MVP uses only publicly available data sources. A future version with secure access to internal BSAG data sources and automated workflows would deliver significant productivity gains and day-to-day convenience for operations staff — significatly reducing manual effort, saving time while producing more reliable results.

## What this MVP includes

- realtime line health for BSAG services, backed by VBN GTFS-Realtime delay and coverage evidence
- external impact detection from VMZ Bremen roadworks, traffic notices, and Bremen event listings
- service notice lookup across BSAG and VBN sources by line and stop context
- corridor-level shift brief generation with explainable operational risk signals
- passenger-information draft generation for concise public-facing disruption messaging
- With ecitations, status, source freshness, and warnings when a public source is stale, unavailable, or only partially parsed.

## Requirements

- Node 22
- npm
- Optional: Docker

## Install and build

```bash
npm ci
npm run build
```

## For local Run over stdio

```bash
cp .env.example .env
node --env-file=.env dist/transports/stdio.js
```

Example client configuration:

```json
{
  "mcpServers": {
    "bsag-briefing": {
      "command": "node",
      "args": ["/absolute/path/to/BSAG-MCP/dist/transports/stdio.js"],
      "env": { "BSAG_MCP_DATA_DIR": "/absolute/path/to/data" }
    }
  }
}
```

Tested with the official MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/transports/stdio.js
```

## Google Cloud Run over Streamable HTTP

Email : mupa@uni-bremen.de

## Tool examples and test prompts

The Bremen details were selected from public web sources checked on 2026-06-22,
so refresh the dates if the upstream notices have expired:

The bundled route map translates common BSAG public line labels to the static
GTFS `routeId` values used by VBN GTFS-Realtime. If a caller supplies an
unmapped public label, the tool returns `ROUTE_MAPPING_UNAVAILABLE` instead of
inferring a disruption or a clean line. Direct GTFS route IDs are still accepted.



1. Prompt: Compare the central Bremen tram lines visible around Hauptbahnhof
   and Domsheide on the BSAG Tagesnetz: 1, 4, 6, and 8. Main tool tested:
   `get_line_health`.

   ```json
   { "line_ids": ["1", "4", "6", "8"] }
   ```

2. Prompt: Build the east-corridor morning brief for 2026-06-22 with comms
   drafts, focusing on realtime, BSAG/VBN notices, and the Steubenstraße,
   Vahrer Straße, and Hastedter Heerstraße VMZ works. Main tool tested:
   `build_shift_brief`.

   ```json
   {
     "date": "2026-06-22",
     "corridors": ["east"],
     "include_comms_draft": true
   }
   ```

3. Prompt: Find notices touching Universität-Nord and Bf Sebaldsbrück, two
   stop names present in the BSAG network material and current VBN notices.
   Main tool tested: `get_service_notices`.

   ```json
   {
     "stop_names": ["Universität-Nord", "Bf Sebaldsbrück"],
     "since": "2026-04-01T00:00:00+02:00"
   }
   ```

4. Prompt: For 2026-06-21, list external VMZ and event impacts on the east
   corridor around Steubenstraße, Vahrer Straße, and Hastedter Heerstraße.
   Main tool tested: `get_external_impacts`.

   ```json
   { "corridors": ["east"], "date_from": "2026-06-21", "date_to": "2026-06-21" }
   ```

5. Prompt: Build the west-corridor shift brief for 2026-06-22 without comms
   drafts, checking realtime, BSAG/VBN notices, Walle and Gröpelingen impacts,
   and VBN's Steffensweg line-20 notice. Main tool tested:
   `build_shift_brief`.

   ```json
   {
     "date": "2026-06-22",
     "corridors": ["west"],
     "include_comms_draft": false
   }
   ```

6. Prompt: Check current realtime health for BSAG lines 6 and 10. Main tool
   tested: `get_line_health`.

   ```json
   { "line_ids": ["6", "10"] }
   ```

7. Prompt: Show notices since 2026-06-15 for BSAG lines 1 and N1; VBN lists
   night replacement buses for track works between Kurt-Huber-Straße and
   Nußhorn. Main tool tested: `get_service_notices`.

   ```json
   { "line_ids": ["1", "N1"], "since": "2026-06-15T00:00:00+02:00" }
   ```

8. Prompt: Build a central and north Bremen brief for 2026-10-03 with comms
   drafts enabled, checking realtime, BSAG/VBN notices, and any
   corridor-matched Bremen.de or VMZ impacts for the Tag der Deutschen Einheit
   weekend. Main tool tested: `build_shift_brief`.

   ```json
   {
     "date": "2026-10-03",
     "corridors": ["central", "north"],
     "include_comms_draft": true
   }
   ```
9. Prompt: Check the west corridor on 2026-06-19, including Alte Waller
   Straße and Waller See, for current VMZ roadworks. Main tool tested:
   `get_external_impacts`.

   ```json
   { "corridors": ["west"], "date_from": "2026-06-19", "date_to": "2026-06-19" }
   ```

### `draft_passenger_information`

This tool does not fetch sources itself. Provide an `issue_summary` by copying
or paraphrasing the relevant details from VBN notices, BSAG news, or any other
public source, and the tool will produce ready-to-publish passenger copy in the
requested format and channel (app, web, stop, etc.) .

> **Note:** In the current read-only server configuration, this tool operates
> as a drafting aid — output must be reviewed and published manually. Its full
> potential is realised in a write-enabled MCP workflow: paired with human-in-the-loop
> approval step, it can drive an end-to-end
> communications pipeline from incident detection through to passenger
> notification, with a human reviewing and approving each draft before it goes
> live.

10. Prompt: Draft an app update for line 2 passengers: VBN says line 2 is
    diverted from 8 to 29 June 2026 because of track work; Lloydstraße and
    Doventor are not served and Doventorsteinweg is served instead.

```json
{
  "line_ids": ["2"],
  "issue_summary": "From 8 June 2026, 03:00, to 29 June 2026, 03:00, line 2 is diverted between Hansator and Radio Bremen via Haferkamp (platform A) and Doventorsteinweg because of track work. Lloydstraße and Doventor are not served; Doventorsteinweg is additionally served.",
  "channel": "app"
}
```

## Live smoke checks

The live suite is opt-in and never runs in normal CI:

```bash
npm run test:live
```

It fetches the configured official source URLs and only asserts transport/parser invariants. It prints per-source status without logging response bodies.

## Environment variables

Key runtime variables:

- `BSAG_MCP_DATA_DIR`: writable directory for SQLite storage; the server stores `bsag.sqlite` inside it
- `CORRIDORS_PATH`: corridor mapping JSON, default packaged `config/corridors.json` beside the installed binaries
- `LINE_ROUTE_MAP_PATH`: public line label to GTFS route ID mapping JSON, default packaged `config/line-route-map.json`
- `HTTP_HOST`: bind host for HTTP mode, default `127.0.0.1`
- `HTTP_PORT`: bind port for HTTP mode, default `3000`
- `PORT`: fallback bind port when `HTTP_PORT` is unset; used by Cloud Run
- `HTTP_BEARER_TOKEN`: required when `HTTP_HOST` is not loopback
- `HTTP_ALLOWED_ORIGINS`: comma-separated allowed exact origins or hostnames
- `RETENTION_DAYS`: SQLite retention for realtime snapshots, default `30`
- `REALTIME_REFRESH_INTERVAL_SECONDS`: GTFS-Realtime reuse window, default `300`

The server does not auto-load `.env`; use Node's `--env-file` flag or export variables in the shell.

Public source URLs are also configurable; see [.env.example](.env.example).

The Bremen events source uses the public `login.bremen.de` event-search API via
`curl --http1.1` because the HTML calendar page is Cloudflare-challenged for
Node HTTP clients. The Docker image installs `curl`; non-Docker hosts should
provide it on `PATH`.



More deployment and operations detail lives in [docs/operations.md](docs/operations.md).
