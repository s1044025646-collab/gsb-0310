# 球面大圆航线采样与航向解释后端

离线几何计算服务：输入两个经纬度点、球半径与等分段数，输出最短大圆弧长度、起始航向，以及沿弧等距采样点。只做 **API 与 CLI**，无前端、无地图库。

## 模型与范围

- **球形地球模型**（规则版本 `sphere-v1`），不是 WGS84 椭球测地线。
- 角度输入输出一律为「度」；半径与距离使用同一种长度单位（例如半径取 6371 则距离为公里，取 6371000 则为米）。服务不替你换算单位。
- 算法：经纬度 → 单位三维向量；角距用 `atan2(|a×b|, a·b)` 计算（短距离不丢有效数字）；采样用 slerp 球面插值，**绝不线性插值经纬度**，跨日期变更线走短弧。
- 不读取地图、交通路网、天气或真实船机数据；不实现椭球测地线、卫星轨道、航迹避障。

## 坐标约定（公开规范）

- 经度输出规范化到半开区间 **[-180, 180)**，即 `180°` 规范为 `-180°`；`-180°` 与 `180°` 是同一点。
- 极点（纬度 ±90°）经度统一规范为 **0**。
- 采样参数 `t ∈ [0,1]`，结果包含两个端点，相邻点弧长相等。

## 歧义边界

- 夹角 `ω ≤ 1e-12 rad`：视为重合点，状态 `ok-zero-distance`，距离 0、采样重复、航向 `undefined-zero-distance`。
- 夹角 `ω ≥ π - 1e-9 rad`（对跖或近对跖）：存在无穷多条等长大圆弧，状态 `ambiguous-antipodal`，返回诊断且 **不任选一条弧**，不出采样。
- 从极点出发：初始航向语义不唯一，标记 `undefined-at-pole`，值为 `null`。

## 校验与错误码

| 错误码 | 触发条件 |
| --- | --- |
| `INVALID_LAT` / `INVALID_LON` | 非数字、非有限数（NaN/Infinity）、纬度越 [-90,90]、经度越 [-180,180] |
| `INVALID_RADIUS` | 半径非有限数或 ≤ 0 |
| `INVALID_SEGMENTS` | 分段数非整数或不在 1..10000 |
| `INVALID_T` | 比例 t 不在 [0,1] |
| `ANTIPODAL_AMBIGUOUS` | 对跖点上请求比例位置 |
| `BATCH_TOO_LARGE` | 批量超过 100 条 |
| `NOT_FOUND` | 历史 id 不存在 |
| `NUMERIC_FAILURE` | JSON 解析失败或采样产生非有限数（NaN 永远不会作为坐标输出） |

批量接口逐项返回：保留输入顺序，每项带 `index` 与 `ok`，单项失败不影响其他项。

## 环境要求

- Node.js **≥ 22.5**（使用内置 `node:sqlite` 与 `--experimental-strip-types`，开发机实测 v25）。无需 Docker、WSL、付费服务或外部在线 API。
- Windows PowerShell 本地直接运行。

## 安装与命令

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 14 项几何不变量测试
npm run demo      # 赤道/跨变更线/近极点/重复点/对跖/重启持久化演示
npm start         # 启动 HTTP 服务（默认选空闲端口）
```

- 端口：默认自动选择空闲端口并打印；可用环境变量 `PORT=3000` 指定。
- 数据目录：项目内 `data/routes.db`（SQLite），可用 `GC_DB` 覆盖。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/routes` | 计算并保存单条航线 |
| POST | `/point-at` | 取比例 t 处单位向量、经纬度与计算步骤 |
| POST | `/routes/batch` | 批量计算（≤100），逐项结果 |
| POST | `/routes/reverse-check` | 路线反向核对（距离相等、采样逆序） |
| GET | `/routes?limit=&offset=` | 历史列表 |
| GET | `/routes/:id` | 读取一条记录（含完整结果快照） |
| GET | `/routes/:id?format=json` | 仅导出结果 JSON |

```powershell
# 赤道 0→90，半径 1
$body = @{ from=@{lat=0;lon=0}; to=@{lat=0;lon=90}; radius=1; segments=4 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/routes -Body $body -ContentType 'application/json'
```

## CLI

```powershell
node dist/cli.js route   --from 0,0 --to 0,90 --radius 1 --segments 4
node dist/cli.js point   --from 0,0 --to 0,90 --radius 1 --t 0.5
node dist/cli.js batch   --file examples/batch.json
node dist/cli.js reverse --from 39.9,116.4 --to 31.2,121.5 --radius 6371 --segments 4
node dist/cli.js history --limit 10
node dist/cli.js get     --id 1
node dist/cli.js export  --id 1 --out data/route1.json
```

## 结果快照与不可变性

SQLite 保存端点、半径、分段数、规则版本与**完整结果快照**（JSON）。更改半径会产生新报告；旧记录的距离单位与数值永不被修改。规则版本字段便于未来引入椭球模型时区分。

## 手算核对示例

- 赤道上经度 0→90、半径 1：角距 90° = π/2 rad，距离 = π/2 ≈ 1.570796327，中点经度 45°。
- 同经线纬度 0→60、半径 2：角距 60° = π/3，距离 = 2π/3 ≈ 2.094395102。
- 经度 179→-179：短弧 2°（0.034906585），不是 358°。
- 反向路线距离与正向相等，采样顺序相反；所有采样单位向量长度为 1；半径倍增只放大距离、坐标不变。测试按容差比较，不要求浮点逐位相同。

## 限制

- 球形近似：高纬度/长距离与真实椭球测地线存在偏差，不能用于测绘级或导航用途。
- `node:sqlite` 在当前 Node 版本带实验性警告，功能可用；锁定 Node 大版本前请关注其 API 变化。
