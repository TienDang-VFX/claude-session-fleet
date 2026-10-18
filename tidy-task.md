session-fleet: dọn tên và nhóm sidebar cho mọi session trên máy này. Chạy không cần hỏi, không sửa file dự án nào.

1. Đọc `~/.claude/session-fleet.json` và lấy `machineName`, bên dưới gọi là M. Nếu file không có thì dừng lại và báo "session-fleet chưa cài trên máy này".
2. Chạy `git -C ~/claude-session-fleet pull --quiet`. Lỗi thì bỏ qua.
3. Gọi `mcp__ccd_session_mgmt__list_sessions` với limit 200 (không lấy session đã archive). Gọi `mcp__ccd_sidebar__list_groups` một lần để lấy id các nhóm.
4. Với mỗi session, trừ chính session đang chạy task này và các session có `scheduledTaskId` (lượt chạy của scheduled task):
   a. Tên đúng là `[M] <phần còn lại>`. Phần còn lại là tên hiện tại sau khi bỏ chữ `M ` hoặc `[M]` ở đầu và bỏ `[M]` nằm giữa tên. Nếu tên có ✅ thì đặt ✅ ngay sau tiền tố: `[M] ✅ <phần còn lại>`. Giữ nguyên các emoji khác (💬, 🔍…). Tên đã đúng thì không đổi.
   b. Nếu phải đổi tên: gọi `mcp__ccd_session_mgmt__set_session_title`. Sau đó, nếu `remoteControlActive` là true, gọi `mcp__ccd_session_mgmt__set_remote_control` để tắt rồi bật lại, cho máy khác thấy tên mới.
   c. Nhóm đúng: tên có ✅ thì là `Done`, còn lại là `M`. Nhóm chưa có thì tạo bằng `mcp__ccd_sidebar__create_group` (mỗi tên một lần). Nếu session đang ở nhóm khác thì chuyển bằng `mcp__ccd_sidebar__move_sessions`. Session con (có `startedBy`) không chuyển riêng được; bỏ qua nếu bị từ chối.
   d. Nếu `lastActivityAt` trong vòng 48 giờ qua và `remoteControlActive` là false: gọi `mcp__ccd_session_mgmt__set_remote_control` với enabled true. Session đang ngủ có thể báo "requires an active session": app giữ yêu cầu và nối lại ở lượt kế; ghi nhận rồi đi tiếp, không gửi tin nhắn để đánh thức.
5. Trả lời ngắn gọn: số session Remote Control đã bật lại hoặc đang chờ, bao nhiêu session đã kiểm tra, danh sách tên cũ → tên mới, và session nào đã chuyển nhóm.
