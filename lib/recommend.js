/**
 * AI 推荐引擎（纯函数；服务端 lib/index.js 与 CI 每日精选脚本共用）。
 * 无网络、无 IO：输入归一化后的仓库列表（normalizeRepo 输出形态）与已安装集合，
 * 输出「猜你喜欢 / 热门趋势 / 新上架 / 每日精选」四组推荐与规则理由。
 *
 * 每日精选为确定性轮换：同一天所有用户看到同一批，日期变化自动换批；
 * 猜你喜欢为内容相似度（分类 + 标签），基于用户已安装插件画像。
 * 全部算法可离线运行、可单测（时间注入 now/dateStr）。
 */

/** 32 位 FNV-1a 哈希（确定性；用于日期种子与稳定轮换排序）。 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 确定性伪随机数发生器（种子整数 → [0,1) 序列）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 日期字符串 → 种子整数（"YYYY-MM-DD"，UTC）。 */
export function dateSeed(dateStr) {
  return fnv1a("daily:" + dateStr);
}

/** 今日日期字符串（UTC，YYYY-MM-DD）。 */
export function todayStr(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 质量门槛：0-star 玩具/垃圾仓库不进推荐池。
 * 社区收录（community-pick）或人工验证通过（verified-install）不受 star 门槛限制；
 * 已归档 / 非插件（installable=non-plugin）一律排除。
 */
export function isQuality(repo, { minStars = 5 } = {}) {
  if (repo.archived === true) return false;
  if (repo.installable === "non-plugin") return false;
  const tags = Array.isArray(repo.market_tags) ? repo.market_tags : [];
  if (tags.includes("community-pick") || tags.includes("verified-install")) return true;
  return (repo.stargazers_count ?? 0) >= minStars;
}

/**
 * 用户画像：已安装仓库的 分类权重（×3）+ 主题权重（每个标签 +1）。
 * 分类只统计非 other（other 无区分度）；主题按小写归一。
 */
export function buildProfile(installedRepos) {
  const categories = new Map();
  const topics = new Map();
  for (const repo of installedRepos) {
    const cat = repo.category && repo.category !== "other" ? repo.category : null;
    if (cat) categories.set(cat, (categories.get(cat) ?? 0) + 3);
    for (const t of Array.isArray(repo.topics) ? repo.topics : []) {
      const k = String(t).toLowerCase();
      topics.set(k, (topics.get(k) ?? 0) + 1);
    }
  }
  return { categories, topics, total: installedRepos.length };
}

/**
 * 猜你喜欢候选评分：分类命中（权重来自画像）+ 主题重叠 + log 星级微调。
 * @returns {{ score: number, hitCategories: string[], hitTopics: string[] }}
 */
export function scoreGuess(repo, profile) {
  let score = 0;
  const hitCategories = [];
  const hitTopics = [];
  const cat = repo.category && repo.category !== "other" ? repo.category : null;
  if (cat && profile.categories.has(cat)) {
    score += profile.categories.get(cat);
    hitCategories.push(cat);
  }
  for (const t of Array.isArray(repo.topics) ? repo.topics : []) {
    const k = String(t).toLowerCase();
    if (profile.topics.has(k)) {
      score += profile.topics.get(k);
      hitTopics.push(String(t));
    }
  }
  if (score > 0) score += Math.log10((repo.stargazers_count ?? 0) + 1) * 2;
  return { score, hitCategories, hitTopics };
}

/**
 * 猜你喜欢：按画像相似度取 topN，排除已装与 excludeIds。
 * 理由由 labels 组合（guessSameCat 前缀 + 分类名 / guessTopics 前缀 + 标签名）。
 */
export function recommendGuess(plugins, profile, { excludeIds = [], limit = 6, minStars = 3, labels = {} } = {}) {
  const exclude = new Set((excludeIds ?? []).map((x) => String(x).toLowerCase()));
  const scored = [];
  for (const repo of plugins) {
    if (exclude.has(String(repo.full_name ?? "").toLowerCase())) continue;
    if (!isQuality(repo, { minStars })) continue;
    const { score, hitCategories, hitTopics } = scoreGuess(repo, profile);
    if (score <= 0) continue;
    scored.push({ repo, score, hitCategories, hitTopics });
  }
  scored.sort((a, b) => b.score - a.score);
  const catName = (id) => (labels.category && labels.category[id]) || id;
  return scored.slice(0, limit).map(({ repo, score, hitCategories, hitTopics }) => {
    const reasons = [];
    if (hitCategories.length > 0) reasons.push(`${labels.guessSameCat ?? "你已安装同类插件："}${hitCategories.map(catName).join("、")}`);
    if (hitTopics.length > 0) reasons.push(`${labels.guessTopics ?? "与你的常用标签相关："}${hitTopics.slice(0, 3).join("、")}`);
    return { repo, score, reasons };
  });
}

/** 热门趋势评分：log(star) + 近 30 天更新加成 + 近 7 天再加成 + 社区/验证徽章加成。 */
export function scoreTrending(repo, now = new Date()) {
  let score = Math.log10((repo.stargazers_count ?? 0) + 1) * 10;
  const updated = repo.updated_at ? Date.parse(repo.updated_at) : 0;
  if (updated && now.getTime() - updated < 7 * 86400e3) score += 20;
  else if (updated && now.getTime() - updated < 30 * 86400e3) score += 12;
  const tags = Array.isArray(repo.market_tags) ? repo.market_tags : [];
  if (tags.includes("community-pick")) score += 8;
  if (tags.includes("verified-install")) score += 10;
  return score;
}

/** 热门趋势：按综合热度取 topN，排除已装与 excludeIds。 */
export function recommendTrending(plugins, { excludeIds = [], limit = 6, minStars = 10, now = new Date(), labels = {} } = {}) {
  const exclude = new Set((excludeIds ?? []).map((x) => String(x).toLowerCase()));
  const scored = [];
  for (const repo of plugins) {
    if (exclude.has(String(repo.full_name ?? "").toLowerCase())) continue;
    if (!isQuality(repo, { minStars })) continue;
    scored.push({ repo, score: scoreTrending(repo, now) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ repo, score }) => ({ repo, score, reasons: qualityReasons(repo, labels, now) }));
}

/** 新上架：registry_seen_at 缺失时回退 updated_at；按入库先后取近期 topN。 */
export function recommendFresh(plugins, { excludeIds = [], limit = 6, minStars = 3, days = 14, now = new Date(), labels = {} } = {}) {
  const exclude = new Set((excludeIds ?? []).map((x) => String(x).toLowerCase()));
  const window = days * 86400e3;
  const scored = [];
  for (const repo of plugins) {
    if (exclude.has(String(repo.full_name ?? "").toLowerCase())) continue;
    if (!isQuality(repo, { minStars })) continue;
    const seenAt = repo.registry_seen_at ? Date.parse(repo.registry_seen_at) : 0;
    const updated = repo.updated_at ? Date.parse(repo.updated_at) : 0;
    const base = seenAt || updated;
    if (!base || now.getTime() - base > window) continue;
    scored.push({ repo, score: (repo.stargazers_count ?? 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ repo, score }) => ({ repo, score, reasons: [`${labels.fresh ?? "新上架插件"}`] }));
}

/**
 * 每日精选：质量池 + 日期种子确定性轮换 + 分类配额。
 * 同一天结果稳定（哈希排序 + mulberry32），日期变化自动换批；
 * 每类最多 QUOTA_PER_CAT 个，保证当日精选覆盖不同分类。
 * @returns {Array<{ repo: object, category: string|null, reason: string }>}
 */
export function pickDaily(plugins, dateStr, { count = 8, minStars = 15, labels = {}, QUOTA_PER_CAT = 2 } = {}) {
  const pool = plugins.filter(
    (p) => isQuality(p, { minStars }) && p.category && p.category !== "other"
  );
  // 每仓库一个确定性轮换值：种子 = 日期种子 ⊕ 仓库哈希（mulberry32 雪崩扩散）。
  // 注意不能用 fnv1a(full_name + "|" + dateStr) 直接排序——相邻日期仅末位字符不同，
  // FNV 末步线性移位使全部哈希差恒为素数倍，排序顺序不变（轮换失效，单测捕获）。
  const ranked = pool
    .map((p) => ({ p, r: mulberry32(dateSeed(dateStr) ^ fnv1a(String(p.full_name)))() }))
    .sort((a, b) => a.r - b.r);
  const picks = [];
  const perCat = new Map();
  for (const { p } of ranked) {
    if (picks.length >= count) break;
    const cat = p.category ?? "other";
    const used = perCat.get(cat) ?? 0;
    if (used >= QUOTA_PER_CAT) continue;
    perCat.set(cat, used + 1);
    picks.push({ repo: p, category: cat, reason: dailyReason(p, labels) });
  }
  return picks;
}

/** 每日精选理由：分类名 + 质量来源（社区/验证/高星/近期更新）。 */
export function dailyReason(repo, labels = {}) {
  const parts = [];
  const cat = repo.category && repo.category !== "other" ? repo.category : null;
  parts.push(cat ? ((labels.category && labels.category[cat]) || cat) : (labels.other ?? "其他"));
  parts.push(...qualityReasons(repo, labels));
  return parts.join(" · ");
}

/** 质量来源理由（社区收录 / 人工验证 / 高星 / 近期更新活跃），可组合多条。 */
export function qualityReasons(repo, labels = {}, now = new Date()) {
  const reasons = [];
  const tags = Array.isArray(repo.market_tags) ? repo.market_tags : [];
  if (tags.includes("community-pick")) reasons.push(labels.community ?? "社区聚合页收录");
  if (tags.includes("verified-install")) reasons.push(labels.verified ?? "人工验证通过");
  else if ((repo.stargazers_count ?? 0) >= 100) reasons.push(labels.highStar ?? "高星社区精选");
  const updated = repo.updated_at ? Date.parse(repo.updated_at) : 0;
  if (updated && now.getTime() - updated < 30 * 86400e3) reasons.push(labels.recentUpdate ?? "近期更新活跃");
  return reasons.length > 0 ? reasons : [labels.normal ?? "社区精选"];
}
