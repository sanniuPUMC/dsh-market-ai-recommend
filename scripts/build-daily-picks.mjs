// 每日精选生成（CI 每天 04:00 UTC 全量重建后运行）：从 registry.json 质量池中
// 用日期种子确定性轮换挑选 8 个插件，写 daily-picks.json 提交回仓库。
// 与 lib/index.js 的 /api/marketplace/recommend 共用 lib/recommend.js 的 pickDaily——
// 同一天内 CDN 文件可用时前端用 CI 版本，不可用/过期时本地兜底算法结果一致。
// 用法：node scripts/build-daily-picks.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickDaily, todayStr } from "../lib/recommend.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "registry.json");
const OUT = join(ROOT, "daily-picks.json");

const LABELS = {
  category: { vision: "视觉多模态", document: "文档办公", memory: "记忆知识", model: "模型用量", notify: "通知通讯", coding: "开发编码", conversation: "对话聊天", "web-ui": "界面美化", agent: "Agent 自动化", tool: "通用工具", resource: "聚合资源", desktop: "桌面应用", media: "音视频", other: "其他" },
  community: "社区聚合页收录",
  verified: "人工验证通过",
  highStar: "高星社区精选",
  recentUpdate: "近期更新活跃",
  fresh: "新上架插件",
  normal: "社区精选"
};

try {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
  if (!registry || !Array.isArray(registry.repos) || registry.repos.length === 0) {
    console.error("registry.json 缺失或为空，跳过每日精选生成");
    process.exit(1);
  }
  const date = todayStr();
  const picks = pickDaily(registry.repos, date, { count: 8, minStars: 15, labels: LABELS })
    .map((p) => ({ full_name: p.repo.full_name, category: p.category ?? "other", reason: p.reason }));
  const out = {
    date,
    generated_at: new Date().toISOString(),
    count: picks.length,
    picks
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`daily-picks.json 已生成：${date}，${picks.length} 个精选`);
} catch (error) {
  console.error(`每日精选生成失败：${error?.message ?? error}`);
  process.exit(1);
}
