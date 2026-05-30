# jump-access

Jump Server UI (ตามดีไซน์ไฟล์ `novnc-jumpserver.html`) พร้อม:

- เพิ่ม / ลบ / แก้ไข Static IP targets
- Import / Export targets ผ่าน JSON
- VNC remote ผ่าน noVNC + websockify (auto-generate token)
- RDP remote desktop ผ่าน guacd + guacamole-lite (Windows local/domain, Linux xrdp)
- SSH terminal ผ่าน WebSocket bridge (ไม่ต้องใช้ ttyd)
- SSH keepalive + idle timeout ปรับได้ (default 15 นาที)
- SSH session recording + หน้า Reports (terminal replay, keystroke log, timeline)
- Docker Compose แบบ image เดียว (Node app + websockify)

## โครงสร้างหลัก

- `public/` - หน้า UI หลักและ SSH terminal page
- `server.js` - API, token manager, websockify reverse proxy, SSH bridge
- `novnc/` - noVNC 1.7.0-beta static files
- `data/targets.json` - รายการ Static IP
- `data/tokens.cfg` - token map สำหรับ websockify
- `docker-compose.yml` - รันทั้งระบบ
- `.env.example` - ตัวอย่างตัวแปร environment (คัดลอกเป็น `.env`)
- `lib/ssh-recorder.js` - บันทึก SSH session (cast + keystroke)
- `public/reports.html` - หน้า replay / audit SSH
- `data/ssh-recordings/` - ที่เก็บ recording (ไม่ commit ข้อมูลจริง)

## Environment variables (`.env`)

คัดลอกไฟล์ตัวอย่างแล้วแก้ค่าตามสภาพแวดล้อม:

```bash
cp .env.example .env          # Linux / macOS
copy .env.example .env        # Windows (cmd)
```

ไฟล์ `.env` ถูก gitignore แล้ว — อย่า commit รหัสผ่านหรือ secret จริง

### ตัวแปรหลัก

| ตัวแปร | Default | คำอธิบาย |
|--------|---------|----------|
| `PORT` | `8080` | พอร์ต HTTP ของ Jump UI / API |
| `DATA_DIR` | `./data` (local) / `/data` (Docker) | โฟลเดอร์เก็บ `targets.json`, `tokens.cfg` |
| `APP_USER` | `admin` | ชื่อผู้ใช้ login หน้า Jump |
| `APP_PASS` | `password` | รหัสผ่าน login (เปลี่ยนก่อนใช้งานจริง) |
| `APP_SECRET` | สุ่มใหม่ทุกครั้งที่รัน | Secret สำหรับ session cookie — ควรตั้งค่าคงที่ใน production |
| `WEBSOCKIFY_TARGET` | `http://127.0.0.1:6080` | URL ของ websockify ภายใน container |
| `TOKEN_TTL_MS` | `21600000` (6 ชม.) | อายุ VNC token (มิลลิวินาที) |
| `GUACD_HOST` | `127.0.0.1` | โฮสต์ guacd สำหรับ RDP |
| `GUACD_PORT` | `4822` | พอร์ต guacd |
| `GUACAMOLE_WS_PORT` | `4824` | พอร์ต WebSocket ภายในของ guacamole-lite |
| `GUACAMOLE_CRYPT_KEY` | จาก `APP_SECRET` | คีย์เข้ารหัส token RDP — **ต้องยาว 32 ตัวอักษร** ถ้าตั้งเอง |

### SSH (optional)

| ตัวแปร | Default | คำอธิบาย |
|--------|---------|----------|
| `SSH_DEFAULT_IDLE_TIMEOUT_MS` | `900000` (15 นาที) | idle timeout เริ่มต้นในหน้า UI |
| `SSH_MIN_IDLE_TIMEOUT_MS` | `60000` | ค่าต่ำสุดที่ UI อนุญาต |
| `SSH_MAX_IDLE_TIMEOUT_MS` | `43200000` (12 ชม.) | ค่าสูงสุดที่ UI อนุญาต |
| `SSH_KEEPALIVE_INTERVAL_MS` | `20000` | ช่วงส่ง keepalive |
| `SSH_KEEPALIVE_COUNT_MAX` | `4` | ครั้งที่ไม่ตอบก่อนตัดการเชื่อมต่อ |
| `SSH_READY_TIMEOUT_MS` | `15000` | รอ SSH handshake สูงสุด |
| `SSH_RECORD_ENABLED` | `true` | เปิด/ปิดบันทึก SSH session |
| `SSH_RECORD_DIR` | `DATA_DIR/ssh-recordings` | โฟลเดอร์เก็บ recording |

