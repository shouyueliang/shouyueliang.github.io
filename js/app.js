/* ==========================================================
   工具箱 — 定时播放（直播式同步版）
   ------------------------------------------------------------
   - 支持两种场次模式（config.json）：
     · 音频+图片：{ audio, scenes:[{t,img}] }  ← 推荐，秒开、可精准同步
     · 视频：     { videos:[...] }（多段连播，兼容保留）
   - 直播式同步：任何人任意时刻打开，进度 = 当前时间 - 开播时间，与所有人一致；
     播放中持续向统一进度靠拢，但只在"目标位置已经缓冲好"时才往前跳，不为同步而打断播放
   - 配置优先读线上 config.json，失败用内置默认
   ========================================================== */
"use strict";

/* ---------- 内置默认计划（兜底，简版；完整场景表在 config.json） ---------- */
const DEFAULT_SCHEDULE = [
  {
    id: "am", name: "早课", time: "05:30",
    videos: ["test-media/am-i0b.mp4"],
    durationSec: 3738.13,
  },
  {
    id: "pm", name: "晚课", time: "20:00",
    videos: ["test-media/pm-i0b.mp4"],
    durationSec: 7352.8,
  },
];
const DEFAULT_GRACE_MIN = 15; /* 兜底：无时长信息时的最短进场窗口 */
const SESSION_TAIL_SEC = 120; /* 结束后的缓冲窗口 */

let SCHEDULE = DEFAULT_SCHEDULE;
let GRACE_MIN = DEFAULT_GRACE_MIN;

/* ---------- 元素 ---------- */
const video = document.getElementById("video");
const audioEl = document.getElementById("audio");
const playerWrap = document.getElementById("player-wrap");
const bgSc = document.getElementById("bg-scene");
const bgB = document.getElementById("bg-b");
const stripA = document.getElementById("strip-a");
const stripB = document.getElementById("strip-b");
const glowEl = document.getElementById("glow");
const clockEl = document.getElementById("clock");
const dateEl = document.getElementById("date-line");
const countdownEl = document.getElementById("countdown");
const playerState = document.getElementById("player-state");
const sbLabel = document.getElementById("sb-label");
const sbName = document.getElementById("sb-name");
const sbTime = document.getElementById("sb-time");
const sbCountdown = document.getElementById("sb-countdown");
const slotsEl = document.getElementById("slots");
const unmuteBtn = document.getElementById("unmute-btn");
const wakeHint = document.getElementById("wake-hint");
const vbPlay = document.getElementById("vb-play");
const vbPause = document.getElementById("vb-pause");
const vbFill = document.getElementById("vb-fill");
const vbTime = document.getElementById("vb-time");
const bufferingEl = document.getElementById("buffering");
const stripBgEl = document.getElementById("strip-bg");
const stripFreezeCv = document.getElementById("strip-freeze");

/* ---------- 状态 ---------- */
let media = video;                 // 当前承载播放的元素
let playing = false;               // 本页面正在播一场
let liveMode = false;              // 本场是否为直播同步模式
let sessionStartMs = 0;            // 本场的墙钟开播时刻
let currentSlot = null;
let wakeLock = null;
let queue = [];                    // 视频模式分段列表
let queueIndex = 0;
const prefetched = new Set();
let mediaParts = [];               // 音频模式分段列表（渐进加载）
let partIdx = 0;                   // 音频模式当前段
let partBase = [];                 // 各段累计起始时间（秒）
const partsPrefetched = new Set(); // 已预取的分段（视频/音频模式共用）
let currentSceneKey = "";          // 当前字幕条标识
let frontStrip = stripA;           // 字幕条交叉淡入的前层
let currentBgKey = "";             // 当前背景段标识
let frontBg = bgSc;                // 背景交叉淡入的前层
let soloMode = false;              // 当前背景段是否为整幅场景（片头/结尾，无字幕条）

/* ---------- 媒体地址：一律取本站（GitHub Pages），不切换线路 ---------- */
function mediaUrl(rel) {
  return new URL(rel, location.origin + "/").href;
}

/* ---------- 卡死/龟速/异常暂停 自愈看门狗（每 2 秒巡检一次） ----------
   判定"卡死"看的是数据而不是固定的秒数：只要数据还在陆续到达（哪怕慢网正在读视频头）
   就不算卡死，不去打断它，避免"越救越卡"。
   ① 缓冲耗尽时：一个字节都没收到(起播 6 秒/其余 12 秒)，或下载速度不到播放所需的一半且持续 20 秒
      → 换一条新连接续播；速度够（哪怕慢）就耐心等，不打断
   ② 30 秒内进度不足 5 秒（龟速/反复停顿） → 同上
   ③ 播放会话中却处于暂停态 → 自动续播；数据明明就绪却连续 10 秒播不了 → 给手动按钮 */
let stallTicks = []; /* [{t:墙钟ms, p:播放位置}] 滑动窗口 */
let pauseRescueTried = 0;
let starveStarted = 0; /* 本轮"缓冲耗尽"的起始时刻（ms），0 表示未耗尽 */
let lastDataAt = 0;    /* 前台播放器最近一次收到媒体数据的时刻（ms） */
const STARVE_SILENT_MS = 12000; /* 缓冲耗尽后"完全没有数据"多久，判定这条连接已死 */
const STARVE_SLOW_RATE = 0.5;   /* 下载速度（每秒下到多少秒的视频）低于它，播起来也会一直卡 */
const STARVE_SLOW_MS = 15000;   /* 速度一直这么慢持续多久，就换条连接试试 */
let errRetries = 0;    /* 连续加载出错的次数（恢复播放后清零） */
let joinPending = false;      /* 正在进场定位（还没出第一帧）：此期间同步逻辑不插手 */
let firstByteWaitMs = 6000;   /* 起播时"一个字节都没收到"等多久就换连接；连续失败会逐步放宽 */
let slowSince = 0;             /* 下载速度持续偏慢的起始时刻（ms），0 表示不慢 */
const bufHist = [];            /* 最近十几秒「巡检时刻 → 已缓冲视频秒数」，用来估下载速度 */

/* 让播放器播起来。只有浏览器策略明确拒绝"有声自动播放"(NotAllowedError) 才降级为静音；
   其它失败（换源被中断 AbortError 等）不动声音，交给看门狗下一轮重试 */
