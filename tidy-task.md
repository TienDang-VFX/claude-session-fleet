session-fleet: dọn nhóm sidebar và Remote Control cho mọi session trên máy này. Chạy không cần hỏi, không sửa file dự án nào.

1. Đọc `~/.claude/session-fleet.json` và lấy `machineName`, bên dưới gọi là M. Nếu file không có thì dừng lại và báo "session-fleet chưa cài trên máy này".
2. Chạy `git -C ~/claude-session-fleet pull --quiet`. Lỗi thì bỏ qua.
3. Gọi `mcp__ccd_session_mgmt__list_sessions` với limit 200 (không lấy session đã archive). Gọi `mcp__ccd_sidebar__list_groups` một lần để lấy id các nhóm.
4. Với mỗi session, trừ chính session đang chạy task này và các session có `scheduledTaskId` (lượt chạy của scheduled task):
   a. Không đổi tên session nào: tên do plugin đặt khi session mở, và tên người dùng tự đổi phải được giữ nguyên. Không gọi `mcp__ccd_session_mgmt__set_session_title`.
   b. Nhóm đúng: tên có ✅ thì là `Done`, còn lại là `M`. Nhóm chưa có thì tạo bằng `mcp__ccd_sidebar__create_group` (mỗi tên một lần). Nếu session đang ở nhóm khác thì chuyển bằng `mcp__ccd_sidebar__move_sessions`. Session con (có `startedBy`) không chuyển riêng được; bỏ qua nếu bị từ chối.
   c. Nếu `lastActivityAt` trong vòng 48 giờ qua và `remoteControlActive` là false: gọi `mcp__ccd_session_mgmt__set_remote_control` với enabled true. Session đang ngủ có thể báo "requires an active session": app giữ yêu cầu và nối lại ở lượt kế; ghi nhận rồi đi tiếp, không gửi tin nhắn để đánh thức.
5. Dọn các lượt chạy cũ của task này: với mỗi session có tên đúng là `session-fleet: dọn session` hoặc `[M] session-fleet: dọn session`, khác session đang chạy và `isRunning` là false, gọi `mcp__ccd_session_mgmt__archive_session` với reason "lượt chạy cũ của session-fleet tidy".
6. Trả lời ngắn gọn: số session Remote Control đã bật lại hoặc đang chờ, bao nhiêu session đã kiểm tra, session nào đã chuyển nhóm, và số lượt chạy cũ đã archive.
7. Bước cuối cùng, sau khi đã trả lời: gọi `mcp__ccd_session_mgmt__archive_session` với session_id "self" và reason "session-fleet tidy xong" để lượt chạy này tự archive.