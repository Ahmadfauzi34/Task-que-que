# Instalasi Fresh Task-que-que di Termux

Panduan instalasi dari nol di HP Android baru (atau setelah reset).

## Prasyarat

- Termux dari F-Droid (bukan Play Store)
- Koneksi internet
- ~200MB ruang kosong

## Langkah 1: Persiapan Termux

```bash
pkg update && pkg upgrade -y
pkg install -y git curl openssh bun nodejs
```

## Langkah 2: Download Binary

```bash
# Buat direktori
mkdir -p ~/tqq/bin ~/tqq/workers ~/tqq/gateway

# Download release terbaru dari GitHub
# Ganti v0.2.1 dengan versi terbaru
cd ~/tqq/bin
curl -LO https://github.com/Ahmadfauzi34/Task-que-que/releases/download/v0.2.1/robust-sinkhorn-queue-aarch64-android
curl -LO https://github.com/Ahmadfauzi34/Task-que-que/releases/download/v0.2.1/robust-sinkhorn-worker-aarch64-android
chmod +x robust-sinkhorn-*

# Verifikasi checksum (opsional tapi disarankan)
curl -LO https://github.com/Ahmadfauzi34/Task-que-que/releases/download/v0.2.1/robust-sinkhorn-queue-aarch64-android.sha256
sha256sum -c robust-sinkhorn-queue-aarch64-android.sha256
```

## Langkah 3: Clone Repo (untuk gateway & workers)

```bash
cd ~
git clone https://github.com/Ahmadfauzi34/Task-que-que.git tqq-src
cp -r tqq-src/gateway ~/tqq/gateway-src
cp tqq-src/workers/bun-handlers/worker-handlers.ts ~/tqq/workers/
cp tqq-src/scripts/tqq-watchdog.sh ~/tqq/bin/
chmod +x ~/tqq/bin/tqq-watchdog.sh
```

## Langkah 4: Setup Gateway

```bash
cd ~/tqq/gateway-src
bun install

# Buat token gateway (simpan baik-baik!)
head -c 32 /dev/urandom | base64 > ~/handoff-data/gateway-token
chmod 600 ~/handoff-data/gateway-token
```

## Langkah 5: Inisialisasi Database

```bash
# Daemon akan buat DB otomatis saat pertama jalan
mkdir -p ~/tqq
```

## Langkah 6: Jalankan Semua Layanan

```bash
# Cara mudah: pakai watchdog (auto-heal)
bash ~/tqq/bin/tqq-watchdog.sh start

# Cek status
bash ~/tqq/bin/tqq-watchdog.sh status
# Harus: gateway UP, daemon UP, broker UP, watchdog RUNNING
```

## Langkah 7: Setup Cloudflare Tunnel (opsional, untuk akses luar)

```bash
pkg install -y cloudflared
# Jalankan tunnel ke gateway
cloudflared tunnel --url http://127.0.0.1:3100 > ~/cf.log 2>&1 &
# Ambil URL publik
sleep 10
grep -o "https://[a-z0-9-]*\.trycloudflare\.com" ~/cf.log | head -1
# Simpan URL ini — ini alamat gateway-mu dari internet
```

## Langkah 8: Jalankan Worker

```bash
cd ~/tqq/workers
# Worker untuk 5 operasi dasar:
bun worker.ts worker-1 "hash.compute,vector.dot,document.process" &

# Worker untuk MCP (jika pakai agen MCP):
TQQ_AGENTS_JSON='{"nama-agen":"http://127.0.0.1:18080/"}' \
  bun worker.ts worker-mcp "agent.invoke,workflow.run" &
```

## Verifikasi Instalasi

```bash
# 1. Gateway sehat?
curl http://127.0.0.1:3100/readyz

# 2. Submit task test:
TOKEN=$(cat ~/handoff-data/gateway-token)
curl -X POST http://127.0.0.1:3100/v1/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: test-001" \
  -d '{"type":"hash.compute","payload":{"input":"hello"}}'

# 3. Cek watchdog:
bash ~/tqq/bin/tqq-watchdog.sh status
```

## Struktur Direktori Akhir

```
~/tqq/
├── bin/
│   ├── robust-sinkhorn-queue-*      # binary daemon
│   ├── robust-sinkhorn-worker-*     # binary broker
│   └── tqq-watchdog.sh              # supervisor
├── gateway-src/                     # source gateway (dari repo)
├── workers/
│   ├── worker.ts                    # template worker
│   └── worker-handlers.ts           # 5 handler operasi
├── queue.db                         # database (dibuat otomatis)
├── gateway.log, daemon.log, ...     # log files
└── .watchdog.pid

~/handoff-data/
└── gateway-token                    # token rahasia gateway
```

## Troubleshooting

**Gateway tidak start?**
- Cek `GATEWAY_API_TOKEN` sudah di-set (watchdog handle ini otomatis)
- Cek `GATEWAY_PORT=3100` (watchdog handle ini otomatis)
- Lihat log: `tail ~/tqq/gateway.log`

**Watchdog tidak jalan?**
- Jalankan manual: `bash ~/tqq/bin/tqq-watchdog.sh start`
- Cek log: `tail ~/tqq/watchdog.log`

**Lupa token?**
- Token ada di `~/handoff-data/gateway-token`
- Jika hilang, buat baru dan restart gateway via watchdog