function ensurePlaying(el) {
  if (!el || !el.src || el.ended || !el.paused) return;
  const p = el.play();
  if (p && typeof p.catch === "function") {
    p.catch((err) => {
      if (err && err.name === "NotAllowedError" && !el.muted) {
        el.muted = true;
        if (el === media) updateMuteBadge();
        el.play().catch(() => {});
      }
    });
  }
}
/* 播放器里已缓冲的视频总秒数 */
function bufferedTotalSec(el) {
  let tot = 0;
  try { const b = el.buffered; for (let i = 0; i < b.length; i++) tot += b.end(i) - b.start(i); } catch (e) {}
  return tot;
}
setInterval(() => {
  if (!playing) { stallTicks = []; pauseRescueTried = 0; starveStarted = 0; slowSince = 0; return; }
  if (!media.src || media.ended) { stallTicks = []; starveStarted = 0; return; }
  /* ③ 异常暂停：播放会话中不应长时间处于暂停态 */
  if (media.paused) {
    pauseRescueTried += 1;
    if (pauseRescueTried <= 5) { ensurePlaying(media); }
    else if (media.readyState >= 2) { startBtn.hidden = false; } /* 数据已就绪却 10 秒播不了：手动兜底 */
    return;
  }
  pauseRescueTried = 0;
  const now = Date.now();
  /* ① 缓冲耗尽（readyState<3）：按"还有没有数据在到"来计时，而不是固定 10 秒 */
  const starving = media.readyState < 3;
  if (starving) {
    if (!starveStarted) { starveStarted = now; slowSince = 0; bufHist.length = 0; }
    const silentFor = now - Math.max(starveStarted, lastDataAt);
    /* 连视频头都还没收到：多半是这条请求挂了（换一条连接通常立刻就有响应） */
    const nothingYet = media.readyState < 1 && now - lastDataAt > firstByteWaitMs;
    /* 下载速度（每秒下到多少秒的视频），按最近 12 秒的平均值估，免得被一阵一阵的到数据误判；
       不到播放所需的一半、还一直这样 → 这条连接太慢，换一条试试 */
    const bufNow = bufferedTotalSec(media);
    bufHist.push({ t: now, sec: bufNow });
    while (bufHist.length > 1 && now - bufHist[0].t > 12000) bufHist.shift();
    const rate = (bufNow - bufHist[0].sec) / Math.max(1, (now - bufHist[0].t) / 1000);
    if (rate < STARVE_SLOW_RATE) { if (!slowSince) slowSince = now; } else slowSince = 0;
    if (nothingYet || silentFor > STARVE_SILENT_MS || (slowSince && now - slowSince > STARVE_SLOW_MS)) {
      if (nothingYet) firstByteWaitMs = Math.min(firstByteWaitMs * 2, 24000); /* 连续失败就放宽，避免反复空等 */
      starveStarted = 0;
      slowSince = 0;
      stallTicks = [];
      recoverStall(media.currentTime);
      return;
    }
  } else {
    starveStarted = 0;
    slowSince = 0;
  }
  /* ② 30 秒只走了不到 5 秒：龟速/反复停顿，换连接 */
  const p = media.currentTime;
  stallTicks.push({ t: now, p });
  while (stallTicks.length && now - stallTicks[0].t > 30500) stallTicks.shift();
  const first = stallTicks[0];
  if (now - first.t >= 30000 && p - first.p < 5) {
    stallTicks = [];
    recoverStall(p);
  }
}, 2000);
function recoverStall(t) {
  const wasJoining = joinPending;
  joinPending = true; /* 重新加载并定位期间位置会短暂归零，同步逻辑先不插手 */
  /* 进场阶段还没出过画面就重连：要回到的是"当前的直播位置"，而不是卡住的位置（此时还是 0） */
  if (wasJoining && liveMode && currentSlot && currentSlot.partDurations) {
    const loc = locateInQueue((Date.now() - sessionStartMs) / 1000);
    if (loc.idx === queueIndex) t = loc.offset;
  }
  /* 中止预滚/待命，避免旧连接残留 */
  prerollOn = false;
  clearInterval(prerollWatchTimer);
  standbyArmedIdx = -1;
  try { standbyEl.pause(); } catch (e) {}
  freezeStripFrame(media); /* 垫住字幕条，重连期间画面完整 */
  /* 原地址重连：只走本站（GitHub），不换线、不带防缓存参数 */
  const url = mediaUrl(queue[queueIndex] || (currentSlot && currentSlot.videos && currentSlot.videos[0]) || "");
  lastDataAt = Date.now(); /* 重新计时：从这次重连算起，看数据还到不到 */
  starveStarted = 0;
  bufHist.length = 0;
  media.src = url;
  const onMeta = () => {
    media.removeEventListener("loadedmetadata", onMeta);
    try { media.currentTime = Math.min(t, Math.max(0, (isFinite(media.duration) ? media.duration : t) - 0.3)); } catch (e) {}
    ensurePlaying(media);
  };
  media.addEventListener("loadedmetadata", onMeta);
  /* 兜底：重连后仍处于暂停态 → 重置救治计数，交给看门狗继续续播 */
  setTimeout(() => {
    if (playing && media.paused) { pauseRescueTried = 0; ensurePlaying(media); }
  }, 6000);
  /* 之后若仍卡住，由看门狗按"有没有数据 / 下载速度"决定是否再换连接（见上方规则①②） */
}

