# AI Video Production Studio V3.1

Nhánh mới `feature/studio-v3-1`, dựa trên V3 `61f0cbe`. V3 Preview trên `feature/studio-v3` giữ nguyên. V2 production giữ ở `main` tại `b0ec89b`; nhánh này không triển khai production. Không có API trả phí, AI generation hay tiêu credits.


## V3.1 — Storyboard và handoff thủ công

Sau khi nhập MP4, mỗi cảnh có Storyboard tự động, ảnh JPEG đầu/cuối, prompt ảnh và prompt chuyển động riêng. Prompt là mẫu theo mốc thời gian và hướng dẫn sử dụng ảnh tham chiếu; **chưa phân tích ngữ nghĩa bằng AI**. Có thể sửa/lưu hoặc tải prompt để dùng ở công cụ bên ngoài.

- FFmpeg trích ảnh đầu và frame cuối thực trong khoảng cảnh; ảnh cuối ghi đè tuần tự từng frame, không giữ cả cảnh trong RAM. Ảnh tối đa 640×640, 512 KiB/ảnh; mỗi process 15 giây, toàn lượt trích ảnh 120 giây. Video duration ưu tiên luồng hình để không tạo cảnh rỗng do audio/container padding dài hơn video.
- Mỗi ô nhập gắn cố định với **ID cảnh**, không đoán cảnh theo tên file. Đổi thứ tự không đổi ID. Muốn nhập vào cảnh nào, chọn ô ảnh/clip của cảnh đó.
- Ô **Nano Banana Pro** nhận PNG/JPEG; ô **Omni Flash/Plus** nhận MP4. Đây là nhãn công cụ người dùng tự chọn cho file nhập thủ công, không phải chứng thực model hoặc tuyên bố các model này có trong Flow.
- Ảnh Nano và clip Omni lưu riêng. Nhập clip tự cập nhật replacement trong Timeline và vẫn giữ ảnh. Nếu đã có clip, nhập lại ảnh không ghi đè clip đang dùng. Video thay thế lặp/cắt theo thời lượng cảnh; tiếng lấy từ nguồn mẫu.
- Khi trim thay đổi, ảnh tham chiếu được cập nhật; prompt đã sửa được giữ nguyên, media cũ được gắn cờ cần kiểm tra. Clip nhập lại sẽ xóa cờ. Dự án V3 cũ có nút **Khởi tạo Storyboard**; không yêu cầu nhập lại nguồn.
- Nguồn V3.1 dùng localStorage riêng. Blueprint chỉ mô tả service mới `ai-video-production-studio-v3-1-preview`, branch V3.1, autoDeploy tắt; **không áp dụng hoặc deploy** trong đơn hàng này.

LIVE Generate vẫn trả 501. [Thẩm định API và các nguồn chính thức đã thử đọc](docs/provider-api-review.md): các trang Google bị proxy CONNECT 403; API/model mapping Omni chưa được xác minh, không có key/quyền/cơ chế chi phí hợp lệ để bật Generate. Không coi Flow UI là API.

### Kiểm thử V3.1 mới

```sh
npm run build
npm run test:storyboard
npm run test:storyboard:browser
```

Đợt V3.1 chạy các kiểm thử mới cho Storyboard và trường hợp audio dài hơn video; không chạy lại các suite V3 đã PASS. Chromium mới kiểm tra tham chiếu, sửa prompt, nhập ảnh/clip, giữ ảnh sau nhập clip, ID cảnh sau reorder/trim, xuất/tải file và màn hình mobile.

Bằng chứng: `evidence/v3-1-output.mp4` (4 giây, 320×180, 30fps H.264/AAC), `v3-1-validation.json`, `v3-1-ref-scene-*-*.jpg`, ảnh giao diện `v3-1-storyboard-*.png`. Fixtures ảnh/video là media nhị phân thật tạo bằng FFmpeg cục bộ, **không phải ảnh/video do Nano Banana Pro/Omni/Google Flow sinh ra**. Luồng nhập file đã được kiểm thử, nguồn gốc provider chưa được chứng thực. Chưa có kiểm thử bằng media AI của người dùng hoặc chạy V3.1 trên Render.

## Chạy cục bộ

Node 22.12+ (đã dùng 24), FFmpeg/FFprobe với libx264/AAC. Không cần API key.

```sh
npm ci --ignore-scripts --cache /tmp/studio-npm-cache
npm run dev
```

Vite 5173 proxy API tới backend 3001. Bản build: `npm run build && npm start`; backend phục vụ cả UI lẫn API, bind `0.0.0.0`, đọc biến `PORT`. `DATA_DIR` mặc định `data-v3/`, tách khỏi `.data/` của V2. Docker dùng `/app/data`.

