/* ==========================================================
   工具箱 — 定时播放（直播式同步版）
   ------------------------------------------------------------
   - 支持两种场次模式（config.json）：
     · 音频+图片：{ audio, scenes:[{t,img}] }  ← 推荐，秒开、可精准同步
     · 视频：     { videos:[...] }（多段连播，兼容保留）
   - 直播式同步：任何人任意时刻打开，进度 = 当前时间 - 开播时间，
     与所有人一致；播放中每 15 秒校准一次防漂移
   - 配置优先读线上 config.json，失败用内置默认
   ========================================================== */
"use strict";

/* ---------- 内置默认计划（兜底，简版；完整场景表在 config.json） ---------- */
const DEFAULT_SCHEDULE = [
  {
    id: "am", name: "早课", time: "05:30",
    videos: ["test-media/am-i0.mp4"],
    durationSec: 3738.13,
  },
  {
    id: "pm", name: "晚课", time: "20:00",
    videos: ["test-media/pm-i0.mp4"],
    durationSec: 7352.8,
  },
];
const DEFAULT_GRACE_MIN = 15; /* 兜底：无时长信息时的最短进场窗口 */
const SESSION_TAIL_SEC = 120; /* 结束后的缓冲窗口 */

let SCHEDULE = DEFAULT_SCHEDULE;
let GRACE_MIN = DEFAULT_GRACE_MIN;
let MIRRORS = []; /* 备用线路基地址（config.json mirrors），主线路拥堵时轮换 */

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

/* ---------- 线路与地址：本站在首位，mirrors 依次补充；轮换时跳过自身 ---------- */
let baseIdx = 0;
function lineOrigins() {
  const list = [location.origin];
  for (const m of MIRRORS) {
    try {
      const o = new URL(m).origin;
      if (o !== location.origin && !list.includes(o)) list.push(o);
    } catch (e) { /* 忽略无效镜像 */ }
  }
  return list;
}
function mediaUrl(rel) {
  const bases = lineOrigins();
  const b = bases[Math.min(baseIdx, bases.length - 1)] || bases[0];
  return new URL(rel, b + "/").href;
}

/* ---------- 卡死/龟速/静默暂停 自愈看门狗 ----------
   ① 30s 窗口进度<5s（龟速/停顿）→ 换线路重连续播
   ② 播放中却处于暂停态（play被拒等）→ 自动续播，失败降级静音续播，再失败给手动按钮 */
