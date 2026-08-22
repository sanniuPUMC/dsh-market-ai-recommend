// AI 推荐引擎单元测试（lib/recommend.js）：
// 确定性（同输入同输出 / 日期轮换）、质量门槛（玩具仓库过滤）、
// 画像相似度（已安装分类/标签提升）、每日精选（分类配额 + 去重 + 理由生成）。
// 用法：node scripts/tests/unit/recommend.test.mjs

import {
  fnv1a, mulberry32, dateSeed, todayStr, isQuality, buildProfile, scoreGuess,
  recommendGuess, recommendTrending, recommendFresh, pickDaily, dailyReason, qualityReasons
} from "../../../lib/recommend.js";

const LABELS = {
  category: { coding: "开发编码", tool: "通用工具", vision: "视觉多模态", desktop: "桌面应用", media: "音视频" },
  community: "社区聚合页收录",
  verified: "人工验证通过",
  highStar: "高星社区精选",
  recentUpdate: "近期更新活跃",
  fresh: "新上架插件",
  normal: "社区精选",
  guessSameCat: "你已安装同类插件：",
  guessTopics: "与你的常用标签相关："
};

const mk = (fullName, opts = {}) => ({
  full_name: fullName,
  name: fullName.split("/")[1] ?? fullName,
  description: opts.description ?? "",
  stargazers_count: opts.stars ?? 0,
  updated_at: opts.updated_at ?? "2026-08-01T00:00:00Z",
  registry_seen_at: opts.seen_at,
  topics: opts.topics ?? [],
  category: opts.category ?? "other",
  market_tags: opts.market_tags ?? [],
  archived: opts.archived ?? false,
  installable: opts.installable
});

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- fnv1a / mulberry32 / dateSeed：确定性 ----
check("fnv1a 确定性", fnv1a("a/b"), fnv1a("a/b"));
check("fnv1a 不同输入不同输出", fnv1a("a/b") !== fnv1a("b/a"), true);
check("mulberry32 同种子同序列", [mulberry32(42)(), mulberry32(42)()], [mulberry32(42)(), mulberry32(42)()]);
check("mulberry32 不同种子不同序列", mulberry32(1)() !== mulberry32(2)(), true);
check("dateSeed 同日期稳定", dateSeed("2026-08-22"), dateSeed("2026-08-22"));
check("dateSeed 不同日期不同", dateSeed("2026-08-22") !== dateSeed("2026-08-23"), true);
check("todayStr 固定时间", todayStr(new Date("2026-08-22T12:34:56Z")), "2026-08-22");

// ---- isQuality：质量门槛 ----
check("0-star 玩具被过滤", isQuality(mk("toy/x", { stars: 0 })), false);
check("5-star 达标", isQuality(mk("ok/x", { stars: 5 })), true);
check("社区收录不受 star 门槛限制", isQuality(mk("toy/x", { stars: 0, market_tags: ["community-pick"] })), true);
check("人工验证不受 star 门槛限制", isQuality(mk("toy/x", { stars: 0, market_tags: ["verified-install"] })), true);
check("已归档排除", isQuality(mk("a/x", { stars: 50, archived: true })), false);
check("non-plugin 排除", isQuality(mk("a/x", { stars: 50, installable: "non-plugin" })), false);
check("minStars 参数生效", isQuality(mk("a/x", { stars: 14 }), { minStars: 15 }), false);

// ---- buildProfile / scoreGuess：画像相似度 ----
{
  const profile = buildProfile([
    mk("u/coding-a", { category: "coding", topics: ["typescript", "lsp"] }),
    mk("u/coding-b", { category: "coding", topics: ["lsp"] })
  ]);
  check("画像分类权重累计", profile.categories.get("coding"), 6);
  check("画像主题权重累计", profile.topics.get("lsp"), 2);
  check("画像总数", profile.total, 2);
  const hit = scoreGuess(mk("c/coding-x", { category: "coding", topics: ["lsp", "vscode"] }), profile);
  check("同分类命中得分 > 0", hit.score > 0, true);
  check("命中分类记录", hit.hitCategories, ["coding"]);
  check("命中主题记录", hit.hitTopics, ["lsp"]);
  const miss = scoreGuess(mk("d/vision-x", { category: "vision", topics: ["ocr"] }), profile);
  check("无重叠得分 0", miss.score, 0);
}

// ---- recommendGuess：排除已装 + 相似度排序 ----
{
  const plugins = [
    mk("u/coding-a", { category: "coding", topics: ["typescript"], stars: 10 }),
    mk("c/coding-x", { category: "coding", topics: ["typescript"], stars: 20 }),
    mk("d/vision-x", { category: "vision", topics: ["ocr"], stars: 999 }),
    mk("e/toy", { category: "coding", topics: ["typescript"], stars: 0 })
  ];
  const profile = buildProfile([plugins[0]]);
  const out = recommendGuess(plugins, profile, { excludeIds: ["u/coding-a"], limit: 6, labels: LABELS });
  check("猜你喜欢排除已装", out.every((x) => x.repo.full_name !== "u/coding-a"), true);
  check("猜你喜欢排除玩具仓库", out.every((x) => x.repo.full_name !== "e/toy"), true);
  check("猜你喜欢命中相似仓库", out[0].repo.full_name, "c/coding-x");
  check("猜你喜欢生成理由", out[0].reasons.length > 0, true);
  check("猜你喜欢理由含分类名", out[0].reasons[0].includes("开发编码"), true);
}

