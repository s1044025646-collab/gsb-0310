# 球面大圆航线采样与航向解释后端

离线、纯几何的大圆航线计算服务。输入两个经纬度点、球半径和等分段数，输出最短大圆弧的总角距、总距离、起始航向，以及沿弧**等弧长**采样的位置表。提供 HTTP API 与 CLI，结果持久化到 SQLite。

## 模型假设与边界

- **球形地球**：所有计算基于单位球面 + 公开半径 `radius`（距离与半径同一长度单位，由调用方决定是 km、m 还是 1）。
- **只做几何路线**：不读取地图、路网、天气或真实船机数据；不实现椭球测地线、卫星轨道、航迹避障。
- 角距用 `atan2(|A×B|, A·B)` 计算（范围 `[0, π]`），避免短距离时 `acos` 点积损失有效数字。
- 采样用球面线性插值（slerp），参数 `t ∈ [0,1]`，端点包含在内，各段弧长相等；**不做经纬度线性插值**，跨日期变更线自动走短弧。

### 坐标规范化（公开约定）

- 经度统一规范到半开区间 `[-180, 180)`；极点（`|lat| = 90°`）经度规范为 `0`。
- 同一点的不同写法（如 `lon=180` 与 `lon=-180`、极点任意经度）规范化后视为同一条路线。

### 歧义与退化（公开阈值）

| 情况 | 阈值 | 行为 |
|---|---|---|
| 起终点相同 | 角距 < 1e-12 rad | 状态 `degenerate`，距离 0，采样重复起点，航向 `undefined` |
| （接近）对跖 | 角距与 π 之差 < 1e-9 rad | 返回错误 `AMBIGUOUS_ANTIPODAL`，**不任意选弧** |
| 从极点出发 | 纬度距 ±90° < 1e-9° | 起始航向 `undefined`（诊断 `POLE_ORIGIN`） |

### 限制

- `segments`：1 ~ 10000 的整数；批量上限 100 条；请求体上限 2 MB。
- 数值失败（NaN/Infinity、越界纬度、非正半径、非法分段数）一律拒绝并返回错误码，绝不把 NaN 写进结果。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，**无原生依赖、无 Docker、无在线服务**）。
- 仅开发依赖：`typescript`、`@types/node`。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API（默认自动选择空闲端口；PORT=8080 可指定）
npm run demo      # CLI 内置演示（赤道、跨日期变更线、近极点、退化/歧义）
```

数据目录为项目内 `data/`（可用环境变量 `ROUTE_DB` 指定其他 SQLite 路径）。

## CLI

```powershell
node dist/src/cli.js route --from 0,0 --to 0,90 --radius 1 --segments 8 --save
node dist/src/cli.js point-at --from 0,0 --to 0,90 --t 0.5     # 单位向量 + 计算步骤
node dist/src/cli.js batch --file items.json --save            # 批量（逐项返回）
node dist/src/cli.js reverse --id 1                            # 反向核对
node dist/src/cli.js history --limit 20                        # 历史查询
node dist/src/cli.js export --id 1 --out route.json            # JSON 导出
node dist/src/cli.js demo                                      # 演示
```

## HTTP API

所有响应为 JSON；错误统一为 `{ "ok": false, "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/routes` | 计算并保存单条航线，返回 `{ id, report }` |
| POST | `/api/routes/batch` | `{ items: [...] }`，逐项返回 `{ index, ok, id/report 或 error }` |
| POST | `/api/point-at` | `{ from, to, t }`，返回比例位置的单位向量与计算步骤 |
| GET | `/api/routes?limit=&offset=` | 历史列表 |
| GET | `/api/routes/:id` | 读取单条（含完整结果快照） |
| GET | `/api/routes/:id/export` | 下载 JSON 快照 |
| POST | `/api/routes/:id/reverse-check` | 反向重算并核对距离相等、采样逆序一致 |
| GET | `/api/health` | 健康检查 |

请求示例：

```powershell
curl -X POST http://127.0.0.1:<端口>/api/routes -H "Content-Type: application/json" `
  -d '{ "from": {"lat":0,"lon":0}, "to": {"lat":0,"lon":90}, "radius": 1, "segments": 8 }'
```

### 错误码

`INVALID_COORD`（400）、`INVALID_RADIUS`（400）、`INVALID_SEGMENTS`（400）、`INVALID_T`（400）、`BAD_REQUEST`（400）、`NOT_FOUND`（404）、`LIMIT_EXCEEDED`（413）、`AMBIGUOUS_ANTIPODAL`（422）。

## 报告字段

`rulesVersion`（规则版本，当前 `sphere-v1`）、`status`（`ok`/`degenerate`）、规范化后的 `from`/`to`、`radius`、`segments`、`centralAngleRad`（总角距）、`totalDistance`、`initialBearingDeg` 与 `bearingStatus`、`diagnostics`、`samples[]`（`index/t/lat/lon/distance` 累计距离）。

SQLite 保存端点、半径、分段数、规则版本与完整结果快照；更改半径会生成新报告，历史记录的数值与单位语义永不回改。

## 验证口径

测试按**容差**检查几何不变量（不要求浮点逐位相同）：赤道手算（π/2）、同经线手算、反向距离相等且采样逆序、单位向量长度为 1、各段等弧长、半径倍增只改距离不改坐标、重复点退化、对跖诊断、边界经度规范化、保存重启后读取一致。

## 项目结构

```
src/geo.ts     核心球面几何（向量转换、稳定角距、slerp、航向、规范化、校验）
src/route.ts   航线报告与 point-at（含计算步骤）
src/db.ts      SQLite 存储（node:sqlite）
src/server.ts  HTTP API（node:http，无框架）
src/cli.ts     命令行与演示
test/          node:test 测试
data/          运行期 SQLite 数据目录
```