รายละเอียดและค่าตัวอย่างครบอยู่ใน [.env.example](.env.example)

## รันด้วย Docker

```bash
cp .env.example .env    # แก้ APP_PASS, APP_SECRET ก่อน production
docker compose up --build -d
```

Docker Compose อ่าน `.env` จากโฟลเดอร์โปรเจกต์เพื่อส่งค่าเข้า container (ดู `docker-compose.yml`)

เปิดใช้งาน:

- `http://localhost:8080`

## โหมดการทำงาน

1. VNC mode
- ใส่ `IP` + `Port` (default 5900)
- กด Connect
- backend จะสร้าง token ให้เองอัตโนมัติ
- noVNC เชื่อมผ่าน `/websockify/?token=...`

2. RDP mode (Remote Desktop)
- หน้า replay ปรับขนาด terminal อัตโนมัติตามกรอบ (`resize-method: display-update`)
- ปุ่ม **Pop Out** เปิด session ในหน้าต่างใหม่ (ปิด iframe เดิมก่อน เพื่อไม่ให้ RDP สอง connection)
- ใส่ `IP` + `Port` (default 3389)
- ต้องใส่ `Username` + `Password`
- Windows local: เลือก **Local account**
- Windows domain: เลือก **Domain account** แล้วใส่ชื่อ Domain (เช่น `CORP`)
- Linux desktop: ต้องเปิด RDP service บนเครื่องปลายทาง (เช่น `xrdp` บน Ubuntu)
- กด Connect เพื่อเปิด HTML5 RDP session

3. SSH mode
- ใส่ `IP` + `Port` (default 22)
- ต้องใส่ `Username`
- ใส่ `Password` หรือ `Private Key` อย่างน้อยหนึ่งอย่าง
- นำเข้า private key ได้ด้วยปุ่ม **Import** (รองรับ `.pem`, `.key`, OpenSSH/RSA PEM)
- ถ้า private key มี passphrase ให้ใส่ passphrase ในช่อง Password
- ตั้งค่า `SSH Idle Timeout (minutes)` ได้ (1-240 นาที)
- กด Connect เพื่อเปิด Web SSH terminal

## RDP / guacd (container เดียวกัน)

- รัน `guacd` + `guacamole-lite` ภายใน container เดียวกับ Node app
- ตั้งค่าใน `.env`: `GUACD_HOST`, `GUACD_PORT`, `GUACAMOLE_CRYPT_KEY`, `GUACAMOLE_WS_PORT`

## SSH session recording & reports

เมื่อ `SSH_RECORD_ENABLED=true` (ค่า default) ทุก SSH session จะถูกบันทึกอัตโนมัติลง `SSH_RECORD_DIR` (default: `DATA_DIR/ssh-recordings`) แยกโฟลเดอร์ตาม **ปี/เดือน/วัน**

### โครงสร้างไฟล์

```
ssh-recordings/
  index.json                          # ดัชนี session สำหรับหน้า Reports
  2026/05/30/20260530-143022-a1b2c3/
    meta.json                         # host, user, port, label, เวลาเริ่ม/จบ, duration
    session.cast                      # terminal replay (asciinema v2, เฉพาะ output)
    keys.jsonl                        # keystroke ทีละบรรทัด { "t": วินาที, "keys": "..." }
```

| ไฟล์ | รายละเอียด |
|------|------------|
| `session.cast` | บันทึก **output จาก SSH** เท่านั้น (ไม่รวม input ซ้ำกับ echo) — ไฟล์เล็ก เล่นย้อนหลังบน terminal ได้ |
| `keys.jsonl` | log การกดคีย์แยกต่างหาก สำหรับ audit |
| `meta.json` | metadata หลัง session จบ |

> ใช้รูปแบบ **asciinema cast** แทนวิดีโอ MP4 เพื่อประหยัดพื้นที่และอ่านข้อความใน terminal ได้ชัด

### หน้า Reports

เปิดที่ **http://localhost:8080/reports.html** หรือปุ่ม **Reports** บนแถบด้านบนของหน้าหลัก (ต้อง login)