/* ---------- 时间工具 ---------- */
function slotDate(slot, day) {
  const [h, m] = slot.time.split(":").map(Number);
  const d = day instanceof Date ? day : new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
}
function dayKey(day) {
  const d = day instanceof Date ? day : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function playedKey(slot) { return `jjq_played_${slot.id}_${dayKey()}`; }
function isPlayed(slot) { try { return localStorage.getItem(playedKey(slot)) === "1"; } catch (e) { return false; } }
function markPlayed(slot) { try { localStorage.setItem(playedKey(slot), "1"); } catch (e) { /* 忽略 */ } }
function sessionDurationSec(slot) {
  if (typeof slot.durationSec === "number" && slot.durationSec > 0) return slot.durationSec;
  if (isFinite(media.duration) && media.duration > 0) return media.duration;
  return GRACE_MIN * 60;
}

/* ---------- 直播窗口：返回正在进行的场次与已播秒数 ---------- */
function liveSession() {
  const now = Date.now();
  for (const slot of SCHEDULE) {
    const start = slotDate(slot).getTime();
    const dur = (slot.durationSec || 0) * 1000 || Infinity;
    const end = start + dur + SESSION_TAIL_SEC * 1000;
    if (now >= start && now <= end) {
      return { slot, start, elapsed: (now - start) / 1000 };
    }
  }
  return null;
}

/* ---------- 已结束场次记录（防止直播窗口内反复重播/误显示播放中） ---------- */
const finishedToday = new Set(); /* 运行期记录：本页面已完整看完的场次 */
function finishKey(slot) { return slot.id + "_" + dayKey(); }

/* ---------- 定时检查（直播式：直播时段进场一律加入同步） ---------- */
function checkSchedule() {
  if (playing) return;
  const live = liveSession();
  if (!live) return;
  if (finishedToday.has(finishKey(live.slot))) return; /* 本场已放完，不再重播 */
  const dur = live.slot.durationSec || Infinity;
  if (live.elapsed < dur) {
    startPlay(live.slot, { live: true, seek: live.elapsed });
  }
}

/* ---------- 场景渲染：背景时间轴（片头/主景/结尾）+ 字幕条交叉淡入 ---------- */
function setBgEntry(entry) {
  if (!entry || !entry.img) return;
  const url = new URL(entry.img, location.href).href;
  const key = url + (entry.solo ? "|solo" : "");
  if (key === currentBgKey) return;
  currentBgKey = key;
  soloMode = !!entry.solo;
  /* 背景双图层交叉淡入 */
  const back = frontBg === bgSc ? bgB : bgSc;
  const apply = () => {
    back.src = url;
    back.classList.add("show");
    frontBg.classList.remove("show");
    frontBg = back;
  };
  if (back.complete && back.src === url) { apply(); return; }
  const p = new Image();
  p.onload = apply;
  p.onerror = () => { /* 缺图保持上一张 */ };
  p.src = url;
  /* 整幅场景（片头/结尾）：隐藏字幕条与光芒 */
  if (soloMode) {
    stripA.classList.remove("show");
    stripB.classList.remove("show");
    glowEl.hidden = true;
  } else {
    glowEl.hidden = false;
  }
}
function setStrip(imgPath) {
  if (!imgPath) return;
  const url = new URL(imgPath, location.href).href;
  if (url === currentSceneKey) return;
  currentSceneKey = url;
  const back = frontStrip === stripA ? stripB : stripA;
  const apply = () => {
    back.src = url;
    back.classList.add("show");
    frontStrip.classList.remove("show");
    frontStrip = back;
  };
  if (back.complete && back.src === url) { apply(); return; }
  const probe = new Image();
  probe.onload = apply;
  probe.onerror = () => { /* 缺图保持上一张 */ };
  probe.src = url;
}
function timelinePick(list, t) {
  if (!list || !list.length) return null;
  let hit = list[0];
  for (const s of list) {
    if (s.t <= t) hit = s; else break;
  }
  return hit;
}
function syncBgToTime(t) {
  if (!currentSlot || !currentSlot.bgs) return;
  setBgEntry(timelinePick(currentSlot.bgs, t));
}
function syncSceneToTime(t) {
  if (soloMode) return; /* 整幅场景期间不叠字幕 */
  if (!currentSlot || !currentSlot.scenes) return;
  const hit = timelinePick(currentSlot.scenes, t);
  if (hit) setStrip(hit.strip);
}
function preloadScenes(slot) {
  (slot.bgs || []).forEach((b) => { const i = new Image(); i.src = new URL(b.img, location.href).href; });
  if (!slot.scenes) return;
  slot.scenes.slice(0, 6).forEach((s) => {
    if (s.strip) { const i = new Image(); i.src = new URL(s.strip, location.href).href; }
  });
}
/* 滑动窗口预取：只提前加载接下来的几张字幕条 */
const scenePrefetched = new Set();
function prefetchUpcomingScenes(t) {
  if (!currentSlot || !currentSlot.scenes) return;
  let idx = 0;
  for (let i = 0; i < currentSlot.scenes.length; i++) {
    if (currentSlot.scenes[i].t <= t) idx = i; else break;
  }
  for (let k = idx; k <= idx + 4 && k < currentSlot.scenes.length; k++) {
    const p = currentSlot.scenes[k].strip || currentSlot.scenes[k].full;
    if (!p) continue;
    const url = new URL(p, location.href).href;
    if (!scenePrefetched.has(url)) {
      scenePrefetched.add(url);
      new Image().src = url;
    }
  }
}

/* ---------- 字幕条冻结帧：加载/重连期间用画布垫住下1/3，画面不缺角 ----------
   注意：drawImage 跨域视频会污染画布（画出来是空白且不报错），所以先用
   captureStream 不现实；改为只在同源时绘制，跨域一律跳过（宁缺勿白板） */
function freezeStripFrame(el) {
  if (!stripFreezeCv || !playerWrap.classList.contains("strip-mode")) return;
  try {
    const vw = el.videoWidth, vh = el.videoHeight;
    if (!vw || !vh) return;
    /* 跨域视频：绘制会静默产出空白画布，直接放弃（避免白板盖住字幕） */
    const u = new URL(el.currentSrc || el.src || "");
    if (u.origin !== location.origin) return;
    stripFreezeCv.width = 854; stripFreezeCv.height = 160;
    const ctx = stripFreezeCv.getContext("2d");
    if (vh / vw > 0.21) {
      /* 全画面视频（片头片尾）：截取其下1/3 */
      ctx.drawImage(el, 0, vh * 2 / 3, vw, vh / 3, 0, 0, 854, 160);
    } else {
      /* 已是条带视频：整幅 */
      ctx.drawImage(el, 0, 0, vw, vh, 0, 0, 854, 160);
    }
    /* 防污染兜底：验一下真的画上了（污染画布 getImageData 会抛错） */
    ctx.getImageData(0, 0, 1, 1);
    stripFreezeCv.hidden = false;
  } catch (e) { /* 污染/异常：隐藏画布，宁缺勿白板 */ try { stripFreezeCv.hidden = true; } catch (e2) {} }
}
function clearStripFreeze() { if (stripFreezeCv) stripFreezeCv.hidden = true; }

/* ---------- 条带模式布局：分段落在 strip 区间时，上2/3显示高清静止图 ---------- */
function applyStripLayout() {
  if (!stripBgEl) return;
  const s = currentSlot;
  if (!s || !s.stripBg || !playing) {
    playerWrap.classList.remove("strip-mode");
    stripBgEl.hidden = true;
    return;
  }
  const on = queueIndex >= (s.stripFrom || 0) && queueIndex <= (s.stripTo == null ? -1 : s.stripTo);
  if (on) {
    const url = mediaUrl(s.stripBg);
    if (stripBgEl.getAttribute("src") !== url) stripBgEl.src = url;
    stripBgEl.hidden = false;
    playerWrap.classList.add("strip-mode");
  } else {
    playerWrap.classList.remove("strip-mode");
    stripBgEl.hidden = true;
  }
}

/* ---------- 开始一场 ---------- */
async function startPlay(slot, opts = {}) {
  playing = true;
  currentSlot = slot;
  liveMode = !!opts.live;
  sessionStartMs = opts.live ? slotDate(slot).getTime() : Date.now();
  if (!opts.test) markPlayed(slot);
  setSlotState(slot, "播放中");
  playerState.classList.add("playing");
  playerWrap.classList.add("playing");
  queue = [];
  queueIndex = 0;
  joinPending = false;

  if (slot.audio) {
    /* —— 音频+图片模式（支持精准同步进场） ——
       关键：把音频文件装进 video 元素播放。手机浏览器（iOS/微信）
       禁止 audio 自动播放，但允许"静音视频"自动播放——视频元素
       在此处仅作为声音载体（CSS 已隐藏），画面由图片层呈现 */
    playerWrap.classList.add("audio-mode");
    playerWrap.classList.add("preload-visual"); /* 加载期静止背景，播放开始后整套动画登场 */
    bgSc.hidden = false;
    bgB.hidden = false;
    stripA.hidden = false;
    stripB.hidden = false;
    glowEl.hidden = false;
    media = video;
    audioEl.pause();
    audioEl.removeAttribute("src");
    /* 渐进分段：首段短（秒开），播放中后台预取后续段 */
    mediaParts = (slot.mediaParts && slot.mediaParts.length) ? slot.mediaParts.slice() : [slot.audio];
    partIdx = 0;
    partBase = [0];
    if (slot.partDurations) {
      for (let i = 0; i < slot.partDurations.length; i++) {
        partBase.push(partBase[i] + slot.partDurations[i]);
      }
    }
    let joinIdx = 0;
    let joinOff = opts.seek || 0;
    if (slot.partDurations) {
      for (let i = 0; i < slot.partDurations.length; i++) {
        if (joinOff < partBase[i + 1]) { joinIdx = i; joinOff -= partBase[i]; break; }
        joinIdx = i + 1;
        joinOff = 0;
      }
      if (joinIdx >= mediaParts.length) { finishSession(); return; }
    }
    partIdx = joinIdx;
    video.src = mediaParts[partIdx];
    video.muted = false;
    playerState.textContent = "播放中";
    currentSceneKey = "";
    currentBgKey = "";
    preloadScenes(slot);
    const seekTo = () => {
      if (joinOff > 0 && isFinite(video.duration)) {
        video.currentTime = Math.min(joinOff, Math.max(0, video.duration - 0.5));
      }
      video.removeEventListener("loadedmetadata", seekTo);
    };
    video.addEventListener("loadedmetadata", seekTo);
    const cum0 = partBase[partIdx] + joinOff;
    syncBgToTime(cum0);
    syncSceneToTime(cum0);
    await tryPlay(video);
  } else {
    /* —— 视频模式（分段连播 + 精准同步进场） —— */
    playerWrap.classList.remove("audio-mode");
    media = video;
    standbyEl = video2;
    setFrontEl(video);
    audioEl.pause();
    video2.pause();
    queue = slot.videos.slice();
    let partIdx = 0;
    let offset = opts.seek || 0;
    if (slot.partDurations) {
      let acc = 0;
      for (let i = 0; i < slot.partDurations.length; i++) {
        if (offset < acc + slot.partDurations[i]) { partIdx = i; offset -= acc; break; }
        acc += slot.partDurations[i];
        partIdx = i + 1;
      }
      if (partIdx >= queue.length) { finishSession(); return; } /* 进场时本场已播完 */
    }
    queueIndex = partIdx;
    standbyArmedIdx = -1;
    if (slot.stripBg) { const p = new Image(); p.src = mediaUrl(slot.stripBg); }
    applyStripLayout();
    await playCurrentPart(offset);
  }
}

const startBtn = document.getElementById("start-btn");
async function tryPlay(el) {
  let refused = false;
  try { await el.play(); } catch (e) { refused = !!(e && e.name === "NotAllowedError"); }
  if (refused && !el.muted) {
    /* 浏览器拒绝"有声自动播放"：先静音把画面走起来，声音交给画面上的"开声音"按钮 */
    el.muted = true;
    if (el === media) updateMuteBadge();
    try { await el.play(); } catch (e) { /* 静音也被拒：交给看门狗和手动按钮 */ }
  }
  /* 关键兜底：play 请求可能长时间挂起（不算失败、不走 catch），
     12 秒后仍未真正开播就给出手动按钮 */
  setTimeout(() => {
    if (playing && media === el && el.paused && startBtn.hidden) {
      startBtn.hidden = false;
      showToast("缓冲较慢，可点击按钮立即开始", "info", 4000);
    }
  }, 12000);
}
startBtn.addEventListener("click", () => {
  startBtn.hidden = true;
  media.muted = false; /* 用户亲手点的：按有声处理 */
  updateMuteBadge();
  ensurePlaying(media);
});

/* ---------- 双播放器无缝接力 ---------- */
const video2 = document.getElementById("video2");
let standbyEl = video2; /* 预载下段的后台播放器 */

function setFrontEl(el) {
  const other = el === video ? video2 : video;
  el.classList.add("v-front"); el.classList.remove("v-back");
  other.classList.add("v-back"); other.classList.remove("v-front");
}
/* 后台预载下一段：临近段尾（剩余<90s）才开始，避免整段全速下载与前台抢带宽 */
let standbyArmedIdx = -1; /* 已为哪个分段索引预载过待命段 */
/* 当前播放位置之后已缓冲的秒数（当前位置不在任何缓冲区间内时为 0） */
function bufferAheadOf(el) {
  try {
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= el.currentTime && el.currentTime < b.end(i)) return b.end(i) - el.currentTime;
    }
  } catch (e) {}
  return 0;
}
function loadStandbyNext(force = false) {
  if (!standbyEl || playing === false || !queue.length) return;
  const next = queue[queueIndex + 1];
  if (!next) return;
  if (standbyArmedIdx === queueIndex) return; /* 本段已预载过 */
  if (!force) {
    if (!isFinite(media.duration)) return;
    const remaining = media.duration - media.currentTime;
    if (remaining > 150) return; /* 未到预载窗口：先让前台独占带宽（拥塞线路需要更长预热） */
    /* 带宽让位：前台自己的缓冲还不足 15 秒、且离段尾还远时，先把带宽留给前台；
       缓冲够了（或马上就到段尾）再预载下一段 */
    if (remaining > 30 && bufferAheadOf(media) < 15) return;
  }
  standbyArmedIdx = queueIndex;
  const url = mediaUrl(next);
  if (standbyEl.src !== url) {
    standbyEl.muted = media.muted;
    standbyEl.volume = media.volume;
    standbyEl.src = next; /* preload=auto，自动加载首帧待命 */
    /* 管道预热：加载完成后静音播一瞬立即暂停，解码器/音频通道进入热备，
       真正换轨时零冷启动，消除最后几十毫秒顿挫 */
    standbyEl.addEventListener("canplaythrough", () => {
      const wasMuted = standbyEl.muted;
      standbyEl.muted = true;
      standbyEl.play().then(() => {
        standbyEl.pause();
        standbyEl.currentTime = 0;
        standbyEl.muted = wasMuted;
      }).catch(() => { standbyEl.muted = wasMuted; });
    }, { once: true });
  }
}
/* ---------- 衔接预滚 + 首帧交接 ----------
   新段提前 ~0.4s 静音起播，等它真正"渲染出画面"（requestVideoFrameCallback，
   不支持则 timeupdate 兜底）那一刻才：暂停旧段 → 换层 → 取消静音。
   旧段在此之前持续播不冻结 → 画面零黑帧零停顿；交接误差只剩一帧级抖动 */