// ---- recommendTrending：星级与徽章 ----
{
  const now = new Date("2026-08-22T00:00:00Z");
  const plugins = [
    mk("a/low", { stars: 1, updated_at: "2026-01-01T00:00:00Z" }),
    mk("b/hot", { stars: 100, updated_at: "2026-08-21T00:00:00Z", market_tags: ["community-pick"] }),
    mk("c/mid", { stars: 50, updated_at: "2026-06-01T00:00:00Z" })
  ];
  const out = recommendTrending(plugins, { limit: 6, minStars: 1, now, labels: LABELS });
  check("热门趋势排序", out.map((x) => x.repo.full_name), ["b/hot", "c/mid", "a/low"]);
  check("热门趋势理由含社区收录", out[0].reasons.some((r) => r.includes("社区聚合页收录")), true);
}

// ---- recommendFresh：近期入库窗口 ----
{
  const now = new Date("2026-08-22T00:00:00Z");
  const plugins = [
    mk("a/old", { stars: 5, seen_at: "2026-01-01T00:00:00Z" }),
    mk("b/new", { stars: 5, seen_at: "2026-08-20T00:00:00Z" }),
    mk("c/newer", { stars: 3, seen_at: "2026-08-21T00:00:00Z" })
  ];
  const out = recommendFresh(plugins, { limit: 6, minStars: 1, days: 14, now, labels: LABELS });
  check("新上架只含窗口内", out.map((x) => x.repo.full_name).sort(), ["b/new", "c/newer"]);
  check("新上架按 star 排序", out[0].repo.full_name, "b/new");
}

// ---- pickDaily：确定性、轮换、分类配额 ----
{
  const dateA = "2026-08-22";
  const dateB = "2026-08-23";
  const plugins = [];
  for (let i = 0; i < 60; i++) {
    const cats = ["coding", "tool", "vision", "desktop", "media"];
    plugins.push(mk(`owner/p${i}`, { category: cats[i % cats.length], stars: 30 + (i % 20), topics: ["t" + i] }));
  }
  const a1 = pickDaily(plugins, dateA, { count: 8, minStars: 15, labels: LABELS });
  const a2 = pickDaily(plugins, dateA, { count: 8, minStars: 15, labels: LABELS });
  const b = pickDaily(plugins, dateB, { count: 8, minStars: 15, labels: LABELS });
  check("每日精选同日确定性", JSON.stringify(a1.map((p) => p.repo.full_name)), JSON.stringify(a2.map((p) => p.repo.full_name)));
  check("每日精选数量", a1.length, 8);
  check("每日精选无重复", new Set(a1.map((p) => p.repo.full_name)).size, a1.length);
  check("每日精选跨日轮换", JSON.stringify(a1.map((p) => p.repo.full_name)) !== JSON.stringify(b.map((p) => p.repo.full_name)), true);
  // 分类配额：60 仓库 5 类、每类 12 个、配额 2 → 8 个精选应覆盖 ≥4 类
  const cats = new Set(a1.map((p) => p.category));
  check("每日精选分类多样性 ≥4", cats.size >= 4, true);
  // 每类不超过配额 2
  const perCat = {};
  for (const p of a1) perCat[p.category] = (perCat[p.category] ?? 0) + 1;
  check("每日精选分类配额 ≤2", Object.values(perCat).every((n) => n <= 2), true);
  check("每日精选理由生成", a1[0].reason.length > 0, true);
  // 质量门槛：15 星以下的玩具不进精选
  const toyPool = [...plugins, mk("toy/junk", { category: "coding", stars: 1 })];
  const noToy = pickDaily(toyPool, dateA, { count: 8, minStars: 15, labels: LABELS });
  check("每日精选过滤玩具仓库", noToy.every((p) => p.repo.full_name !== "toy/junk"), true);
}

// ---- dailyReason / qualityReasons ----
{
  const now = new Date("2026-08-22T00:00:00Z");
  const r = qualityReasons(mk("a/x", { stars: 200, updated_at: "2026-08-20T00:00:00Z" }), LABELS, now);
  check("质量理由含高星", r.includes("高星社区精选"), true);
  check("质量理由含近期更新", r.includes("近期更新活跃"), true);
  const r2 = qualityReasons(mk("a/x", { stars: 1, market_tags: ["verified-install"] }), LABELS, now);
  check("质量理由含人工验证", r2.includes("人工验证通过"), true);
  const d = dailyReason(mk("a/x", { category: "coding", stars: 200 }), LABELS);
  check("每日理由含分类名", d.includes("开发编码"), true);
}

if (fail > 0) {
  console.error(`FAIL ${fail}/${pass + fail} 断言未通过`);
  process.exit(1);
}
console.log(`PASS 推荐引擎: ${pass}/${pass + fail} 断言通过`);
