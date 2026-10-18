# session-fleet

Plugin Claude Code cho nhiều máy dùng chung một tài khoản Claude:

- Tên session luôn bắt đầu bằng tên máy: `[3090] <feature>`, khi xong thì thành `[3090] ✅ <feature>`.
- Feature được đặt tên tự động từ prompt đầu tiên. Đổi tên bằng `/feature <tên>`.
- Session mở ngoài folder dự án của máy thì bị chặn Edit/Write/Bash/PowerShell cho tới khi bạn chạy `/fleet-here`.
- Kiểm tra Remote Control và nhắc nếu đang tắt.
- Mỗi session được ghi vào một registry dùng chung (`sessions/<máy>/<session-id>.json`), nên máy nào cũng xem được danh sách bằng `/sessions`.
- `/done [ghi chú]` đánh dấu session xong, đồng bộ lên registry và đưa session vào nhóm sidebar `Done` (trong desktop app).

## Cài trên một máy

Repo plugin này là public, nên clone không cần đăng nhập. Chỉ có registry là cần đăng nhập GitHub (`gh auth login`) bằng tài khoản được quyền push vào nó.

Dán cùng một đoạn sau vào bất kỳ session Claude nào trên mỗi máy. Chỉ cần sửa `MyGame.uproject` thành file đánh dấu folder dự án của bạn:

```text
Cài plugin session-fleet cho máy này.
1. Clone https://github.com/TienDang-VFX/claude-session-fleet.git vào ~/claude-session-fleet. Nếu đã có thì git pull.
2. Windows: chạy ~/claude-session-fleet/install.ps1 -ProjectMarker MyGame.uproject
   macOS/Linux: chạy ~/claude-session-fleet/install.sh --marker MyGame.uproject
   Nếu script báo lỗi clone registry thì dừng lại và báo tôi chạy `gh auth login`.
3. Nếu có tool mcp__ccd_settings__set_setting thì đặt connect_new_sessions_to_remote_control = true.
4. Tạo task dọn định kỳ: nếu mcp__scheduled-tasks__list_scheduled_tasks chưa có task "session-fleet-tidy" thì gọi mcp__scheduled-tasks__create_scheduled_task với taskId "session-fleet-tidy", cronExpression "0 */5 * * *", description "Dọn tên và nhóm sidebar của session mỗi 5 tiếng", prompt là toàn bộ nội dung file ~/claude-session-fleet/tidy-task.md. Sau đó chạy nó một lần ngay (mcp__scheduled-tasks__run_scheduled_task).
5. Báo lại tên máy, folder dự án mà script tìm được, file ~/.claude/session-fleet.json, và task đã tạo.
```

**Dọn định kỳ:** task `session-fleet-tidy` chạy mỗi 5 tiếng khi desktop app đang mở (nếu app tắt đúng giờ chạy thì nó chạy ngay khi app mở lại). Mỗi lần chạy, nó đổi tên mọi session của máy sang dạng `[máy] …` và chuyển chúng vào nhóm sidebar trùng tên máy (hoặc nhóm `Done` nếu có ✅), kể cả những session không mở. Trong lúc session đang mở, plugin còn tự đồng bộ 30 giây và 2 phút sau prompt đầu tiên, cuối mỗi lượt, và cứ 30 phút một lần.

Script sẽ làm mấy việc sau:
- Đặt tên máy theo GPU (RTX 3090 thành `3090`). Không có GPU rời thì lấy tên máy tính (Windows) hoặc hostname (macOS/Linux). Muốn tự đặt thì dùng `-Machine` / `--machine`.
- Tìm folder chứa file đánh dấu: trên Windows quét tối đa 2 cấp dưới gốc mỗi ổ cứng cục bộ; trên macOS quét `~` và `/Volumes`. Nếu có nhiều bản, ưu tiên bản là git clone đầy đủ, sau đó tới bản sửa gần nhất. Muốn chỉ định thì dùng `-ProjectRoot` / `--root`.
- Clone registry `TienDang-VFX/claude-session-registry` vào `~/.claude/session-fleet-registry`.
- Ghi file `~/.claude/session-fleet.json` (cấu hình riêng của máy).
- Cài plugin ở scope user, đọc thẳng từ folder `~/claude-session-fleet`.

Plugin chỉ áp dụng cho các session mở sau khi cài.

**Cập nhật plugin:** chạy `git -C ~/claude-session-fleet pull`. Session mới sẽ dùng bản mới; session đang chạy trong terminal thì gõ `/reload-plugins`.

## Đồng bộ giữa các máy

Registry mặc định là repo private `TienDang-VFX/claude-session-registry`, mỗi session một file `sessions/<máy>/<session-id>.json`. Mỗi thay đổi đều được commit, pull --rebase rồi push. Danh sách session luôn pull trước khi hiển thị. Vì mỗi session có file riêng nên không bị conflict.

Không dùng git thì chạy script với `-RegistryGit ""` (chỉ lưu ở máy đó) hoặc `-RegistryDir <folder dùng chung>`.

## Trong desktop app

Desktop app không hiện các lệnh `/feature`, `/done`, `/sessions`, `/fleet`, nên plugin cung cấp thêm tool để Claude gọi. Bạn chỉ cần nói bằng lời:

- "xong rồi" / "done": Claude gọi `fleet_done`, đổi tên session thành `[máy] ✅ …` và đưa session vào nhóm `Done`.
- "feature này là …": Claude gọi `fleet_feature`.
- "các máy đang làm gì": Claude gọi `fleet_sessions`.
- "fleet status": Claude gọi `fleet_status`.

Desktop app bỏ qua tên session do hook đặt, nên plugin nhờ Claude đổi tên bằng tool `set_session_title` của app.

## Lệnh

| Lệnh (terminal) | Tác dụng |
|---|---|
| `/feature <tên>` | Đặt tên feature; tiêu đề đổi ở tin nhắn tiếp theo |
| `/done [ghi chú]` | Đánh dấu xong, đồng bộ, đưa vào nhóm `Done` |
| `/sessions [all]` | Các session đang chạy trên mọi máy và các session done gần nhất |
| `/fleet` | Tên máy, folder, Remote Control, registry |
| `/fleet-here` | Cho phép sửa file dù session nằm ngoài folder dự án |

## Giới hạn

- Remote Control là setting của app và của CLI. Plugin không tự bật được, chỉ kiểm tra và nhắc.
- Plugin không chuyển được folder của session. Nó chỉ chặn và báo khi folder sai.
- Việc đưa session vào nhóm sidebar (theo tên máy hoặc `Done`) là do Claude làm, bằng các tool sidebar của desktop app. Nhóm sidebar lưu riêng trên từng máy. Registry mới là phần đồng bộ giữa các máy.

## Phát triển

```bash
claude plugin validate .
claude plugin test .
```
