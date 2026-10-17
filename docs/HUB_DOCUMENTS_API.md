# Hub 文档库接口约定（给 CLI 用）

`bshub doc …` 调用的接口。Hub 实现这些路由，CLI 按这里的形状读写；两边的测试都以这份约定为准。

## 认证与权限

- 根路径 `/api/hub/v1`，认证用 `x-api-key`（Kan 的 API key），对应到一个账号。
- 权限规则和网页完全一样，由同一批用例决定（谁能读、谁能新建、谁能改）。API 不另开后门。
- 已停用的账号一律 403。
- **不开放**：删除文档、分配或撤销编辑权限、处理编辑申请。这些只在网页里做。原因：API key 现在没有权限范围，泄露后不应该能删文件或转让编辑权。
- 所有写操作进操作日志，和网页上的操作一样记在做这件事的人名下。
- **只认 API key**，不认浏览器会话；请求里同时带了 cookie 时，只看 key。
- 错误体：`{ "message": "…" }`，状态码 400 / 401 / 403 / 404 / 409 / 429。**读不到的文档和不存在的文档一样回 404**，不暴露它存在。

## 路由

| 方法和路径 | 作用 |
| --- | --- |
| `GET /documents?folder=&search=` | `{ folders: [{publicId, name, parentPublicId}], documents: [Document] }` |
| `GET /documents/{id}` | `Document` |
| `GET /documents/{id}/content` | `{ content, updatedAt }`，上限 400 KB |
| `POST /documents` | 新建文档：`{ title, filename, content, description?, folderPublicId?, readable? }` → `Document`。`filename` 必须是 `.md`、`.html` 或 `.htm`，其他格式 400 |
| `PUT /documents/{id}/content` | 替换文本内容：`{ content, expectedUpdatedAt? }`（需要编辑权）。带上读取时拿到的 `updatedAt`，文档在那之后被别人改过就回 409，不会覆盖 |
| `PATCH /documents/{id}` | `{ title?, description?, folderPublicId?, readable? }` → `Document` |
| `POST /documents/folders` | `{ name, parentPublicId? }` → `{ publicId, name, parentPublicId }` |

`Document` = `{ publicId, title, description, filename, ext, size, folderPublicId, readable, canEdit, updatedAt }`。

## CLI 依赖的几条保证

1. `readable: false` 的文档，创建时就不可读，不存在「先公开再改」的窗口。CLI 仍会检查返回值，不是 false 就立刻 PATCH，再不行就报 `not_private` 并以非零退出。
2. Hub 只存 Markdown 和 HTML 文本（2026-10-17 起），没有上传和签名下载链接；CLI 的所有请求都只发往 Hub。
3. 文档必须是 UTF-8：读到非 UTF-8 的内容会回 400，不会用替换字符显示。
