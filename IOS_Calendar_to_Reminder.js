// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: teal; icon-glyph: magic;
// === Calendar (Daily) -> Reminders (Daily) — Diff Update Version ===
// • 主键：提醒 notes 的 [RKey] <key>（稳定持久化）
// • 事件侧：notes:[SyncKey] <uuid>；否则指纹键哈希
// • 创建前认亲（标题+到期毫秒匹配无 RKey 旧条）
// • 仅当内容变更时才 save()，否则跳过
// • 去重 & 孤儿清理 & 60s 并发锁

/******** 配置 ********/
const SOURCE_EVENT_CAL_TITLE = "Daily"; // 事件来源日历
const TARGET_REM_CAL_TITLE   = "Daily"; // 目标提醒清单
const DUR_DAYS_WINDOW        = 7;       // 前后各 N 天
const SHOW_TIME_RANGE_IN_TITLE = false;  // 标题前缀 "HH:mm–HH:mm "
/************************/

// 标签/常量
const RE_SYNC_EVENT = /\[SyncKey\]\s([A-Za-z0-9\-]+)/;   // 事件侧 key
const RE_KEY_REM    = /\[RKey\]\s([A-Za-z0-9\-:]+)/;     // 提醒侧主键
const URL_EVENTID   = "eventid://"; // 兼容迁移
const URL_EVENTKEY  = "eventkey://";
const URL_FINGER    = "finger://";
const MUTEX_KEY     = "cal2rem_noteskey_mutex";

// 互斥锁（60s）
try {
  const now = Date.now();
  const last = Keychain.contains(MUTEX_KEY) ? Number(Keychain.get(MUTEX_KEY)) : 0;
  if (last && now - last < 60000) {
    console.warn("60 秒内已执行，退出以防重复。");
    Script.complete(); return;
  }
  Keychain.set(MUTEX_KEY, String(now));
} catch (e) { console.warn("互斥锁设置失败，继续。", e); }

// 工具
function pad2(n){return String(n).padStart(2,"0");}
function normTitle(t){return (t||"").trim().replace(/\s+/g," ");}
function titleWithRange(ev){
  if (!SHOW_TIME_RANGE_IN_TITLE || ev.isAllDay || !ev.startDate || !ev.endDate) return ev.title || "(无标题事件)";
  const s=ev.startDate, e=ev.endDate;
  return `${pad2(s.getHours())}:${pad2(s.getMinutes())}–${pad2(e.getHours())}:${pad2(e.getMinutes())} ${ev.title||"(无标题事件)"}`;
}
function djb2(str){let h=5381; for(let i=0;i<str.length;i++){h=((h<<5)+h)+str.charCodeAt(i); h|=0;} return (h>>>0).toString(16);}
function fingerKey(ev){
  const s = ev.startDate ? ev.startDate.getTime() : 0;
  return "F:" + djb2(`${normTitle(ev.title)}|${s}|${ev.calendar?.title||""}`);
}

// 窗口
const startDate = new Date(); startDate.setDate(startDate.getDate()-DUR_DAYS_WINDOW); startDate.setHours(0,0,0,0);
const endDate   = new Date(); endDate.setDate(endDate.getDate()+DUR_DAYS_WINDOW);   endDate.setHours(23,59,59,999);
console.log(`窗口: ${startDate.toLocaleString()} ~ ${endDate.toLocaleString()}`);

// 提醒清单与全部提醒
const rlists = await Calendar.forReminders();
const rDict  = Object.fromEntries(rlists.map(x=>[x.title,x]));
const targetList = rDict[TARGET_REM_CAL_TITLE];
if (!targetList) throw new Error(`找不到提醒清单 "${TARGET_REM_CAL_TITLE}"`);

const allRems = await Reminder.all();
const rems = allRems.filter(r => r.calendar?.title === TARGET_REM_CAL_TITLE);

// 索引
const byRKey = new Map();     // rKey -> [reminders]
const byTitleDue = new Map(); // normTitle|dueMs -> [reminders]
const byLegacyUrl = new Map();// 旧 url -> [reminders]

