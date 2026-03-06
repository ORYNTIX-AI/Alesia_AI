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
