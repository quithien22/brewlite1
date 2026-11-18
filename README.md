# BrewLite – Ứng dụng đặt cà phê không dùng tiền mặt

Thực hiện theo quy trình **Agile Scrum**.

> **Product Vision:** BrewLite giúp khách hàng đặt và thanh toán đồ uống không dùng tiền mặt chỉ trong vài chạm, giảm thời gian xếp hàng và nhận đơn nhanh tại quầy.

MVP đi từ **chọn sản phẩm → giỏ hàng → đăng nhập → thanh toán → xác nhận đơn**.

## Công nghệ

| Thành phần | Công nghệ |
|---|---|
| Frontend | Next.js (App Router), React, TypeScript, TailwindCSS, Zustand |
| Backend | NestJS (TypeScript), REST, class-validator, JWT (Passport), bcrypt |
| CSDL | PostgreSQL + Prisma |
| Thanh toán | Mock payment gateway (mô phỏng MoMo / VNPay) |
| DevOps | Docker Compose, Git |

```
Next.js (:3000)  ──REST/JSON──▶  NestJS (:4000)  ──Prisma──▶  PostgreSQL (:5432)
                                      │
                                      └──▶ Mock Payment Gateway
```

## Cấu trúc thư mục

```
brewlite/
├── backend/               # NestJS REST API  → xem backend/README.md
│   ├── prisma/            # schema.prisma, seed.ts
│   └── src/
│       ├── auth/          # đăng ký, đăng nhập, JWT guard
│       ├── products/      # menu, chi tiết sản phẩm
│       ├── promotions/    # mã giảm giá
│       ├── orders/        # tạo đơn, state machine, tồn kho
│       └── payments/      # thanh toán idempotent + mock gateway
├── frontend/              # Next.js            → xem frontend/README.md
│   ├── app/               # các route (page.tsx chỉ ghép view)
│   ├── components/        # views, ui, auth, product
│   ├── lib/               # gọi API, kiểu dữ liệu, tiện ích
│   └── store/             # Zustand: giỏ hàng, phiên đăng nhập
├── docker-compose.yml     # chạy cả frontend + backend + DB
├── .env.example           # biến môi trường mẫu (backend + frontend)
└── README.md
```

## Yêu cầu cài đặt

- Node.js 22+ và npm
- Docker Desktop (để chạy PostgreSQL hoặc chạy toàn bộ hệ thống)

## Cách 1 – Chạy bằng Docker (khuyến nghị để demo)

```bash
docker compose up --build
```

| Dịch vụ | Địa chỉ |
|---|---|
| Frontend | http://localhost:3000 |
| Backend | http://localhost:4000 |
| PostgreSQL | localhost:5432 (user/password/db: `brewlite`) |

Lần đầu chạy, backend tự tạo bảng và nạp dữ liệu mẫu. Tắt hệ thống: `docker compose down` (thêm `-v` nếu muốn xóa cả dữ liệu).

## Cách 2 – Chạy thủ công (khi phát triển)

**1) Database**

```bash
docker compose up -d db
```

**2) Backend** (cổng 4000)

```bash
cd backend
cp ../.env.example .env
npm install
npx prisma generate
npx prisma db push      # tạo bảng
npm run seed            # nạp menu, topping, khuyến mãi, tài khoản demo
npm run start:dev
```

Kiểm tra: `GET http://localhost:4000/` → `{ "message": "Hello BrewLite", "status": "ok" }`

**3) Frontend** (mở terminal khác, cổng 3000)

```bash
cd frontend
cp ../.env.example .env.local     # chỉ cần giữ dòng NEXT_PUBLIC_API_URL
npm install
npm run dev
```

**Xem dữ liệu bằng giao diện:** `cd backend && npx prisma studio`

## Tài khoản & mã demo

| Vai trò | Email | Mật khẩu |
|---|---|---|
| Khách hàng (120 điểm thưởng) | `demo@brewlite.vn` | `Demo1234` |
| Nhân viên quầy (phần mở rộng) | `staff@brewlite.vn` | `Staff1234` |

Mã khuyến mãi: `CHAO10`, `GIAM15K`, `COMBO20`.

> Chức năng nhân viên/barista nằm ngoài phạm vi MVP. Cập nhật tiến độ đơn bằng `PATCH /orders/:id/status` với token của tài khoản STAFF; trang chi tiết đơn của khách tự làm mới mỗi 8 giây.

## Luồng nghiệp vụ chính