function getRKeyFromNotes(r){
  if (!r.notes) return null;
  const m = r.notes.match(RE_KEY_REM);
  return m ? m[1] : null;
}
function stripRKeyLine(text){
  if (!text) return "";
  return text.split("\n").filter(l => !RE_KEY_REM.test(l)).join("\n");
}
function indexReminder(r){
  const rk = getRKeyFromNotes(r);
  if (rk){ if (!byRKey.has(rk)) byRKey.set(rk, []); byRKey.get(rk).push(r); }
  if (r.dueDate){
    const k = `${normTitle(r.title)}|${r.dueDate.getTime()}`;
    if (!byTitleDue.has(k)) byTitleDue.set(k, []);
    byTitleDue.get(k).push(r);
  }
  if (r.url){ if (!byLegacyUrl.has(r.url)) byLegacyUrl.set(r.url, []); byLegacyUrl.get(r.url).push(r); }
}
for (const r of rems) indexReminder(r);

// 事件
const evcals = await Calendar.forEvents();
const srcCal = evcals.find(c=>c.title===SOURCE_EVENT_CAL_TITLE);
if (!srcCal) throw new Error(`找不到日历 "${SOURCE_EVENT_CAL_TITLE}"`);
const events = await CalendarEvent.between(startDate, endDate, [srcCal]);
console.log(`事件: ${events.length}`);

// 事件 SyncKey：能写则写一次，不行返回 null
async function ensureEventSyncKey(ev){
  if (ev.notes && RE_SYNC_EVENT.test(ev.notes)) return ev.notes.match(RE_SYNC_EVENT)[1];
  try {
    const uuid = UUID.string();
    const ls = [];
    if (ev.notes && ev.notes.trim()) ls.push(ev.notes.trim());
    ls.push(`[SyncKey] ${uuid}`);
    ev.notes = ls.join("\n");
    await ev.save();   // 只读来源会失败
    return uuid;
  } catch(_) { return null; }
}

// 写入提醒 RKey（用传入 rKey，移除旧行再写入）
function ensureReminderRKey(r, rKey){
  const cur = getRKeyFromNotes(r);
  if (cur === rKey) return false; // 无变化
  const base = stripRKeyLine(r.notes || "");
  r.notes = (base ? base + "\n" : "") + `[RKey] ${rKey}`;
  return true; // notes 变了
}

// 对比：只在“有变化”时才更新
function diffAndApply(r, desired){
  let changed = false;

  if (r.title !== desired.title){ r.title = desired.title; changed = true; }

  const a = r.dueDate ? r.dueDate.getTime() : null;
  const b = desired.dueDate ? desired.dueDate.getTime() : null;
  if (a !== b){ r.dueDate = desired.dueDate ? new Date(desired.dueDate) : null; changed = true; }

  if (!!r.dueDateIncludesTime !== !!desired.dueDateIncludesTime){
    r.dueDateIncludesTime = !!desired.dueDateIncludesTime; changed = true;
  }

  const curNotesNoKey = stripRKeyLine(r.notes || "");
  if (curNotesNoKey !== (desired.notesNoKey || "")){
    // 保留/追加 [RKey] 行
    const rk = getRKeyFromNotes(r);
    r.notes = (desired.notesNoKey || "");
    if (rk) r.notes = (r.notes ? r.notes + "\n" : "") + `[RKey] ${rk}`;
    changed = true;
  }

  return changed;
}

// 主流程
const seenRKeys = new Set();
let created=0, updated=0, skippedNoChange=0, reused=0, migrated=0, skippedDone=0;

