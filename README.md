# calendar-to-reminder
Sync iOS Calendar events to Reminders via Scriptable

# iOS 日历 → 提醒事项 同步脚本

一个基于 **Scriptable** 的自动化脚本。它能将你的 iOS 日历事件同步到提醒事项列表中，并保持自动更新。

---

## 功能介绍
- 从日历读取事件，自动生成提醒事项。
- 重复运行时只进行增量更新。
- 可以配置同步的时间范围（默认前后 7 天）。
- 可选：在提醒标题前显示时间段（HH:mm–HH:mm）。
- 可选：指定需同步的日历名称与提醒事项列表名称。

## 注意事项
- 不要把天数调整过大，若需同步日程数目较多则可能导致未知bug以及同步失败等，目前一次200左右稳定运行。
- 此脚本依赖提醒事项和日程的“备注”栏写入的“RKEY”作为ID进行互认匹配，请不要手动删除。此前尝试过URL栏但不如使用备注栏稳定。

---

## 安装方法
1. 在 iOS 上安装 [Scriptable](https://apps.apple.com/us/app/scriptable/id1405459188) 应用。
2. 在 Scriptable 中新建脚本，复制本项目中的代码粘贴进去。
3. 修改配置参数（如日历名称/提醒列表名称/是否在标题显示时间段等）。
4. 保存并运行。

---

## 使用方式
- **手动运行**  
  打开 Scriptable，运行脚本，即可同步。

- **自动化运行（推荐）**  
  - 打开快捷指令 → 自动化 → 新建自动化。  
  - 触发条件选择 **每天/每小时** 或者 **打开应用时**、**关闭应用时**。  
  - 动作选择「运行 Scriptable 脚本」，选择此脚本。  

这样你的提醒事项会和日历保持自动同步。

---

## 参数配置
脚本前几行可修改参数：
```js
const DUR_DAYS_WINDOW = 7; // 同步动作发生时前后多少天的事件
const SHOW_TIME_RANGE_IN_TITLE = true; // 是否在标题中加入时间段
const SOURCE_EVENT_CAL_TITLE = "Daily"; // 日历名称
const TARGET_REM_CAL_TITLE = "Daily";   // 提醒列表名称