## Luồng sản phẩm

1. Nhập MP4 thật: phát hiện hard cut, chia thêm thành cảnh tối đa 8 giây.
2. Scene Timeline: chọn cảnh, đổi thứ tự bằng ←/→, trim vị trí nguồn và thời lượng 0.1–8 giây, xóa cảnh, lưu hoặc bỏ thay đổi. Timeline tổng tối đa 120 giây; export bị khóa khi có chỉnh sửa chưa lưu.
3. Thay media bằng MP4/PNG/JPEG từ máy. Ảnh tĩnh giữ đủ thời lượng; video ngắn lặp, dài cắt. Preview ảnh/video trong inspector.
4. Xuất: FFmpeg chuẩn hóa kích thước chẵn trong khung 1280×720 hoặc 720×1280 tùy chiều nguồn, không phóng lớn; 30 fps, H.264/yuv420p + AAC. **Tiếng nguồn được trim theo mốc nguồn từng cảnh và ghép theo thứ tự timeline mới**. Không lấy tiếng từ video thay thế. Nguồn im lặng xuất im lặng. Thời lượng làm tròn tới frame 1/30 giây.
5. Tải MP4; xóa dự án để giải phóng dung lượng. Metadata ghi atomic; media/dự án còn trên đĩa sau restart nhưng job xuất chỉ nằm trong RAM, cần xuất lại để tải.

## Provider adapters — trạng thái thật

| Adapter | Ảnh | Video | API / credits |
| --- | --- | --- | --- |
| MOCK | FFmpeg tạo PNG màu | FFmpeg tạo MP4 2 giây | Không mạng; màu xác định theo prompt, **không phải AI generation** |
| LIVE / manual | Nhập PNG/JPEG | Nhập MP4 | Chỉ file người dùng tải về từ Google Flow; không đăng nhập/điều khiển Flow |
| LIVE generation | Chưa hỗ trợ | Chưa hỗ trợ | Endpoint trả 501, không gửi request ra ngoài |

`server/providers.mjs` cung cấp registry adapter dùng chung image/video. Metadata lưu `mode`, `kind`, `origin`, `prompt`, `networkCalls`. Không nhận URL remote để tránh backend tải URL tùy ý. Nhãn Google Flow là nguồn người dùng tự khai, không phải chứng thực xuất xứ. Luồng nhập được kiểm thử bằng media tổng hợp; chưa kiểm thử bằng tài khoản Google Flow thật.

## Bảo vệ upload và profile Render Free

- Một mutation/upload/render toàn server; yêu cầu cạnh tranh trả 429, không xếp hàng vô hạn.
- File tối đa **50 MiB**, video tối đa **120 giây**, **60 fps**, số pixel tối đa 1920×1080 (kể cả dọc), cạnh không quá 4096. Tối đa **60 cảnh / 5 dự án**.
- Kiểm tra đuôi file + magic bytes + FFprobe. Chỉ MP4 có `ftyp`, PNG/JPEG; không nhận SVG, playlist hoặc URL. FFprobe input chỉ dùng protocol `file,pipe`, timeout 10 giây.
- FFmpeg một thread, một filter thread; mỗi process tối đa 120 giây, render tổng ngân sách 180 giây. Giới hạn từng part 16 MiB, output 128 MiB; kiểm tra thời lượng để không trả thành công khi file bị cắt do giới hạn.
- Quota dữ liệu **512 MiB**, giữ vùng dự phòng cho upload/output, kiểm tra giữa các part; có thể từ chối trước khi đĩa đầy. Xóa dự án vẫn được phép khi chạm watermark. Đây là quota ứng dụng, không phải filesystem quota của OS.
- Xóa upload tạm khi lỗi, xóa part sau render. Dự án không cập nhật quá **6 giờ** được dọn khi khởi động hoặc trước mutation kế tiếp; không có cron chạy nền. Cần tải thành phẩm về máy, filesystem hosting Free không bền vững.
- Chặn browser write `Sec-Fetch-Site: cross-site`, JSON tối đa 16 KiB, filename ngẫu nhiên, ID/path kiểm tra; `nosniff`. Đây không thay thế chống abuse ở reverse proxy.
- Có thể đặt **`STUDIO_PASSWORD`** để bật HTTP Basic Auth cho UI/API/media; username **`studio`**. Nhập mật khẩu qua hosting settings, không commit. `/api/health` vẫn công khai cho health check. Chỉ dùng Basic Auth qua HTTPS khi public. Nếu không đặt password, app chạy chế độ demo không bảo vệ truy cập, UI hiển thị cảnh báo.
- Request timeout 120 giây, headers timeout 30 giây, tối đa 32 socket. Không coi đây là sandbox an toàn để xử lý mọi file đối nghịch; cần ingress rate limit, cập nhật FFmpeg và auth từng người trước khi mở dịch vụ nhiều người.