let stallTicks = []; /* [{t:墙钟ms, p:播放位置}] 滑动窗口 */
let pauseRescueTried = 0;
function hardResume() {
  if (pauseRescueTried === 0) {
    media.play().catch(() => {});
  } else if (pauseRescueTried === 1) {
    media.muted = true;
    updateMuteBadge();
    media.play().then(() => showToast("已恢复播放（静音），点击画面开声音", "info", 4000)).catch(() => {});
  } else {
    startBtn.hidden = false; /* 彻底被禁：手动按钮兜底 */
  }
  pauseRescueTried += 1;
}
setInterval(() => {
  if (!playing) { stallTicks = []; pauseRescueTried = 0; return; }
  if (!media.src) { stallTicks = []; return; }
  if (media.ended) { stallTicks = []; return; }
  /* 救治异常暂停：播放会话中不应长时间暂停 */
  if (media.paused) {
    if (pauseRescueTried <= 3) hardResume();
    return;
  }
  pauseRescueTried = 0;
  const now = Date.now();
  const p = media.currentTime;
  stallTicks.push({ t: now, p });
  while (stallTicks.length && now - stallTicks[0].t > 30500) stallTicks.shift();
  const first = stallTicks[0];
  const spanMs = now - first.t;
  const prog = p - first.p;
  if (spanMs >= 30000 && prog < 5) { /* 30 秒只走了不到 5 秒：龟速/停顿，换线 */
    stallTicks = [];
    recoverStall(p);
  }
}, 2000);
function recoverStall(t) {
  /* 中止预滚/待命，避免旧连接残留 */
  prerollOn = false;
  clearInterval(prerollWatchTimer);
  standbyArmedIdx = -1;
  try { standbyEl.pause(); } catch (e) {}
  freezeStripFrame(media); /* 垫住字幕条，重连期间画面完整 */
  /* 轮换到下一条线路（跳过自身之外的可用线路），带 cache-bust 重开连接 */
  baseIdx = (baseIdx + 1) % Math.max(1, lineOrigins().length);
  const which = baseIdx === 0 ? "主线路" : `备用线路 ${baseIdx}`;
  showToast(`网络波动，已切换到${which}续播`, "info", 3000);
  const wasMuted = media.muted;
  const url = mediaUrl(queue[queueIndex] || (currentSlot && currentSlot.videos && currentSlot.videos[0]) || "");
  media.src = url + (url.includes("?") ? "&" : "?") + "rs=" + Date.now();
  const onMeta = () => {
    media.removeEventListener("loadedmetadata", onMeta);
    try { media.currentTime = Math.min(t, Math.max(0, (isFinite(media.duration) ? media.duration : t) - 0.3)); } catch (e) {}
    media.muted = wasMuted;
    media.play().catch(() => { media.muted = true; media.play().catch(() => {}); });
  };
  media.addEventListener("loadedmetadata", onMeta);
  /* 兜底：重连后 6 秒仍未真正开播（play 被拒/数据仍不通），交给看门狗的暂停救治路径 */
  setTimeout(() => {
    if (playing && media.paused) hardResume();
  }, 6000);
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

/* ---------- 字幕条冻结帧：加载/换线期间用画布垫住下1/3，画面不缺角 ---------- */
function freezeStripFrame(el) {
  if (!stripFreezeCv || !playerWrap.classList.contains("strip-mode")) return;
  try {
    const vw = el.videoWidth, vh = el.videoHeight;
    if (!vw || !vh) return;
    stripFreezeCv.width = 854; stripFreezeCv.height = 160;
    const ctx = stripFreezeCv.getContext("2d");
    if (vh / vw > 0.21) {
      /* 全画面视频（片头片尾）：截取其下1/3 */
      ctx.drawImage(el, 0, vh * 2 / 3, vw, vh / 3, 0, 0, 854, 160);
    } else {
      /* 已是条带视频：整幅 */
      ctx.drawImage(el, 0, 0, vw, vh, 0, 0, 854, 160);
    }
    stripFreezeCv.hidden = false;
  } catch (e) { /* 跨域画布污染等：忽略，退回原有表现 */ }
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
  let started = false;
  try { await el.play(); started = true; } catch (e) { /* 尝试静音 */ }
  if (!started) {
    try { el.muted = true; await el.play(); started = true; } catch (e) { /* 静音也被禁 */ }
  }
  if (!started) {
    /* 明确被拒：直接给手动按钮 */
    setBuffering(false);
    startBtn.hidden = false;
    return;
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
startBtn.addEventListener("click", async () => {
  startBtn.hidden = true;
  try {
    await media.play();
  } catch (e) {
    media.muted = true;
    media.play().catch(() => {});
  }
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
function loadStandbyNext(force = false) {
  if (!standbyEl || playing === false || !queue.length) return;
  const next = queue[queueIndex + 1];
  if (!next) return;
  if (standbyArmedIdx === queueIndex) return; /* 本段已预载过 */
  if (!force) {
    if (!isFinite(media.duration)) return;
    if (media.duration - media.currentTime > 150) return; /* 未到预载窗口：先让前台独占带宽（拥塞线路需要更长预热） */
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
  if (media.src !== url) media.src = queue[queueIndex]; /* 已预载则不重载 */
  if (startAt > 0) {
    media.addEventListener("loadedmetadata", () => { media.currentTime = startAt; }, { once: true });
  }
  await tryPlay(media);
}

/* ---------- 直播同步校准（防缓冲造成的漂移；视频模式可跨段校正） ---------- */
setInterval(() => {
  if (!playing || !liveMode || media.paused) return;
  const target = (Date.now() - sessionStartMs) / 1000;
  if (!currentSlot) return;
  if (currentSlot.audio) {
    if (isFinite(media.duration) && target < media.duration && Math.abs(media.currentTime - target) > 15) {
      media.currentTime = target;
    }
  } else if (currentSlot.partDurations && queue.length) {
    /* 换算目标时间所在分段与段内偏移 */
    let acc = 0, idx = 0, offset = target;
    for (let i = 0; i < currentSlot.partDurations.length; i++) {
      if (target < acc + currentSlot.partDurations[i]) { idx = i; offset = target - acc; break; }
      acc += currentSlot.partDurations[i];
      idx = i + 1;
      offset = 0;
    }
    if (idx >= queue.length) { finishSession(); return; } /* 直播时刻已过本场结尾 */
    if (idx !== queueIndex) {
      if (prerollOn) { /* 跨段校正接管：作废预滚，防其回调二次交接 */
        prerollOn = false;
        clearInterval(prerollWatchTimer);
        try { standbyEl.pause(); } catch (e) {}
      }
      queueIndex = idx;
      applyStripLayout();
      swapToStandby().then(() => { playCurrentPart(offset); loadStandbyNext(); });
    } else if (isFinite(video.duration) && Math.abs(video.currentTime - offset) > 15) {
      video.currentTime = offset;
    }
  }
}, 15000);

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
      queueIndex += 1;
      /* ended 冷路径接管：作废预滚（其回调有 prerollOn 守卫，不会二次交接） */
      prerollOn = false;
      clearInterval(prerollWatchTimer);
      freezeStripFrame(media); /* 冷切换加载期间垫住字幕条 */
      applyStripLayout();
      /* 无缝接力：同步换轨（已预载+预热），零间隙零微任务延迟 */
      const old = media;
      media = standbyEl;
      standbyEl = old;
      old.pause();
      media.muted = old.muted;
      media.volume = old.volume;
      setFrontEl(media);
      playerState.textContent = queue.length > 1 ? `播放中 ${queueIndex + 1}/${queue.length}` : "播放中";
      media.play().catch(() => {
        media.muted = true;
        media.play().catch(() => {});
      });
      loadStandbyNext();
      return;
    }
    finishSession();
  });
  el.addEventListener("volumechange", () => { if (media === el) updateMuteBadge(); });
  el.addEventListener("waiting", () => { if (media === el) setBuffering(true); });
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
    playerWrap.classList.remove("preload-visual"); /* 正式开场：字幕/光芒/推镜一起启动 */
    if (!currentSlot || !currentSlot.audio) loadStandbyNext(); /* 开播即让后台预载下段 */
  });
  el.addEventListener("canplay", () => { if (media === el) setBuffering(false); });
}
onMediaEvent(video);
onMediaEvent(video2);
onMediaEvent(audioEl);