1. Khách xem menu, chọn sản phẩm (size, topping) và thêm vào giỏ hàng.
2. Xem giỏ, áp mã giảm giá / dùng điểm thưởng; đăng nhập nếu chưa.
3. Thanh toán không tiền mặt (Ví hoặc Thẻ):
   - Thành công → đơn `PAID`, hiển thị mã đơn và màn hình xác nhận.
   - Thất bại → đơn `PAYMENT_FAILED`, giỏ hàng được giữ nguyên để thử lại hoặc hủy.
4. Xem lịch sử và trạng thái đơn: `PAID → PREPARING → READY → COMPLETED`.

Ở bước thanh toán có tùy chọn "Chế độ demo" để mô phỏng thanh toán lỗi.

## API chính

| Method | Endpoint | Chức năng | Auth |
|---|---|---|---|
| GET | `/products`, `/products/:id` | Menu, chi tiết sản phẩm | – |
| POST | `/auth/register`, `/auth/login` | Đăng ký, đăng nhập (trả JWT) | – |
| GET | `/promotions` | Khuyến mãi đang chạy | – |
| POST | `/promotions/validate` | Kiểm tra mã giảm giá | – |
| POST | `/orders` | Tạo đơn `PENDING` từ giỏ hàng | JWT |
| GET | `/orders/me` | Lịch sử đơn của user | JWT |
| GET | `/orders/:id` | Chi tiết đơn | JWT |
| POST | `/orders/:id/cancel` | Hủy đơn | JWT |
| POST | `/payments` | Thanh toán (bắt buộc header `Idempotency-Key`) | JWT |

Danh sách đầy đủ xem `backend/README.md`.

## Đối chiếu 10 task của đề bài

| # | Task | Sprint | Vị trí |
|---|---|---|---|
| 1 | Khởi tạo dự án, README, `.env.example`, Git | 1 | thư mục gốc, `backend/`, `frontend/` |
| 2 | API danh sách sản phẩm | 1 | `GET /products` |
| 3 | Trang Menu | 1 | `/menu` |
| 4 | Chi tiết & tùy chọn sản phẩm | 1 | `/menu/[id]` |
| 5 | Giỏ hàng | 2 | `/cart`, `frontend/store/cart.ts` |
| 6 | API tạo đơn hàng | 2 | `POST /orders` |
| 7 | Đăng ký / Đăng nhập JWT | 2 | `/auth/*`, `/login`, `/register` |
| 8 | Thanh toán không tiền mặt (mock) | 3 | `POST /payments`, `/checkout` |
| 9 | Xác nhận, lịch sử đơn, bàn giao | 3 | `/orders/*`, `GET /orders/me`, `docker-compose.yml` |
| 10 | Nghiệp vụ backend nâng cao | 3 | xem bảng dưới |

### Task 10 – nghiệp vụ backend

| Yêu cầu | Cài đặt |
|---|---|
| Order State Machine (chặn chuyển trạng thái sai) | `backend/src/orders/order-state-machine.ts`, `order-transitions.ts` |
| Thanh toán idempotent (`Idempotency-Key`) | `backend/src/payments/payments.service.ts` |
| Kiểm soát tồn kho khi đặt đồng thời (transaction + optimistic locking) | `backend/src/orders/inventory.ts` |
| Khuyến mãi & điểm thưởng (1 điểm = 500đ; +1 điểm / 10.000đ, cộng đúng 1 lần khi `PAID`) | `backend/src/promotions/*`, `backend/src/common/pricing.ts` |

Sơ đồ trạng thái đơn hàng:

```
PENDING ──thanh toán OK──▶ PAID ──▶ PREPARING ──▶ READY ──▶ COMPLETED
   │                         │
   ├──thanh toán lỗi──▶ PAYMENT_FAILED ──thử lại──▶ PENDING / PAID
   └──hủy─────────────────┴──hủy──▶ CANCELLED
```

`COMPLETED` và `CANCELLED` là trạng thái kết thúc.

## Kiểm thử

```bash
cd backend
npx prisma generate
npm test
```

| File test | Chứng minh |
|---|---|
| `order-state-machine.spec.ts` | (a) Chặn mọi chuyển trạng thái sai |
| `payments.service.spec.ts` | (b) Gửi lại cùng `Idempotency-Key` chỉ tạo 1 giao dịch |
| `inventory.spec.ts` | (c) Đặt đồng thời không vượt tồn kho |
| `promotions.service.spec.ts` | Tính giảm giá (%, cố định, trần) |

## Definition of Done

- Code chạy được, không lỗi build, đúng tiêu chí chấp nhận của task.
- Có commit Git với mô tả rõ ràng, được review trong nhóm.
- API validate đầu vào; UI xử lý trạng thái loading / lỗi cơ bản.
- Có hướng dẫn chạy trong README.