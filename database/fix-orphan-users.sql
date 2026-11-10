-- XỬ LÝ TÀI KHOẢN "MỒ CÔI": dòng trong users nhưng KHÔNG có role nào (vd. số 0384837357 gây lỗi users_phone_unique).
-- Chạy TỪNG PHẦN thủ công trong pgAdmin (Query Tool). File này KHÔNG tự sửa dữ liệu nếu bạn chỉ chạy phần 1.

-- 1) XEM: các user không có role nào, và các user có số điện thoại nhưng không phải khách hàng
SELECT u.user_id, u.email, u.full_name, u.phone, u.status, u.created_at,
       COALESCE(string_agg(r.code, ','), '(không có role)') AS roles
FROM users u
LEFT JOIN user_roles ur ON ur.user_id = u.user_id
LEFT JOIN roles r ON r.role_id = ur.role_id
GROUP BY u.user_id
HAVING NOT bool_or(r.code = 'CUSTOMER')
ORDER BY u.created_at DESC;

-- 2a) GÁN role CUSTOMER cho user mồ côi mà bạn muốn giữ (đổi số điện thoại cho đúng).
--     Sau đó đăng nhập được bằng ĐÚNG email + số điện thoại đang lưu ở dòng này (xem kết quả bước 1).
-- INSERT INTO user_roles(user_id, role_id)
-- SELECT u.user_id, r.role_id FROM users u, roles r
-- WHERE u.phone = '0384837357' AND r.code = 'CUSTOMER'
--   AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.user_id);

-- 2b) Nếu dòng đó chưa có email: đặt email để đăng nhập bằng email + SĐT
-- UPDATE users SET email = 'ban@vidu.com' WHERE phone = '0384837357' AND email IS NULL;

-- 2c) Hoặc XÓA hẳn user mồ côi chưa có đặt vé/thông báo/chat/đánh giá (để đăng ký lại từ đầu)
-- DELETE FROM users u
-- WHERE u.phone = '0384837357'
--   AND NOT EXISTS (SELECT 1 FROM user_roles x     WHERE x.user_id = u.user_id)
--   AND NOT EXISTS (SELECT 1 FROM bookings b       WHERE b.user_id = u.user_id)
--   AND NOT EXISTS (SELECT 1 FROM notifications n  WHERE n.user_id = u.user_id)
--   AND NOT EXISTS (SELECT 1 FROM chat_conversations c WHERE c.user_id = u.user_id)
--   AND NOT EXISTS (SELECT 1 FROM reviews r        WHERE r.user_id = u.user_id);
