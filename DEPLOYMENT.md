# ALesia_AI deployment (server)

## Container

- Folder: `/root/Alesia_AI`
- Compose file: `docker-compose.yml`
- Container name: `ALesia_AI`
- Local bind: `127.0.0.1:8200 -> container:3000`

Commands:

```bash
cd /root/Alesia_AI
docker compose up -d --build
docker logs -f ALesia_AI
```

Environment variables are loaded from `/.env.production.local` (file is intentionally not tracked).

## Nginx

- Site config: `/etc/nginx/sites-available/alesia-ai.constitution.of.by`
- Included from: `/etc/nginx/nginx.conf`

## TLS (important)

Let’s Encrypt does **not** issue certificates for hostnames that contain underscores.

For production HTTPS, use a hostname without underscores, for example `alesia-ai.constitution.of.by`, or issue a wildcard cert (DNS-01) for `*.constitution.of.by`.

## Safe rollout and rollback

Runtime settings are stored in `/app/data/app-config.json` (host path: `./runtime-data/app-config.json`).

New safety controls:

- `safetySwitches.safeSpeechFlowEnabled`:
  - `true` - safer anti-cutoff speech flow enabled.
  - `false` - fallback to legacy speech flow.
- `speechStabilityProfile`: `legacy` | `balanced` | `strict`.
- `prayerReadMode`: `knowledge-only` | `hybrid` | `free`.

Recommended phased rollout:

1. Keep `safeSpeechFlowEnabled: true` and `speechStabilityProfile: balanced` on staging.
2. Validate the demo script.
3. Promote same config to production.

Fast rollback without rebuild:

1. Set `safeSpeechFlowEnabled` to `false` and `speechStabilityProfile` to `legacy` in app config.
2. Restart container: `docker compose up -d`.

Config snapshots are auto-saved to `runtime-data/safety-snapshots/`.