Các giới hạn nhằm giảm tải; **chưa có bằng chứng vận hành trên máy Render Free thực**, không cam kết xử lý mọi video sát giới hạn RAM/CPU.

## Kiểm thử

```sh
npm run build
npm test
npm run test:browser
```

- Bộ regression V2 kiểm tra chia cảnh, thay video, âm thanh, decode, file lỗi và nguồn im lặng (kết quả tạm nằm trong `/tmp`).
- V3 test tạo nguồn 17 giây, ba đoạn có tone khác nhau. Tạo mock PNG/MP4, nhập file PNG/MP4 theo luồng Google Flow, đổi thứ tự/trim thành 5 giây. Kiểm tra pixel ảnh/video, tiếng theo timeline **440 → 330 → 880 Hz**, decode toàn bộ MP4.
- Kiểm tra LIVE generation 501, upload quá 50 MiB 413 và cleanup, signature sai, cross-site 403, cạnh tranh 429, 5 dự án, watermark đĩa 507, xóa khi quota đầy, TTL cleanup và password đúng/sai.
- Chromium kiểm tra thao tác timeline, MOCK, Flow file input, export/download, screenshot desktop/mobile và không có lỗi JS/tràn màn hình. Dùng `/usr/bin/chromium`; backend test cổng 43130 riêng, dữ liệu tạm ngẫu nhiên.

Bằng chứng V3: `evidence/v3-output.mp4`, `v3-validation.json`, `v3-desktop.png`, `v3-mobile.png`. File bằng chứng V2 được giữ để tham khảo lịch sử, không đại diện lần chạy V3.

## Docker và nhánh preview

```sh
docker build -t studio-v3 .
docker run --rm -d --name studio-v3-smoke -p 127.0.0.1:3012:10000 -e PORT=10000 studio-v3
node tests/docker-smoke.mjs
docker stop studio-v3-smoke
```

Nếu máy có HTTPS inspection proxy, dùng CA tin cậy qua secret: `docker build --secret id=build_ca,src=/etc/ssl/certs/ca-certificates.crt -t studio-v3 .`. Không tắt TLS hoặc đóng gói CA riêng vào image. Container chạy user `node`, có FFmpeg/FFprobe.

`render.yaml` chỉ mô tả service mới **studio-v3-preview**, branch `feature/studio-v3`, `plan: free`, `autoDeploy: false`. **Không áp dụng blueprint này lên service production V2.** Chưa tạo service, chưa deploy và chưa xác minh chính sách Free hiện tại. Không tự bật billing/persistent disk hoặc tích hợp API.

## Còn thiếu

Chưa có LIVE AI generation, tích hợp Google Flow API, drag/drop tự do cho node/timeline, undo nhiều bước, thư viện media, workflow tùy ý, hủy job/queue bền vững, tài khoản/phân quyền từng người hay lưu trữ lâu dài. Mật khẩu chung chỉ phù hợp demo riêng. Upload HDR/VFR/phức tạp và sát giới hạn tài nguyên chưa được nghiệm thu trên Render Free. Source audio được mã hóa lại AAC, không bit-exact. Không deploy hoặc thay đổi `main` trong đợt V3.

Bằng chứng Docker: `evidence/v3-docker-output.mp4`, `v3-docker-validation.json` và tổng kết `v3-test-report.json`. Bộ Node test chạy cả trên host và image FFmpeg Debian với user `node`. Thử áp RAM 512 MiB qua `docker update` bị host từ chối vì thiếu cgroup `memory.max`, nên **chưa xác minh chạy dưới RAM cap 512 MiB**; không suy diễn kết quả này thành nghiệm thu Render Free.

### V3-04: preview độc lập và mật khẩu

Blueprint preview khai báo `STUDIO_PASSWORD: generateValue: true` để Render tự sinh giá trị bí mật khi tạo service mới; không có giá trị mật khẩu trong Git. Đây là cấu hình chuẩn bị, không chứng minh biến đã được tạo trên Render. Username đăng nhập là `studio`; `/api/health` vẫn public. Giữ `autoDeploy: false`, service riêng và branch `feature/studio-v3`. Chỉ áp dụng sau khi tài khoản Render xác nhận giá $0; không đổi service V2, thêm thẻ hoặc chọn gói trả phí.
