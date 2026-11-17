# AI Video Production Studio V2

Ứng dụng xử lý video thật, chạy cục bộ bằng React + TypeScript + Vite và Express + FFmpeg. Không tích hợp API trả phí hoặc sử dụng credits.

## Chạy

Yêu cầu Node.js 22.12+ (đã kiểm tra Node 24.22.1), npm, `ffmpeg` và `ffprobe` có libx264/AAC trên PATH.

```sh
npm ci --ignore-scripts --cache /tmp/studio-npm-cache
npm run dev
```

Vite: cổng 5173, backend: 3001. Bản production: `npm run build` rồi `npm start` (cổng 3001 phục vụ cả UI và API). `PORT` thay cổng backend production; `DATA_DIR` thay thư mục dữ liệu mặc định `.data/`.

## Quy trình hoạt động

1. Nhập video MP4 (tối đa 1 GB, 30 phút). FFprobe xác thực có luồng hình và thời lượng hợp lệ.
2. FFmpeg phát hiện chuyển cảnh với ngưỡng scene score 0.35, chia thêm đoạn dài thành các cảnh tối đa 8 giây. Đây là phân tích hình ảnh, không phải AI ngữ nghĩa.
3. Chọn cảnh để xem video nguồn tại thời điểm tương ứng. Thay cảnh bằng video khác; có thể xem riêng video thay thế trong thẻ cảnh. Video ngắn được lặp, video dài bị cắt theo thời lượng cảnh.
4. Xuất video: scale + letterbox theo tỉ lệ nguồn (rộng tối đa 1280 px), kích thước chẵn, 30 fps, H.264/yuv420p. Ghép hình và lấy **âm thanh nguồn gốc xuyên suốt**, mã hóa AAC. Âm thanh của video thay thế không được dùng. Nguồn im lặng xuất im lặng.
5. Tải file MP4 bằng nút tải xuống. Các file dự án lưu trong `.data/`; trình duyệt nhớ ID dự án gần nhất.

## Kiểm thử và bằng chứng

```sh
npm run build
npm test
npx playwright test
```

`npm test` tạo MP4 17 giây có tone 440 Hz, kiểm tra chia 8+8+1, thay cảnh giữa bằng video đỏ dọc 1 giây không tiếng, lặp/chuẩn hóa, kiểm tra điểm ảnh đỏ ở giây 9, tiếng trong đoạn thay, codec H.264/AAC, thời lượng, giải mã toàn bộ file, từ chối file lỗi, xuất nguồn im lặng. Kiểm thử thứ hai xác minh phát hiện hard cut đen → trắng.

Playwright dùng Chromium `/usr/bin/chromium`: nhập MP4 qua UI, xác nhận 3 cảnh, xuất và tải file, chụp giao diện desktop/mobile, kiểm tra không tràn chiều ngang và không có lỗi JavaScript. Nếu máy khác chưa có Chromium, cần cài trình duyệt và điều chỉnh executablePath trong playwright.config.ts.

Bằng chứng tái tạo mỗi lần chạy: `evidence/validation.json`, `evidence/smoke-output.mp4`, `evidence/workflow-desktop.png`, `evidence/workflow-mobile.png`.

## Giới hạn MVP

- Giao diện node là pipeline cố định, chưa kéo thả/nối node tùy ý; chưa có sinh video AI, API bên ngoài, tài khoản hoặc cộng tác.
- Không có hủy tác vụ, hàng đợi toàn cục, xóa dự án, quota đĩa hoặc dọn dữ liệu tự động. Xử lý video lớn có thể chậm; mỗi lệnh FFmpeg giới hạn 10 phút. Cần tự dọn `.data/` khi không dùng.
- Job xuất lưu trong bộ nhớ: sau khi restart backend, file dự án vẫn còn nhưng cần xuất lại để bật tải xuống.
- Chưa kiểm thử video HDR, VFR phức tạp, file hỏng có chủ đích hoặc video 30 phút/1 GB. Tiếng được giữ nội dung và mốc thời gian nhưng có mã hóa lại AAC, không bit-exact.
- Dành cho máy phát triển đáng tin cậy. Chưa có đăng nhập, phân quyền hoặc hạn chế tốc độ; không triển khai API trực tiếp ra Internet. File upload được lưu trên máy chủ, không gửi tới nhà cung cấp AI.
