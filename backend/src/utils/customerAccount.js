// Logic tài khoản KHÁCH HÀNG dùng chung cho đăng nhập / đăng ký bằng Email + Số điện thoại + OTP.
// Quy ước: email đã lowercase, phone đã chuẩn hoá 0xxxxxxxxx (zod trong schemas/auth.js làm việc này trước khi vào đây).
// Nhân viên (ADMIN/SUPPORT) và khách dùng chung bảng users; chỉ user có role CUSTOMER mới là khách hàng.
const db = require('../db');

const CUSTOMER_ROLE = `EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND r.code='CUSTOMER')`;

// Các user trùng email HOẶC số điện thoại (tối đa 2 dòng). `exec` là db hoặc client của transaction.
async function findByIdentity(exec, email, phone) {
  const { rows } = await exec.query(
    `SELECT u.user_id,u.email,u.full_name,u.phone,u.status,to_char(u.date_of_birth,'YYYY-MM-DD') AS date_of_birth,u.hometown,u.national_id,u.locked_until,${CUSTOMER_ROLE} AS is_customer
     FROM users u WHERE lower(u.email)=$1 OR u.phone=$2`,
    [email, phone]
  );
  return rows;
}

const conflict = (code, message, field) => ({ status: 409, body: { code, message, ...(field ? { field } : {}) } });
const PHONE_TAKEN = () => conflict('PHONE_ALREADY_REGISTERED', 'Số điện thoại đã được đăng ký, vui lòng đăng nhập.', 'phone');
const EMAIL_TAKEN = () => conflict('EMAIL_ALREADY_REGISTERED', 'Email đã được đăng ký, vui lòng đăng nhập.', 'email');
const NOT_AVAILABLE = () => conflict('IDENTITY_NOT_AVAILABLE', 'Số điện thoại hoặc email này không thể dùng để đăng ký. Vui lòng dùng thông tin khác hoặc liên hệ hỗ trợ.');

// Email / SĐT đã bị dùng chưa? Trả null nếu đăng ký được, hoặc { status:409, body } để trả thẳng cho client.
async function signupConflict(exec, email, phone) {
  const rows = await findByIdentity(exec, email, phone);
  const byPhone = rows.find(r => r.phone === phone);
  const byEmail = rows.find(r => String(r.email || '').toLowerCase() === email);
  // Trùng với tài khoản KHÔNG phải khách (nhân viên / dữ liệu mồ côi không có role CUSTOMER): không ghi đè, không tự cấp role.
  if ((byPhone && !byPhone.is_customer) || (byEmail && !byEmail.is_customer)) return NOT_AVAILABLE();
  if (byPhone) return PHONE_TAKEN();
  if (byEmail) return EMAIL_TAKEN();
  return null;
}

// Đổi lỗi do createCustomer ném ra (kiểm tra trùng hoặc ràng buộc unique của Postgres, mã 23505) thành { status, body } 409.
// Trả null nếu không phải lỗi trùng (để route chuyển cho errorHandler như bình thường).
function conflictFromError(err) {
  if (err && err.signupConflict) return err.signupConflict;
  if (err && err.code === '23505') {
    if (err.constraint === 'users_phone_unique') return PHONE_TAKEN();
    if (err.constraint === 'users_email_key') return EMAIL_TAKEN();
    return conflict('DUPLICATE', 'Dữ liệu đã tồn tại.');
  }
  return null;
}

// Tạo user + gán role CUSTOMER trong 1 transaction. Kiểm tra trùng lại TRONG transaction; nếu 2 yêu cầu song song vẫn lọt qua
// kiểm tra thì ràng buộc unique của DB (23505) chặn - dùng conflictFromError để đổi thành 409 thay vì 500.
async function createCustomer({ familyName, givenName, email, phone, dateOfBirth }) {
  const fullName = `${familyName} ${givenName}`.trim();
  return db.tx(async c => {
    const clash = await signupConflict(c, email, phone);
    if (clash) throw Object.assign(new Error(clash.body.code), { signupConflict: clash });
    const created = (await c.query(
      "INSERT INTO users(phone,full_name,email,date_of_birth,status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING user_id,email,full_name,phone,status",
      [phone, fullName, email, dateOfBirth]
    )).rows[0];
    await c.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE code='CUSTOMER'", [created.user_id]);
    return created;
  });
}

// Đăng nhập: tìm đúng tài khoản khách khớp CẢ email lẫn SĐT. Trả { user } hoặc { error:{status,body} }.
async function resolveLoginUser(email, phone) {
  const rows = await findByIdentity(db, email, phone);
  if (!rows.length) {
    return { error: { status: 404, body: { code: 'ACCOUNT_NOT_FOUND', message: 'Tài khoản chưa tồn tại, vui lòng đăng ký.', redirectTo: 'register' } } };
  }
  const user = rows.find(r => r.is_customer && String(r.email || '').toLowerCase() === email && r.phone === phone);
  if (!user) {
    // Email hoặc SĐT đã có nhưng không thuộc cùng một tài khoản khách (hoặc là tài khoản không có role CUSTOMER):
    // KHÔNG gợi ý đăng ký (sẽ trùng), KHÔNG gửi OTP.
    return { error: { status: 409, body: { code: 'IDENTITY_MISMATCH', message: 'Email và số điện thoại không khớp cùng một tài khoản.' } } };
  }
  if (user.status !== 'ACTIVE') {
    return { error: { status: 401, body: { code: 'ACCOUNT_INACTIVE', message: 'Tài khoản không ở trạng thái hoạt động.' } } };
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return { error: { status: 423, body: { code: 'ACCOUNT_LOCKED', message: `Tài khoản tạm khoá. Thử lại sau ${minutesLeft} phút.` } } };
  }
  return { user };
}

module.exports = { signupConflict, conflictFromError, createCustomer, resolveLoginUser };
