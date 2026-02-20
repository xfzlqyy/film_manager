
## 1. 核心功能
1. 该仓库维护的是一个本地网页，其主要目的是维护和管理data.Ink这一个文件的内容，主要是有关相关信息的增删查改。
2. 每个电影归属于不同的类别，对于同一个类别的电影，其会维护几个特定的属性，具体如下
   1. DVD目录：序号，影碟名称，备注，序号格式int
   2. 蓝光影碟目录：序号、影碟名称、备注，序号格式int-int
   3. 精装蓝光影碟目录： 序号、影碟名称、备注，序号格式int
   4. 硬盘电影目录：所属硬盘、序号、电影名称、字幕、类型、备注
3. 你需要支持手动的添加、删除、修改电影信息，还有根据电影名字等查找电影信息，信息修改后，你要同步更新到data.xls中
4. 增加同步硬盘数据的功能，其会要求输入硬盘名，然后选择一个文件夹，文件夹下的电影都是以<序号>.<电影名>的格式进行存储，然后需要进行自动的parse，如果对应的序号+电影名在当前数据中没有保存，则将其加入到现在的数据并写入xls, 字幕默认是外挂，类型默认是mkv，备注为空。

## 2. 实现细节
1. 技术栈与运行形态
   1. 前端使用 React 18 + TypeScript + Vite。
   2. Excel 读写使用 `xlsx`（`.xls`）。
   3. 桌面端使用 Electron（`electron/main.cjs` + `electron/preload.cjs`）。
   4. 打包使用 `electron-builder`，支持 Windows NSIS 安装包。

2. 代码结构与职责
   1. `src/App.tsx`：页面状态管理、分类切换、搜索、CRUD、自动编号、自动保存、错误/状态提示。
   2. `src/config.ts`：四类目录字段定义、别名、校验规则（如序号格式）。
   3. `src/types.ts`：类型定义（`CategoryId`、`MovieRecord`、`CategoryRecords`）。
   4. `src/xls.ts`：工作簿解析、数据校验、排序规则、工作簿回写。
   5. `vite.config.ts`：开发/预览时提供 `/api/data.xls` 的 GET/POST 读写接口。
   6. `electron/main.cjs`：本地文件读写、数据路径解析、IPC 通信、窗口加载重试。
   7. `src/electron.d.ts`：渲染进程 `window.filmManagerApi` 类型声明。
   8. `scripts/copy-data.mjs`：在 `dev/build` 前复制 `data.xls` 到 `public/data.xls`。
   9. `.github/workflows/build-win.yml`：GitHub Actions 构建 Windows 安装包并上传 artifact。

3. 数据读取与写入链路
   1. 页面启动优先通过 Electron IPC 读取 `data.xls`。
   2. 若非 Electron，则尝试 `GET /api/data.xls`；再失败回退到 `public/data.xls`。
   3. 保存时优先走 Electron 写本地文件；其次走 `/api/data.xls`；再其次走浏览器 `showOpenFilePicker` 文件句柄写回。
   4. Electron 在开发模式会同时镜像写入 `public/data.xls`，保证 Web 调试和桌面调试一致。

4. Excel 解析策略（`src/xls.ts`）
   1. Sheet 匹配策略：先精确匹配中文 sheet 名，再模糊匹配，最后按下标兜底。
   2. DVD/蓝光/精装蓝光优先使用“分块解析”：
      1. 以 `fields.length` 为组宽在每行横向切组，避免只读第一列。
      2. 仅保留满足校验的记录（序号+标题必须有效，且序号符合对应正则）。
   3. 硬盘目录支持两种布局：
      1. 分块布局：识别“硬盘标题行 + 重复表头行 + 多组5列数据”。
      2. 扁平布局：按表头别名映射列并校验。
   4. 硬盘目录会跳过辅助行：
      1. 仅含一个非空单元且以“硬盘”开头的行视为分组标题，不是记录。
      2. 含“序号/电影名称/类型”的表头行不入库。
   5. 严格校验规则：
      1. DVD/精装蓝光序号必须是整数；蓝光必须是 `a-b`。
      2. 硬盘记录必须有 `disk/title`，且 `serial` 必须是整数。

5. 排序与搜索规则
   1. DVD/精装蓝光：按整数序号升序，再按文本兜底。
   2. 蓝光影碟目录：按 `a-b` 拆分后排序，再按文本兜底。
   3. 硬盘电影目录：先按硬盘号排序（支持阿拉伯数字和中文数字），再按序号排序，再按标题兜底。
   4. 硬盘搜索按组合字符串 `<所属硬盘>.<序号>.<电影名>` 匹配，支持硬盘号和序号检索。

6. 表单交互与自动编号（`src/App.tsx`）
   1. 新增与编辑共用表单，`editingId` 区分模式。
   2. 序号字段在新增时自动生成，编辑时可手动修改。
   3. 自动编号规则：
      1. DVD/精装蓝光：当前最大整数序号 + 1。
      2. 蓝光：`a-b` 中 `b` 递增至 510，超过后变为 `(a+1)-1`。
      3. 硬盘：按所选硬盘内最大序号 + 1。
   4. 硬盘新增默认值：
      1. 默认硬盘为当前最大编号硬盘。
      2. `subtitle` 默认 `外挂`。
      3. `genre` 默认 `mkv`。
   5. 删除操作带确认弹窗。
   6. 新增成功后表单保持展开，保留输入便于批量录入；取消时才关闭。

7. 自动保存与并发控制
   1. 新增/编辑/删除后会触发自动保存，不要求用户手动点击保存。
   2. 使用 `autoSaveQueueRef` 串行化保存任务，避免并发写同一文件造成状态错乱。
   3. 保留“手动保存到 data.xls”按钮作为显式兜底。

8. Electron 文件路径策略
   1. 优先写入程序可写的首选路径：
      1. 开发模式：项目根 `data.xls`。
      2. 打包模式：可执行文件同目录 `data.xls`，不可写时回退 `userData/data.xls`。
   2. 首次无目标文件时，会从多个候选位置（项目根、public、resources、已保存路径等）选现有文件复制初始化。
   3. 用户可手动选择任意 `data.xls`，路径会持久化到 `settings.json`。

9. 构建与发布
   1. `npm run dev`：Web 开发模式（含 `prepare:data`）。
   2. `npm run dev:electron`：Vite + Electron 联调，内置 `wait-on` 防止空白窗口。
   3. `npm run build`：前端构建并复制 `data.xls` 到 `public`。
   4. `npm run electron:build:win`：构建 Windows NSIS 安装包到 `release/`。
   5. GitHub Actions `build-win` 支持 `workflow_dispatch` 与 `v*` tag 触发，产物名为 `film-manager-win`。

10. 当前实现现状说明
   1. 核心 CRUD、解析、排序、自动保存、桌面端持久化、Windows 打包链路已经落地。
   2. “按硬盘名 + 选择文件夹自动同步未收录电影”这一需求在当前代码中尚未实现，后续可作为独立功能补齐。
## 3. 语言规范
* 解释与沟通使用简体中文。
* 代码、注释、标识符与命令保持英文原文。
* 你需要永远使用英文思考，使用中文和我进行沟通。