let prerollOn = false;
let prerollWatchTimer = 0;
function handoverToStandby() {
  if (!prerollOn) return; /* 防重复交接（ended 冷路径可能已接管） */
  prerollOn = false;
  clearInterval(prerollWatchTimer);
  const old = media;
  const wasMuted = old.muted;
  old.pause();
  media = standbyEl;
  standbyEl = old;
  media.volume = old.volume;
  media.muted = wasMuted;
  setFrontEl(media);
  queueIndex += 1;
  playerState.textContent = queue.length > 1 ? `播放中 ${queueIndex + 1}/${queue.length}` : "播放中";
  applyStripLayout();
  loadStandbyNext();
}
function maybePreroll() {
  if (prerollOn || (currentSlot && currentSlot.audio)) return;
  if (!queue.length || queueIndex >= queue.length - 1) return;
  if (!isFinite(media.duration) || media.currentTime < media.duration - 1.5) return;
  if (standbyEl.readyState < 3) return; /* 后台未就绪则放弃预滚（走普通换轨） */
  prerollOn = true;
  const fire = () => {
    if (!prerollOn) return;
    try { standbyEl.currentTime = 0; } catch (e) {}
    standbyEl.volume = media.volume;
    standbyEl.muted = true; /* 静音预启动，交接瞬间才出声 */
    standbyEl.play().catch(() => {});
    let handed = false;
    const hand = () => {
      standbyEl.removeEventListener("timeupdate", hand);
      if (handed || !prerollOn) return;
      handed = true;
      handoverToStandby();
    };
    /* 首选：新段渲染出第 2 帧画面时交接（第1帧可能还在铺管线，第2帧最稳） */
    if (standbyEl.requestVideoFrameCallback) {
      standbyEl.requestVideoFrameCallback(() => standbyEl.requestVideoFrameCallback(hand));
    }
    /* 兜底1：不支持 rVFC 的浏览器用 timeupdate */
    standbyEl.addEventListener("timeupdate", hand);
    /* 兜底2：1.5s 仍未交接（如后台节流）→ 放弃预滚，交给 ended 冷切换 */
    setTimeout(() => {
      if (!handed && prerollOn) {
        prerollOn = false;
        standbyEl.removeEventListener("timeupdate", hand);
        try { standbyEl.pause(); } catch (e) {}
      }
    }, 1500);
  };
  const step = () => {
    if (!prerollOn) return;
    if (!playing || media.paused) { prerollOn = false; try { standbyEl.pause(); } catch (e) {} return; }
    if (media.currentTime >= media.duration - 0.4) { fire(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  /* rAF 在后台标签/锁屏会被暂停，加 40ms 轮询兜底，谁先到谁触发 */
  clearInterval(prerollWatchTimer);
  prerollWatchTimer = setInterval(() => {
    if (!prerollOn) { clearInterval(prerollWatchTimer); return; }
    if (!playing || media.paused) {
      clearInterval(prerollWatchTimer);
      prerollOn = false; try { standbyEl.pause(); } catch (e) {}
      return;
    }
    if (media.currentTime >= media.duration - 0.4) { clearInterval(prerollWatchTimer); fire(); }
  }, 40);
}
/* 无缝换轨：切到预载好的后台播放器继续播 */
async function swapToStandby() {
  const old = media;
  media = standbyEl;
  standbyEl = old;
  old.pause();
  media.muted = old.muted;
  media.volume = old.volume;
  setFrontEl(media);
}

async function playCurrentPart(startAt = 0) {
  playerState.textContent = queue.length > 1 ? `播放中 ${queueIndex + 1}/${queue.length}` : "播放中";
  const url = mediaUrl(queue[queueIndex]);
  if (media.src !== url) {
    lastDataAt = Date.now();
    starveStarted = 0;
    bufHist.length = 0;
    media.src = queue[queueIndex]; /* 已预载则不重载 */
  }
  if (startAt > 0) {
    joinPending = true; /* 定位完成前 currentTime 还停在 0，不能拿它去算"落后多少" */
    const seekWhenReady = () => { try { media.currentTime = startAt; } catch (e) {} };
    if (media.readyState >= 1) seekWhenReady(); /* 已预载好的播放器不会再触发 loadedmetadata */
    else media.addEventListener("loadedmetadata", seekWhenReady, { once: true });
  }
  await tryPlay(media);
}

/* ---------- 直播同步：在不打断播放的前提下向统一进度靠拢（每 2 秒看一次） ----------
   统一进度 = 当前时间 - 开播时刻。进度落后通常是"进场/缓冲花掉的时间"造成的。
   · 落后不超过 LIVE_TOLERANCE 秒：不管（几秒的差距属正常）
   · 落后较多：只在"要跳过去的位置已经缓冲好"时才往前跳——跳转不会触发加载、不会卡；
     缓冲不够就先照常播，等缓冲追上来再分几步补上
   · 落后超过 LIVE_HARD_RESYNC 秒（长时间切后台/锁屏/断网）：直接跳到直播位置（允许等加载）
   · 时钟已过本场结尾而画面还没播完：让视频自然播完，不掐断 */
const LIVE_TOLERANCE = 12;      /* 秒：落后在此以内不做任何调整 */
const LIVE_HARD_RESYNC = 120;   /* 秒：落后超过它就直接跳到直播位置 */
const LIVE_JUMP_MIN_GAIN = 6;   /* 秒：一次前跳至少要缩短这么多，太碎的小跳不做 */
const LIVE_JUMP_EDGE = 2.0;     /* 秒：落点离缓冲区末尾至少留这么多，跳过去立刻够得着 */

/* 把"本场已播秒数"换算成第几段的第几秒 */
function locateInQueue(t) {
  const durs = (currentSlot && currentSlot.partDurations) || [];
  let acc = 0;
  for (let i = 0; i < durs.length; i++) {
    if (t < acc + durs[i]) return { idx: i, offset: t - acc };
    acc += durs[i];
  }
  return { idx: queue.length, offset: 0 };
}
/* 当前画面相对统一进度落后了多少秒（负数 = 跑到了时钟前面） */
function liveBehindSec() {
  if (!currentSlot || !currentSlot.partDurations) return 0;
  let acc = 0;
  for (let i = 0; i < queueIndex && i < currentSlot.partDurations.length; i++) acc += currentSlot.partDurations[i];
  const pos = acc + (isFinite(media.currentTime) ? media.currentTime : 0);
  return (Date.now() - sessionStartMs) / 1000 - pos;
}
function liveSeekTo(offset) {
  try { media.currentTime = Math.min(offset, Math.max(0, (isFinite(media.duration) ? media.duration : offset) - 0.3)); } catch (e) {}
  starveStarted = 0; /* 这是有意跳转：缓冲耗尽的计时重新开始 */
}
function syncToLive(allowPaused) {
  if (!playing || !liveMode || !currentSlot || currentSlot.audio) return;
  if (!queue.length || !currentSlot.partDurations) return;
  if (prerollOn || joinPending || media.seeking || media.ended) return; /* 正在交接/进场定位/跳转/已到段尾：不去插手 */
  if (media.paused && !allowPaused) return;
  const loc = locateInQueue((Date.now() - sessionStartMs) / 1000);
  if (loc.idx >= queue.length) return; /* 时钟已过结尾：让画面自然播完 */
  const behind = liveBehindSec();
  if (behind <= LIVE_TOLERANCE) return;
  if (loc.idx === queueIndex) {
    if (behind > LIVE_HARD_RESYNC) { liveSeekTo(loc.offset); return; }
    /* 软追赶：在已缓冲的范围里，找"不超过统一进度、离它最近"的落点 */
    let best = null;
    try {
      const b = media.buffered;
      for (let i = 0; i < b.length; i++) {
        const cand = Math.min(loc.offset, b.end(i) - LIVE_JUMP_EDGE);
        if (cand > b.start(i) && cand > media.currentTime + LIVE_JUMP_MIN_GAIN && (best === null || cand > best)) best = cand;
      }
    } catch (e) {}
    if (best !== null) { try { media.currentTime = best; } catch (e) {} }
    return;
  }
  if (loc.idx > queueIndex) {
    /* 统一进度在后面的分段里：落后很多就直接切过去；否则等自然交接，到了新段再按上面的规则追 */
    if (behind > LIVE_HARD_RESYNC) {
      queueIndex = loc.idx;
      applyStripLayout();
      swapToStandby().then(() => { try { media.pause(); } catch (e) {} playCurrentPart(loc.offset); loadStandbyNext(); });
    }
  }
  /* 画面跑到时钟前面（设备时间被改等）：不处理 */
}
setInterval(() => syncToLive(false), 2000);

/* ---------- 共用媒体事件（video 与 audio 都挂载） ---------- */
function onMediaEvent(el) {
  el.addEventListener("play", () => { if (media === el) updateVbarIcon(true); });
  el.addEventListener("pause", () => { if (media === el) updateVbarIcon(false); });
  el.addEventListener("timeupdate", () => {
    if (media !== el || !isFinite(el.duration) || !el.duration) return;
    setBuffering(false); /* 保险丝：播放真正走动时必定隐藏加载提示 */
    vbFill.style.width = `${(el.currentTime / el.duration) * 100}%`;
    vbTime.textContent = `${fmtShort(el.currentTime)} / ${fmtShort(el.duration)}`;
    if (currentSlot && currentSlot.audio && media === el) {
      syncBgToTime(el.currentTime);
      syncSceneToTime(el.currentTime);
      prefetchUpcomingScenes(el.currentTime);
    }
    if (playing && media === el && queue.length > 1 && queueIndex < queue.length - 1) {
      /* 临近段尾（剩<90s）才让后台预载下一段：本段时间线内前台独占带宽，
         避免预载全速下载抢带宽导致播放卡顿 */
      loadStandbyNext();
      maybePreroll(); /* 临近段尾时进入预滚监视 */
    }
  });
  el.addEventListener("loadedmetadata", () => {
    if (media === el) vbTime.textContent = `0:00 / ${fmtShort(el.duration)}`;
  });
  el.addEventListener("ended", () => {
    if (media !== el || !playing) return;
    if (!currentSlot.audio && queueIndex < queue.length - 1) {
      advanceToNextPart();
      return;
    }
    finishSession();
  });
  el.addEventListener("volumechange", () => { if (media === el) updateMuteBadge(); });
  el.addEventListener("waiting", () => { if (media === el) setBuffering(true); });
  /* 记录"最近一次收到数据"的时刻：看门狗据此判断连接是死是活（慢网读视频头期间不算卡死） */
  el.addEventListener("progress", () => { if (media === el) lastDataAt = Date.now(); });
  /* 缓冲进度：显示已缓冲秒数，区分"在加载"与"卡死" */
  el.addEventListener("progress", () => {
    if (media !== el || !isFinite(el.duration) || bufferingEl.hidden) return;
    try {
      const b = el.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= el.currentTime && el.currentTime < b.end(i)) {
          const secs = Math.max(0, Math.floor(b.end(i) - el.currentTime));
          const t = bufferingEl.querySelector(".bf-text");
          if (t) t.textContent = secs > 0 ? `视频加载中…（已缓冲 ${secs} 秒）` : "视频加载中…";
          break;
        }
      }
    } catch (e) { /* 忽略 */ }
  });
  el.addEventListener("stalled", () => { if (media === el) setBuffering(true); });
  el.addEventListener("playing", () => {
    if (media !== el) return;
    clearStripFreeze(); /* 新画面真正出图，撤掉冻结帧 */
    playerWrap.classList.add("started"); /* 真正出画面：待机黄底此刻才淡出 */
    setBuffering(false);
    startBtn.hidden = true;
    pauseRescueTried = 0; /* 恢复正常播放：重置救治等级 */
    errRetries = 0;
    joinPending = false; /* 进场定位完成，同步逻辑可以开始工作 */
    firstByteWaitMs = 6000;
    playerWrap.classList.remove("preload-visual"); /* 正式开场：字幕/光芒/推镜一起启动 */
    if (!currentSlot || !currentSlot.audio) loadStandbyNext(); /* 开播即让后台预载下段 */
  });
  /* 冻结帧保险丝：条带模式下前台视频在走而画布还盖着 → 撤掉 */
  el.addEventListener("timeupdate", () => {
    if (media === el && stripFreezeCv && !stripFreezeCv.hidden && !el.paused && el.currentTime > 0.5) {
      clearStripFreeze();
    }
  });
  el.addEventListener("canplay", () => { if (media === el) setBuffering(false); });
  /* 加载出错（连接被断、服务器报错等）：不等看门狗，直接换连接重连 */
  el.addEventListener("error", () => {
    const code = el.error ? el.error.code : 0;
    if (el !== media) {
      /* 待命播放器预载失败：清掉，稍后重新预载 */
      if (code !== 1) { standbyArmedIdx = -1; try { el.removeAttribute("src"); el.load(); } catch (e) {} }
      return;
    }
    if (!playing || code === 1) return; /* MEDIA_ERR_ABORTED：我们自己换源造成的，不算错 */
    errRetries += 1;
    lastDataAt = Date.now(); /* 这次重连交给这里处理，看门狗先别插手 */
    if (errRetries > 8) { setBuffering(false); startBtn.hidden = false; return; }
    const at = el.currentTime;
    showToast("网络中断，正在重连续播", "info", 2500);
    setTimeout(() => { if (playing && media === el) recoverStall(at); }, 1500);
  });
}
onMediaEvent(video);
onMediaEvent(video2);
onMediaEvent(audioEl);

/* 冷路径接力：当前段已播完，切到后台播放器播下一段（下一段通常已预载好） */
function advanceToNextPart() {
  if (queueIndex >= queue.length - 1) return;
  queueIndex += 1;
  /* 作废预滚（其回调有 prerollOn 守卫，不会二次交接） */
  prerollOn = false;
  clearInterval(prerollWatchTimer);
  freezeStripFrame(media); /* 冷切换加载期间垫住字幕条 */
  applyStripLayout();
  const old = media;
  media = standbyEl;
  standbyEl = old;
  old.pause();
  media.muted = old.muted;
  media.volume = old.volume;
  setFrontEl(media);
  playerState.textContent = queue.length > 1 ? `播放中 ${queueIndex + 1}/${queue.length}` : "播放中";
  ensurePlaying(media);
  loadStandbyNext();
}

function finishSession() {
  joinPending = false;
  prerollOn = false;
  clearInterval(prerollWatchTimer);
  standbyArmedIdx = -1;
  clearStripFreeze();
  applyStripLayout();
  if (currentSlot) finishedToday.add(finishKey(currentSlot));
  playing = false;
  liveMode = false;
  currentSlot = null;
  currentSceneKey = "";
  media.pause();
  video2.pause();
  try { media.currentTime = 0; } catch (e) { /* 忽略 */ }
  media.muted = false;
  unmuteBtn.hidden = true;
  startBtn.hidden = true;
  playerWrap.classList.remove("playing", "audio-mode", "preload-visual", "started");
  stripA.classList.remove("show");
  stripB.classList.remove("show");
  bgSc.classList.remove("show");
  bgB.classList.remove("show");
  bgSc.hidden = true;
  bgB.hidden = true;
  stripA.hidden = true;
  stripB.hidden = true;
  glowEl.hidden = true;
  currentBgKey = "";
  playerState.classList.remove("playing");
  playerState.textContent = "待机";
  showToast("本场播放已结束", "ok");
  updateUI();
  if (typeof swReloadPending !== "undefined" && swReloadPending) {
    setTimeout(() => location.reload(), 1500); /* 推迟的版本更新此刻生效 */
  }
}

/* 禁止手动控制入口 */
video.addEventListener("contextmenu", (e) => e.preventDefault());
video2.addEventListener("contextmenu", (e) => e.preventDefault());

/* ---------- 播放器外观栏 ---------- */
function fmtShort(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function updateVbarIcon(isPlaying) {
  vbPlay.style.display = isPlaying ? "none" : "";
  vbPause.style.display = isPlaying ? "" : "none";
}

function setBuffering(on) {
  if (playing) bufferingEl.hidden = !on;
  else bufferingEl.hidden = true;
}

/* ---------- 静音徽标 ---------- */
let unmuteTimer = null;
function updateMuteBadge() {
  clearTimeout(unmuteTimer);
  if (media.muted) {
    unmuteBtn.hidden = false;
    unmuteBtn.classList.add("muted");
    unmuteBtn.innerHTML = '<span class="mute-ic">🔇</span>开声音';
  } else if (playing) {
    unmuteBtn.hidden = false;
    unmuteBtn.classList.remove("muted");
    unmuteBtn.innerHTML = '<span class="mute-ic">🔊</span>有声';
    unmuteTimer = setTimeout(() => { unmuteBtn.hidden = true; }, 3000);
  } else {
    unmuteBtn.hidden = true;
    unmuteBtn.classList.remove("muted");
  }
}
unmuteBtn.addEventListener("click", () => { media.muted = false; });
video.addEventListener("volumechange", () => { if (standbyEl && media === video) { standbyEl.muted = video.muted; standbyEl.volume = video.volume; } });
video2.addEventListener("volumechange", () => { if (standbyEl && media === video2) { standbyEl.muted = video2.muted; standbyEl.volume = video2.volume; } });

/* ---------- 微信内就绪后补一次播放（兼容已就绪/未就绪两种时序） ---------- */
function wxReady(cb) {
  if (window.WeixinJSBridge) { cb(); return; }
  document.addEventListener("WeixinJSBridgeReady", cb, false);
}
wxReady(() => {
  setTimeout(() => {
    if (playing && media && media.paused && media.src) {
      ensurePlaying(media);
    }
  }, 50);
});

/* ---------- 点击页面任意位置：开声音 / 预授权 ---------- */
let primed = false;
document.addEventListener("click", async () => {
  if (playing && media.muted) {
    media.muted = false;
    return;
  }
  if (!playing && !primed && media.src) {
    primed = true;
    try {
      await media.play();
      media.pause();
      try { media.currentTime = 0; } catch (e) { /* 忽略 */ }
      showToast("已就绪：到点将自动有声播放", "ok", 2000);
    } catch (e) { /* 忽略 */ }
  }
});

/* ---------- 屏幕常亮 ---------- */
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
      wakeHint.textContent = "已开启屏幕常亮";
    } else {
      wakeHint.textContent = "当前浏览器不支持屏幕常亮，建议手动设置设备不休眠";
    }
  } catch (e) {
    wakeHint.textContent = "屏幕常亮开启失败，建议手动设置设备不休眠";
  }
}
/* 回前台恢复：先把进度对齐到全群统一的时间线（规则见 syncToLive），再续播 */
function resumeAfterBackground() {
  if (!playing || !currentSlot || !media.src) return;
  setTimeout(() => {
    if (!playing || !media.paused || !media.src) return;
    if (!liveMode && media.ended) return; /* 测试模式已自然播完不复活 */
    if (liveMode && (Date.now() - sessionStartMs) / 1000 >= sessionDurationSec(currentSlot)) { finishSession(); return; }
    if (media.ended) {
      /* 在后台时这一段正好播完了：先接到下一段，之后由 syncToLive 对齐进度 */
      if (queueIndex < queue.length - 1) advanceToNextPart();
      else finishSession();
      return;
    }
    syncToLive(true);
    ensurePlaying(media);
    /* 视频模式顺带确认后台预载还在 */
    if (!currentSlot.audio && queue.length > 1) loadStandbyNext();
  }, 200);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!wakeLock) requestWakeLock();
  resumeAfterBackground();
});
/* iOS 从 bfcache 恢复页面时也会暂停视频：pageshow 补救一次 */
window.addEventListener("pageshow", (e) => {
  if (e.persisted) resumeAfterBackground();
  else if (playing && media.src && media.paused && !media.ended) {
    ensurePlaying(media);
  }
});