| ฟีเจอร์ | คำอธิบาย |
|---------|----------|
| กรองปี/เดือน | โหลดรายการ session ตามช่วงเวลา |
| Terminal replay | พื้นที่เต็มจอ — Play / Pause / Reset / ปรับความเร็ว |
| Timeline ด้านล่าง | แถบเวลา + ลาก seek — จุดสีเขียว = ตำแหน่งที่มี keystroke (hover ดูคีย์) |
| Sidebar (จอแคบ) | กดปุ่ม ☰ เพื่อเปิดรายการ session แบบ drawer ไม่บังหน้า replay |

### API (ต้อง login)

| Method | Path | คำอธิบาย |
|--------|------|----------|
| `GET` | `/api/ssh-recordings/report?year=2026&month=5` | รายการ session แยกตามวัน |
| `GET` | `/api/ssh-recordings/:sessionId` | metadata |
| `GET` | `/api/ssh-recordings/:sessionId/cast` | ไฟล์ replay |
| `GET` | `/api/ssh-recordings/:sessionId/keys` | keystroke log (JSON) |

### หมายเหตุการบันทึก

- **Replay ไม่พิมพ์ซ้ำ:** `session.cast` เก็บเฉพาะ output จาก server (รวม echo ของคำสั่ง) — keystroke อยู่ใน `keys.jsonl` เท่านั้น
- Recording เก่าที่มี event ประเภท `i` ใน cast จะถูกเล่นเฉพาะ `o` ในหน้า Reports
- Session ใหม่หลังอัปเดตจะไม่มีปัญหาตัวอักษรซ้ำ (`ssuuddoo` ฯลฯ)
- ข้อมูล recording **อาจมีรหัสผ่าน** ที่พิมพ์ใน terminal — จำกัดสิทธิ์ login และ backup โฟลเดอร์ `ssh-recordings` ตามนโยบายองค์กร
- โฟลเดอร์ `data/ssh-recordings/**` ถูก gitignore (เก็บเฉพาะ `.gitkeep` ใน repo)

### ปิดการบันทึก

```env
SSH_RECORD_ENABLED=false
```

## SSH Timeout / Keepalive

- ค่า default idle timeout: `15 นาที` (`SSH_DEFAULT_IDLE_TIMEOUT_MS`)
- ปรับค่าได้จากหน้า UI ก่อน Connect (ค่าเดิมจะถูกจำไว้ใน browser)
- ปรับขอบเขตและ keepalive ฝั่ง server ใน `.env` (ดูตารางด้านบน)

## Import / Export JSON

- Export: กดปุ่ม `Export JSON`
- Import: กดปุ่ม `Import JSON`
  - รองรับไฟล์รูปแบบ array ตรง ๆ หรือ object ที่มี `targets`
  - เลือกได้ว่าจะ replace ทั้งหมด หรือ merge

ตัวอย่าง JSON:

```json
{
  "targets": [
    {
      "name": "Win11-Office-01",
      "ip": "192.168.1.120",
      "port": 5900,
      "proto": "VNC",
      "user": "",
      "pass": ""
    },
    {
      "name": "Win11-Office",
      "ip": "192.168.1.50",
      "port": 3389,
      "proto": "RDP",
      "user": "Administrator",
      "pass": "secret",
      "domain": "CORP",
      "authMode": "domain"
    },
    {
      "name": "Ubuntu-Desktop",
      "ip": "10.0.10.20",
      "port": 3389,
      "proto": "RDP",
      "user": "ubuntu",
      "pass": "secret",
      "authMode": "local"
    },
    {
      "name": "Ubuntu-DB",
      "ip": "10.0.10.15",
      "port": 22,
      "proto": "SSH",
      "user": "admin",
      "pass": "",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
    }
  ]
}
```

## Local run (ไม่ใช้ Docker)

```bash
cp .env.example .env    # ตั้ง DATA_DIR=./data และเปลี่ยน APP_PASS / APP_SECRET
npm install
npm start
```

`npm start` โหลด `.env` ผ่าน [dotenv](https://github.com/motdotla/dotenv) อัตโนมัติ

จากนั้นเปิด `http://localhost:8080`

> Local run ต้องมี websockify และ guacd แยกต่างหาก หรือชี้ `WEBSOCKIFY_TARGET` / `GUACD_*` ไปยังบริการที่รันอยู่แล้ว — แนะนำใช้ Docker Compose สำหรับ stack ครบชุด

## หมายเหตุ

- เหมาะกับสภาพแวดล้อม DHCP จำนวนมาก: ใส่ IP แล้ว connect ได้ทันที
- ไม่ต้องสร้าง VNC token เอง
- token มีอายุ 6 ชั่วโมง (ตั้งค่าได้ผ่าน `TOKEN_TTL_MS` ใน `.env`)
