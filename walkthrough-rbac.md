# Walkthrough: Phân quyền nội bộ (RBAC)

## Files đã sửa/thêm:

1. `database/schema.sql`: Thêm bảng `permissions` và `user_permissions`.
2. `database/seed.sql`: Seed 6 quyền cơ bản (`promotions.manage`, v.v.).
3. `backend/src/middleware/permission.js`: **[MỚI]** Middleware `requirePermission(code)` (ADMIN bypass, SUPPORT check JWT).
4. `backend/src/routes/adminAuth.js`: Query DB lúc login/refresh để nhét mảng `permissions` vào JWT payload.
5. `backend/src/routes/admin.js`: Thay thế `allow('ADMIN')` cứng bằng `requirePermission(...)` cho các resource. Thêm các route quản lý nhân sự: `GET /permissions`, `GET /users`, `PATCH /users/:id/permissions`, `PATCH /users/:id/status`, nâng cấp `POST /users`.
6. `backend/src/schemas/auth.js`: Thêm `updatePermissionsSchema`, `updateStatusSchema`, update `createStaffSchema`.
7. `admin/index.html`: Thêm mục nav "Nhân viên" và 2 modal (Sửa quyền, Tạo tài khoản).
8. `admin/app.js`: Thêm luồng UI động dựa vào `user.permissions`, viết logic trang `staffPage()` gọi API thật.

## DB Migration (BẮT BUỘC):
Vì có bảng mới và seed mới, bạn cần reset DB:
```bash
docker compose down -v
docker compose up -d
```

## Cách tự test đúng kịch bản:

1. Đăng nhập vào trang Admin bằng tài khoản **ADMIN** (`admin@vietjet.local` / `Vietjet@123`).
2. Vào tab **"Nhân viên"** (Quản lý nội bộ). Bấm **"+ Tạo tài khoản"**:
   - Chọn vai trò **Nhân viên hỗ trợ (SUPPORT)**.
   - Tick chọn 2 quyền: **"Quản lý hội thoại hỗ trợ"** và **"Quản lý đánh giá"**.
   - Điền thông tin và bấm "Tạo tài khoản". Bạn sẽ nhận được mật khẩu mặc định qua Toast message.
3. Đăng xuất ADMIN, sau đó **đăng nhập bằng tài khoản SUPPORT vừa tạo** (cùng mật khẩu mặc định đó).
   - Kiểm tra thanh điều hướng (sidebar): Bạn sẽ **CHỈ** nhìn thấy mục "Tổng doanh thu", "Đánh giá" và "Hội thoại".
   - Mở Network tab, thử gọi API GET `/api/v1/admin/promotions` (hoặc cố tình click vào tab Khuyến mãi nếu bằng cách nào đó hiển thị) → Sẽ bị **403 Forbidden**.
4. Đăng xuất SUPPORT, **đăng nhập lại bằng ADMIN**.
   - Vào tab "Nhân viên", tìm tài khoản SUPPORT vừa tạo, bấm **"Sửa quyền"**.
   - Tick thêm quyền **"Quản lý khuyến mãi"** và bấm Lưu.
5. Đăng xuất ADMIN, **đăng nhập lại bằng SUPPORT**.
   - Lần này thanh điều hướng sẽ hiện thêm mục **"Khuyến mãi"**. Bạn có thể vào xem bình thường mà không bị 403 (vì permission đã được update vào JWT mới).

