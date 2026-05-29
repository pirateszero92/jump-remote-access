# jump-access

Jump Server UI (ตามดีไซน์ไฟล์ `novnc-jumpserver.html`) พร้อม:

- เพิ่ม / ลบ / แก้ไข Static IP targets
- Import / Export targets ผ่าน JSON
- VNC remote ผ่าน noVNC + websockify (auto-generate token)
- RDP remote desktop ผ่าน guacd + guacamole-lite (Windows local/domain, Linux xrdp)
- SSH terminal ผ่าน WebSocket bridge (ไม่ต้องใช้ ttyd)
- SSH keepalive + idle timeout ปรับได้ (default 15 นาที)
- Docker Compose แบบ image เดียว (Node app + websockify)

## โครงสร้างหลัก

- `public/` - หน้า UI หลักและ SSH terminal page
- `server.js` - API, token manager, websockify reverse proxy, SSH bridge
- `novnc/` - noVNC 1.7.0-beta static files
- `data/targets.json` - รายการ Static IP
- `data/tokens.cfg` - token map สำหรับ websockify
- `docker-compose.yml` - รันทั้งระบบ

## รันด้วย Docker

```bash
docker compose up --build -d
```

ค่า default สำคัญ (container เดียว):

- `PORT=8080`
- `DATA_DIR=/data`
- `WEBSOCKIFY_TARGET=http://127.0.0.1:6080`

เปิดใช้งาน:

- `http://localhost:8080`

## โหมดการทำงาน

1. VNC mode
- ใส่ `IP` + `Port` (default 5900)
- กด Connect
- backend จะสร้าง token ให้เองอัตโนมัติ
- noVNC เชื่อมผ่าน `/websockify/?token=...`

2. RDP mode (Remote Desktop)
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
- ค่า env ที่เกี่ยวข้อง:
  - `GUACD_HOST` (default `127.0.0.1`)
  - `GUACD_PORT` (default `4822`)
  - `GUACAMOLE_CRYPT_KEY` (ต้องยาว 32 ตัวอักษร หรือปล่อยให้ derive จาก `APP_SECRET`)

## SSH Timeout / Keepalive

- ค่า default idle timeout: `15 นาที`
- ปรับค่าได้จากหน้า UI ก่อน Connect (ค่าเดิมจะถูกจำไว้ใน browser)
- ปรับค่า default ฝั่ง server ได้ผ่าน env:
  - `SSH_DEFAULT_IDLE_TIMEOUT_MS`
  - `SSH_MIN_IDLE_TIMEOUT_MS`
  - `SSH_MAX_IDLE_TIMEOUT_MS`
- SSH transport keepalive:
  - `SSH_KEEPALIVE_INTERVAL_MS` (default 20000)
  - `SSH_KEEPALIVE_COUNT_MAX` (default 4)

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
npm install
npm start
```

จากนั้นเปิด `http://localhost:8080`

## หมายเหตุ

- เหมาะกับสภาพแวดล้อม DHCP จำนวนมาก: ใส่ IP แล้ว connect ได้ทันที
- ไม่ต้องสร้าง VNC token เอง
- token มีอายุ 6 ชั่วโมง (ตั้งค่าได้ผ่าน `TOKEN_TTL_MS`)