async function upsert(ev){
  if (!ev.startDate) return;

  // 主键：优先事件 SyncKey，否则指纹
  const eKey = await ensureEventSyncKey(ev);
  const rKey = eKey ? ("E:" + eKey) : fingerKey(ev);

  // 直接命中（按 RKey）
  let r = byRKey.get(rKey)?.[0] || null;

  // 兼容迁移：旧 url
  if (!r){
    const leg1 = URL_EVENTID + (ev.identifier || "");
    const leg2 = URL_EVENTKEY + `${ev.startDate.getTime()}::${normTitle(ev.title)}`;
    const leg3 = URL_FINGER   + djb2(`${normTitle(ev.title)}|${ev.startDate.getTime()}|${ev.calendar?.title||""}`);
    const cands = [].concat(byLegacyUrl.get(leg1)||[], byLegacyUrl.get(leg2)||[], byLegacyUrl.get(leg3)||[]);
    if (cands.length){ r = cands[0]; migrated++; }
  }

  // 创建前“认亲”：标题+到期毫秒，且只复用无 RKey 的旧条
  if (!r){
    const dueMs = ev.startDate.getTime();
    const k1 = `${normTitle(titleWithRange(ev))}|${dueMs}`;
    const k2 = `${normTitle(ev.title||"")}|${dueMs}`;
    r = byTitleDue.get(k1)?.find(x=>!getRKeyFromNotes(x)) || byTitleDue.get(k2)?.find(x=>!getRKeyFromNotes(x)) || null;
    if (r) reused++;
  }

  // 新建 / 绑定
  let notesChangedByKey = false;
  if (!r){
    r = new Reminder();
    r.calendar = targetList;
    r.isCompleted = false;
    // 先写 RKey
    notesChangedByKey = ensureReminderRKey(r, rKey);
    created++;
  } else {
    notesChangedByKey = ensureReminderRKey(r, rKey);
  }

  // 内容（已完成不覆盖）
  if (r.isCompleted){
    skippedDone++;
  } else {
    // 期望内容（不包括 [RKey] 行）
    const parts = [];
    if (ev.notes){
      const cleaned = ev.notes.split("\n").filter(l => !RE_SYNC_EVENT.test(l));
      if (cleaned.length) parts.push(cleaned.join("\n"));
    }
    if (ev.location) parts.push(`地点: ${ev.location}`);
    if (ev.url)      parts.push(`链接: ${ev.url}`);

    const desired = {
      title: titleWithRange(ev),
      dueDate: new Date(ev.startDate),
      dueDateIncludesTime: !ev.isAllDay,
      notesNoKey: parts.join("\n")
    };

    const changed = diffAndApply(r, desired);
    if (changed || notesChangedByKey){ await r.save(); updated++; }
    else { skippedNoChange++; }
  }

  // 索引/已见
  if (!byRKey.has(rKey)) byRKey.set(rKey, []);
  if (!byRKey.get(rKey).includes(r)) byRKey.get(rKey).push(r);
  seenRKeys.add(rKey);

  if (r.dueDate){
    const tk = `${normTitle(r.title)}|${r.dueDate.getTime()}`;
    if (!byTitleDue.has(tk)) byTitleDue.set(tk, []);
    if (!byTitleDue.get(tk).includes(r)) byTitleDue.get(tk).push(r);
}
}

for (const ev of events) { await upsert(ev); }
console.log(`创建 ${created}，实际更新 ${updated}，无变动跳过 ${skippedNoChange}，复用旧提醒 ${reused}，迁移旧键 ${migrated}，跳过已完成 ${skippedDone}`);

// 去重：同一 RKey 多条，仅留 1 条（优先保留未完成、时间最早）
let removedDup = 0;
for (const [rk, arr] of byRKey.entries()){
  if (!arr || arr.length <= 1) continue;
  arr.sort((a,b)=>{
    if (a.isCompleted !== b.isCompleted) return a.isCompleted?1:-1;
    return (a.dueDate?.getTime()||0) - (b.dueDate?.getTime()||0);
  });
  for (let i=1;i<arr.length;i++){ await arr[i].remove(); removedDup++; }
  byRKey.set(rk,[arr[0]]);
}
if (removedDup) console.log(`去重删除 ${removedDup} 条`);

// 孤儿清理：仅删除“我们管理（带 [RKey]）且在窗口内”的提醒
let removedOrphan = 0;
for (const r of rems){
  const rk = getRKeyFromNotes(r);
  if (!rk) continue;
  const inWindow = r.dueDate && r.dueDate >= startDate && r.dueDate <= endDate;
  if (inWindow && !seenRKeys.has(rk)){ await r.remove(); removedOrphan++; }
}
if (removedOrphan) console.log(`清理孤儿提醒 ${removedOrphan} 条`);

// 释放锁
try { Keychain.remove(MUTEX_KEY); } catch(_) {}
Script.complete();