function finishSession() {
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
      media.play().catch(() => {});
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
/* 回前台恢复：直播模式先校准到全群统一时间线（now - 开播时刻），再续播 */
function resumeAfterBackground() {
  if (!playing || !currentSlot || !media.src) return;
  setTimeout(() => {
    if (!playing || media.paused === false || !media.src) return;
    if (media.ended && !liveMode) return; /* 测试模式已自然播完不复活 */
    if (liveMode) {
      /* 直播同步：跳到所有人一致的时间点，而不是从暂停处继续 */
      const target = (Date.now() - sessionStartMs) / 1000;
      if (target >= sessionDurationSec(currentSlot)) { finishSession(); return; }
      try {
        media.currentTime = Math.min(target, Math.max(0, (isFinite(media.duration) ? media.duration : target) - 0.5));
      } catch (e) { /* seek 失败则原位续播 */ }
    } else if (media.ended) {
      return;
    }
    media.play().catch(() => {
      /* 自动续播被拒（iOS 未获得手势授权）：静音续播保画面，提示点开声音 */
      media.muted = true;
      media.play().then(() => {
        updateMuteBadge();
        showToast("已恢复播放（静音），点击画面开声音", "info", 4000);
      }).catch(() => {
        startBtn.hidden = false; /* 彻底被禁：给手动按钮 */
      });
    });
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
    media.play().catch(() => {});
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
    if (cfg && Array.isArray(cfg.mirrors)) MIRRORS = cfg.mirrors.filter((m) => typeof m === "string" && m);
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
    navigator.serviceWorker.register("sw.js").catch(() => {});
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