/* ---------- 场次列表（动态渲染） ---------- */
function renderSlots() {
  slotsEl.innerHTML = "";
  for (const slot of SCHEDULE) {
    const row = document.createElement("div");
    row.className = "slot";
    row.dataset.id = slot.id;
    const time = document.createElement("span");
    time.className = "slot-time";
    time.textContent = slot.time;
    const name = document.createElement("span");
    name.className = "slot-name";
    name.textContent = slot.name;
    const state = document.createElement("span");
    state.className = "slot-state";
    state.textContent = "待播放";
    row.append(time, name, state);
    slotsEl.appendChild(row);
  }
}
function setSlotState(slot, text) {
  const row = slotsEl.querySelector(`.slot[data-id="${slot.id}"]`);
  if (row) row.querySelector(".slot-state").textContent = text;
}

/* ---------- 界面刷新 ---------- */
function nextSlotInfo() {
  const now = new Date();
  const t = now.getTime();
  let best = null;
  for (const slot of SCHEDULE) {
    if (isPlayed(slot) && !(playing && currentSlot === slot)) continue;
    const start = slotDate(slot).getTime();
    if (t < start && (!best || start < slotDate(best).getTime())) best = slot;
  }
  if (best) return { slot: best, date: now };
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  best = SCHEDULE[0];
  for (const slot of SCHEDULE) {
    if (slotDate(slot, tomorrow) < slotDate(best, tomorrow)) best = slot;
  }
  return { slot: best, date: tomorrow };
}

