# Nginx deployment — api.romduolscholars.com

Companion to `romduol-web/DEPLOY_NGINX.md`, which covers the Vue frontend on
the same server. This one is the API: nginx terminates TLS and proxies to the
Node process, which listens on `127.0.0.1:5000` and is never exposed directly.

Two things here are easy to get wrong and both break features silently:

- **Socket.IO** (live classes) needs the connection-upgrade headers. Without
  them HTTP works fine and live classes simply never connect.
- **Uploads** are capped at 50 MB by multer, and nginx's own default is 1 MB,
  so a teacher's video upload fails at the proxy before it reaches the app.

## Recovering from "connection refused" on 443

Symptoms: `curl https://api.romduolscholars.com` can't connect, port 80 serves
the stock "Welcome to nginx" page, and every path returns nginx's own 404.
That means nginx is running with no site enabled — the config below is missing,
or a certificate failed to renew and nginx dropped the SSL block.

```bash
sudo nginx -T | grep -c server_name      # 0 means no site loaded
ls -l /etc/nginx/sites-enabled/          # expect api + web, not just `default`
sudo certbot certificates                # look for EXPIRED
pm2 list                                 # or: systemctl status lms-backend
curl -s localhost:5000/api/app-version   # is the app itself up?
```

Work outwards: get the app answering on `localhost:5000` first, then nginx on
80, then TLS. Diagnosing in that order avoids chasing a certificate problem
when the Node process is simply stopped.

## Server block

`/etc/nginx/sites-available/api.romduolscholars.com`

```nginx
server {
    listen 443 ssl http2;
    server_name api.romduolscholars.com;

    ssl_certificate     /etc/letsencrypt/live/api.romduolscholars.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.romduolscholars.com/privkey.pem;

    # multer accepts 50 MB; nginx must not refuse it first.
    client_max_body_size 60M;

    # Large PDFs and videos stream through here.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Live classes. Same upstream, but the upgrade headers are what turn a
    # request into a long-lived WebSocket.
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_read_timeout 86400s;
    }
}

server {
    listen 80;
    server_name api.romduolscholars.com;
    return 301 https://$host$request_uri;
}
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/api.romduolscholars.com \
            /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default    # stops the placeholder page
sudo nginx -t && sudo systemctl reload nginx
```

## Certificate

If `certbot certificates` shows nothing for this domain, issue one. Port 80
must already be answering for the HTTP challenge to pass.

```bash
sudo certbot --nginx -d api.romduolscholars.com
sudo systemctl status certbot.timer     # renewals run twice daily
```

A renewal that fails for weeks is the usual reason 443 stops listening, so
check the timer is active rather than only issuing a fresh certificate.

## Keeping the app running

The process must come back by itself after a reboot — a server that recovers
only when someone remembers to log in is how an outage like this starts.

```bash
pm2 start src/server.js --name lms-backend
pm2 save && pm2 startup     # run the command it prints
```

`.env` lives in the project root on the server and is **not** in git. It needs
`NODE_ENV=production`, `PORT=5000`, the company Supabase keys, `JWT_SECRET`,
the Agora keys, and the five `TEXTBOOK_S3_*` values — without those last ones
the Library's shelves come back empty.

## Verify

```bash
curl -s https://api.romduolscholars.com/api/app-version   # JSON, not nginx 404
curl -s https://api.romduolscholars.com/api/textbooks | head -c 120
curl -I https://api.romduolscholars.com/api/auth/login    # 404/405, not refused
```

The app's own check: open it and sign in. "Can't reach the server" means 443
is still closed; a login error means it got through.