function updateUI() {
  const now = new Date();
  clockEl.textContent = now.toTimeString().slice(0, 8);
  dateEl.textContent = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()]
    + ` · ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;

  const live = liveSession();
  for (const slot of SCHEDULE) {
    if (playing && currentSlot === slot) { setSlotState(slot, "播放中"); continue; }
    const start = slotDate(slot).getTime();
    if (live && live.slot === slot) {
      setSlotState(slot, finishedToday.has(finishKey(slot)) ? "播放结束" : "播放中");
      continue;
    }
    if (isPlayed(slot)) { setSlotState(slot, "播放结束"); continue; }
    setSlotState(slot, now.getTime() < start ? "待播放" : "播放结束");
  }

  const next = nextSlotInfo();
  const isTomorrow = next.date.toDateString() !== now.toDateString();
  const ms = slotDate(next.slot, next.date).getTime() - now.getTime();
  countdownEl.textContent = (isTomorrow ? `明天 ${next.slot.time} ` : `下一场 ${next.slot.time} `)
    + `${next.slot.name}，还有 ${formatSpan(ms)}`;

  /* 待机层与预载 */
  if (!playing) {
    sbLabel.textContent = isTomorrow ? "明天将播放" : "下一场将播放";
    sbName.textContent = next.slot.name;
    sbTime.textContent = next.slot.time;
    sbCountdown.textContent = `距自动播放还有 ${formatSpan(ms)}`;
    if (next.slot.audio) {
      const url = new URL(next.slot.audio, location.href).href;
      if (video.src !== url) video.src = next.slot.audio; /* 预载下一场音频（经视频元素） */
    } else if (next.slot.videos && next.slot.videos.length) {
      const url = new URL(next.slot.videos[0], location.href).href;
      if (video.src !== url) video.src = next.slot.videos[0];
    }
  }
}

function formatSpan(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${sec} 秒`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

/* ---------- 主循环 ---------- */
function tick() {
  if (!playing) checkSchedule();
  updateUI();
  counterTick();
}

/* ---------- 一键添加到手机桌面（安卓 beforeinstallprompt；iOS/微信给指引） ---------- */
const installBtn = document.getElementById("install-btn");
let installPromptEvent = null;
const standaloneMode = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
window.addEventListener("beforeinstallprompt", (e) => {
  if (standaloneMode()) return; /* 已安装过 */
  e.preventDefault();
  installPromptEvent = e;
  installBtn.hidden = false;
});
installBtn.addEventListener("click", async () => {
  if (installPromptEvent) {
    installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice.catch(() => null);
    installPromptEvent = null;
    if (choice && choice.outcome === "accepted") {
      installBtn.hidden = true;
      showToast("已添加到桌面 🎉", "ok");
    }
    return;
  }
  /* 平台不支持一键安装：给出对应指引 */
  const ua = navigator.userAgent;
  if (/MicroMessenger/i.test(ua)) showToast("微信内请点右上角 ··· → 在浏览器打开，再试一次", "info", 5000);
  else if (/iPhone|iPad|iPod/i.test(ua)) showToast("请点 Safari 底部「分享」按钮 → 添加到主屏幕", "info", 5000);
  else showToast("请用浏览器菜单中的「添加到主屏幕 / 安装应用」", "info", 5000);
});
window.addEventListener("appinstalled", () => { installBtn.hidden = true; });

/* ---------- 刷新按钮 ---------- */
document.getElementById("refresh-btn").addEventListener("click", () => location.reload());

/* ---------- 横屏全屏（真全屏优先，不支持自动伪全屏） ---------- */
const fsBtn = document.getElementById("fs-btn");
const fsOpen = document.getElementById("fs-open");
const fsClose = document.getElementById("fs-close");
const fsExitBtn = document.getElementById("fs-exit");
let fakeFs = false;

function fsActive() { return !!document.fullscreenElement || fakeFs; }
function updateFsUI() {
  const on = fsActive();
  fsOpen.style.display = on ? "none" : "";
  fsClose.style.display = on ? "" : "none";
  fsExitBtn.hidden = !on;
}
async function exitFullscreenMode() {
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch (e) { /* 忽略 */ }
  }
  fakeFs = false;
  document.body.classList.remove("fs-fake");
  updateFsUI();
}
async function toggleFullscreen() {
  if (fsActive()) { exitFullscreenMode(); return; }
  if (playerWrap.requestFullscreen) {
    try {
      await playerWrap.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(() => {});
      }
      return;
    } catch (e) { /* 退回伪全屏 */ }
  }
  fakeFs = true;
  document.body.classList.add("fs-fake");
  updateFsUI();
}
fsBtn.addEventListener("click", toggleFullscreen);
fsExitBtn.addEventListener("click", exitFullscreenMode);
document.addEventListener("fullscreenchange", updateFsUI);

/* ---------- 启动 ---------- */
function initApp() {
  renderSlots();
  requestWakeLock();
  tick();
  setInterval(tick, 1000);
  /* 测试播放：?play=am|pm 从头播放预览（非同步模式） */
  const want = new URLSearchParams(location.search).get("play");
  if (want) {
    const slot = SCHEDULE.find((s) => s.id === want);
    if (slot) {
      showToast(`测试播放：${slot.name}`, "info", 2000);
      startPlay(slot, { test: true });
    } else {
      showToast(`没有找到场次 "${want}"（可用：${SCHEDULE.map((s) => s.id).join(" / ")}）`, "error", 4000);
    }
  }
}

fetch(new Request("config.json", { cache: "no-store" }))
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("http " + r.status))))
  .then((cfg) => {
    if (cfg && Array.isArray(cfg.schedule) && cfg.schedule.length) {
      SCHEDULE = cfg.schedule;
      GRACE_MIN = typeof cfg.graceMin === "number" && cfg.graceMin > 0 ? cfg.graceMin : DEFAULT_GRACE_MIN;
    }
  })
  .catch(() => { /* 离线或缺失：使用默认 */ })
  .finally(initApp);

/* ---------- 分时段访问统计（Abacus 免费计数服务，实时显示） ---------- */
const COUNT_WINDOWS = [
  { id: "am", label: "早课", start: "05:00", end: "06:30" },
  { id: "pm", label: "晚课", start: "19:30", end: "22:00" },
];
const ABACUS = "https://abacus.jasoncameron.dev";
const ABACUS_NS = "jjq-toolbox-shouyueliang";
const counterEl = document.getElementById("visit-count");

function countWindowAt(now) {
  const m = now.getHours() * 60 + now.getMinutes();
  for (const w of COUNT_WINDOWS) {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    if (m >= sh * 60 + sm && m < eh * 60 + em) return w;
  }
  return null;
}
function counterKey(w, day) { return `${dayKey(day)}-${w.id}`; }

let lastCountTick = 0;
function counterTick() {
  /* 进入时段且本设备未计数 → +1 */
  const w = countWindowAt(new Date());
  if (w) {
    const flag = "jjq_counted_" + counterKey(w, new Date());
    let counted = false;
    try { counted = localStorage.getItem(flag) === "1"; } catch (e) { /* 忽略 */ }
    if (!counted) {
      try { localStorage.setItem(flag, "1"); } catch (e) { /* 忽略 */ }
      fetch(`${ABACUS}/hit/${ABACUS_NS}/${counterKey(w, new Date())}`).catch(() => {}).finally(refreshCounts);
    }
  }
  /* 每 60 秒刷新显示 */
  const nowMs = Date.now();
  if (nowMs - lastCountTick > 60000) {
    lastCountTick = nowMs;
    refreshCounts();
  }
}

async function refreshCounts() {
  if (!counterEl) return;
  const day = new Date();
  const live = countWindowAt(day);
  const reads = await Promise.all(COUNT_WINDOWS.map(async (w) => {
    try {
      const r = await fetch(`${ABACUS}/get/${ABACUS_NS}/${counterKey(w, day)}`, { cache: "no-store" });
      const j = await r.json();
      return { w, n: j.value || 0 };
    } catch (e) { return { w, n: null }; }
  }));
  counterEl.hidden = false;
  counterEl.textContent = "";
  const lead = document.createElement("span");
  lead.textContent = "今日到访：";
  counterEl.appendChild(lead);
  reads.forEach(({ w, n }, i) => {
    if (i) counterEl.appendChild(document.createTextNode(" · "));
    const isLive = live && live.id === w.id;
    if (isLive) {
      const dot = document.createElement("span");
      dot.className = "live-dot";
      counterEl.appendChild(dot);
    }
    const span = document.createElement("span");
    span.textContent = `${w.label} `;
    const num = document.createElement("b");
    num.className = "cnt";
    num.textContent = n || 0; /* 无数据/未到访一律显示 0 */
    span.appendChild(num);
    span.appendChild(document.createTextNode(" 人"));
    if (isLive) span.className = "live-num";
    counterEl.appendChild(span);
  });
}
counterTick();

/* ---------- Toast ---------- */
function showToast(message, type = "info", duration = 2600) {
  let container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("hide");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, duration);
}

/* ---------- Service Worker（PWA 离线 + 版本自愈） ---------- */
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      /* 浏览器对缓存脚本的更新检查有节流（不是每次打开都查）；这里每次打开都主动查一次，
         让线上的修复在下一次打开页面时就能到达已访问过的人 */
      .then((reg) => { reg.update().catch(() => {}); })
      .catch(() => {});
  });
  let swReloaded = false;
  let swReloadPending = false; /* 播放中遇到更新：推迟到本场结束再刷新 */
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloaded || !navigator.serviceWorker.controller) return;
    swReloaded = true;
    if (playing) {
      swReloadPending = true; /* 不打断播放，结束后再刷新 */
    } else {
      location.reload();
    }
  });
}
